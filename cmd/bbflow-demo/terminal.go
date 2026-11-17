package main

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"bbflow/internal/client"
	"bbflow/internal/history"
	"bbflow/internal/protocol"
)

var size = protocol.Size{Rows: 30, Cols: 100}

const timeout = 30 * time.Second

// terminal is one view of a terminal stream, as a browser tab is. It acknowledges each
// frame, as the protocol requires.
type terminal struct {
	session  string
	conn     *protocol.Conn
	receipts chan protocol.Message
	exited   chan struct{}
	closed   chan struct{}
	inputs   int
}

// open sends a request that starts a terminal stream, then joins the stream.
func open(target client.Target, request protocol.Request) *terminal {
	request.Size = size
	conn, err := target.Connect(request)
	check(err)
	conn.SetReadDeadline(time.Now().Add(timeout))
	first, err := conn.Receive()
	if err == nil && first.Type != "session" {
		err = fmt.Errorf("unexpected reply %q %s", first.Type, first.Error)
	}
	if err != nil {
		conn.Close()
		fail("%s: %w", request.Operation, err)
	}
	conn.SetReadDeadline(time.Time{})
	t := &terminal{
		session:  first.Session,
		conn:     conn,
		receipts: make(chan protocol.Message, 8),
		exited:   make(chan struct{}),
		closed:   make(chan struct{}),
	}
	framed := make(chan struct{})
	go t.read(framed)
	go t.ping()
	// The server accepts input only after the first frame acknowledgment.
	select {
	case <-framed:
	case <-t.closed:
		fail("%s: the server closed the terminal stream", request.Operation)
	case <-time.After(timeout):
		t.close()
		fail("%s: no first frame in %s", request.Operation, timeout)
	}
	return t
}

func (t *terminal) read(framed chan struct{}) {
	defer close(t.closed)
	var first, exit sync.Once
	for {
		message, err := t.conn.Receive()
		if err != nil {
			return
		}
		switch message.Type {
		case "frame":
			t.conn.Send(protocol.Message{Type: "frame-ack", Revision: message.Revision})
			first.Do(func() { close(framed) })
		case "input-ack":
			t.receipts <- message
		case "exit":
			exit.Do(func() { close(t.exited) })
		}
	}
}

func (t *terminal) ping() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			t.conn.Send(protocol.Message{Type: "ping"})
		case <-t.closed:
			return
		}
	}
}

// input writes text to the terminal and waits for its receipt.
func (t *terminal) input(text string) {
	t.inputs++
	id := fmt.Sprintf("seed-%d", t.inputs)
	check(t.conn.Send(protocol.Message{Type: "input", ID: id, Data: []byte(text)}))
	select {
	case receipt := <-t.receipts:
		if receipt.ID != id || receipt.Error != "" {
			fail("input %q: receipt %q %s", text, receipt.ID, receipt.Error)
		}
	case <-t.closed:
		fail("input %q: the server closed the terminal stream", text)
	case <-time.After(timeout):
		fail("input %q: no receipt in %s", text, timeout)
	}
}

// wait waits until the process of the terminal ends.
func (t *terminal) wait() {
	select {
	case <-t.exited:
	case <-time.After(timeout):
		fail("session %s did not end in %s", t.session, timeout)
	}
}

// close leaves the view. The process continues.
func (t *terminal) close() {
	t.conn.Close()
	<-t.closed
}

// output waits until the recorded output of a session contains text count times. It
// reads the recording, because rendered frames repeat the text of a changed row.
func output(target client.Target, session, text string, count int) {
	sql := "SELECT CAST(data AS TEXT) FROM events WHERE session_id='" + strings.ReplaceAll(session, "'", "''") + "' AND kind='output' ORDER BY seq"
	for deadline := time.Now().Add(timeout); time.Now().Before(deadline); time.Sleep(150 * time.Millisecond) {
		var recorded strings.Builder
		for _, row := range call[history.QueryResult](target, protocol.Request{Operation: "query", SQL: sql}).Rows {
			if chunk, ok := row[0].(string); ok {
				recorded.WriteString(chunk)
			}
		}
		if strings.Count(recorded.String(), text) >= count {
			return
		}
	}
	fail("session %s did not print %q %d time(s) in %s", session, text, count, timeout)
}
