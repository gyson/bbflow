package server

import (
	"errors"
	"net"
	"strconv"
	"syscall"
	"testing"
)

// ipv6Loopback skips the test on a system without IPv6 loopback.
func ipv6Loopback(t *testing.T) {
	t.Helper()
	listener, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Skip("IPv6 loopback is unavailable:", err)
	}
	listener.Close()
}

// localhost can resolve to either loopback address. The listener must hold and serve
// both, so that no other program gets the requests for localhost.
func TestListenLoopbackHoldsBothAddresses(t *testing.T) {
	ipv6Loopback(t)
	listener, err := ListenLoopback(0)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
	if listener.Addr().String() != "127.0.0.1:"+port {
		t.Fatal("Addr must return the IPv4 address:", listener.Addr())
	}
	for _, network := range []string{"tcp4", "tcp6"} {
		host := map[string]string{"tcp4": "127.0.0.1", "tcp6": "::1"}[network]
		if other, err := net.Listen(network, net.JoinHostPort(host, port)); !errors.Is(err, syscall.EADDRINUSE) {
			if other != nil {
				other.Close()
			}
			t.Fatalf("another program can take %s at port %s: %v", host, port, err)
		}
		conn, err := net.Dial(network, net.JoinHostPort(host, port))
		if err != nil {
			t.Fatal(err)
		}
		accepted, err := listener.Accept()
		if err != nil {
			t.Fatal(err)
		}
		if got := accepted.LocalAddr().(*net.TCPAddr).IP.String(); got != host {
			t.Fatalf("accepted a connection at %s, expected %s", got, host)
		}
		accepted.Close()
		conn.Close()
	}
	if err = listener.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = listener.Accept(); !errors.Is(err, net.ErrClosed) {
		t.Fatal("Accept after Close:", err)
	}
}

func TestListenLoopbackRejectsAPortThatIsHeldOnIPv6(t *testing.T) {
	ipv6Loopback(t)
	holder, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	port := holder.Addr().(*net.TCPAddr).Port
	if listener, err := ListenLoopback(port); !errors.Is(err, syscall.EADDRINUSE) {
		if listener != nil {
			listener.Close()
		}
		t.Fatal("used a port that another program holds on IPv6:", err)
	}
	// The IPv4 side was released after the failure.
	listener, err := net.Listen("tcp4", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		t.Fatal("the failed listen kept the IPv4 port:", err)
	}
	listener.Close()
}
