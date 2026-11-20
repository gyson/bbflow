package server

import (
	"errors"
	"net"
	"strconv"
	"sync"
	"syscall"
)

// ListenLoopback listens on port at 127.0.0.1 and at ::1. A browser can resolve
// localhost to either address. When bbflow holds both, no other program can get the
// requests for localhost at this port. Port 0 selects a port that is free at both
// addresses. A system without IPv6 loopback gets a listener at 127.0.0.1 only. Addr
// returns the IPv4 address.
func ListenLoopback(port int) (net.Listener, error) {
	for attempt := 1; ; attempt++ {
		v4, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			return nil, err
		}
		bound := v4.Addr().(*net.TCPAddr).Port
		v6, err := net.Listen("tcp6", net.JoinHostPort("::1", strconv.Itoa(bound)))
		if err == nil {
			return newLoopback(v4, v6), nil
		}
		if errors.Is(err, syscall.EADDRNOTAVAIL) || errors.Is(err, syscall.EAFNOSUPPORT) {
			return v4, nil
		}
		v4.Close()
		// Another program can hold the IPv6 side of a free IPv4 port. Try another port.
		if port != 0 || attempt == 10 {
			return nil, err
		}
	}
}

// loopback merges the IPv4 and IPv6 listeners of one port.
type loopback struct {
	v4, v6 net.Listener
	conns  chan accepted
	done   chan struct{}
	once   sync.Once
}

type accepted struct {
	conn net.Conn
	err  error
}

func newLoopback(v4, v6 net.Listener) *loopback {
	l := &loopback{v4: v4, v6: v6, conns: make(chan accepted), done: make(chan struct{})}
	go l.accept(v4)
	go l.accept(v6)
	return l
}

func (l *loopback) accept(listener net.Listener) {
	for {
		conn, err := listener.Accept()
		select {
		case l.conns <- accepted{conn, err}:
		case <-l.done:
			if conn != nil {
				conn.Close()
			}
			return
		}
		if errors.Is(err, net.ErrClosed) {
			return
		}
	}
}

func (l *loopback) Accept() (net.Conn, error) {
	select {
	case next := <-l.conns:
		return next.conn, next.err
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *loopback) Close() error {
	err := net.ErrClosed
	l.once.Do(func() {
		close(l.done)
		err = errors.Join(l.v4.Close(), l.v6.Close())
	})
	return err
}

func (l *loopback) Addr() net.Addr { return l.v4.Addr() }
