package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"bbflow/internal/protocol"
	"github.com/gorilla/websocket"
)

// A slow session start sends running statuses before its session message.
func TestAwaitSessionSkipsRunningStatuses(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		conn := protocol.Wrap(socket)
		defer conn.Close()
		for _, message := range []protocol.Message{
			{Type: "status", Status: "running"},
			{Type: "status", Status: "running"},
			{Type: "session", Session: "one", Active: true},
			{Type: "error", Error: "fixture error"},
		} {
			conn.Send(message)
		}
		conn.Receive()
	}))
	t.Cleanup(server.Close)
	socket, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	conn := protocol.Wrap(socket)
	t.Cleanup(func() { conn.Close() })
	if message, err := awaitSession(conn); err != nil || message.Session != "one" {
		t.Fatal(message, err)
	}
	// Any other first reply is still an error.
	if _, err := awaitSession(conn); err == nil || !strings.Contains(err.Error(), "fixture error") {
		t.Fatal(err)
	}
}
