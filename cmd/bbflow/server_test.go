package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"bbflow/internal/client"
	"bbflow/internal/history"
	"bbflow/internal/instance"
	"bbflow/internal/protocol"
)

func TestServerMigratesArchiveBeforeServingAndRecovery(t *testing.T) {
	directory := t.TempDir()
	db, err := sql.Open("sqlite3", filepath.Join(directory, "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, name := range []string{"format-3.sql", "records.sql"} {
		fixture, err := os.ReadFile(filepath.Join("..", "..", "internal", "history", "testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(string(fixture)); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	startTestServer(t, directory)
	query := `SELECT
 (SELECT hex(data) FROM events WHERE seq=42),
 (SELECT text FROM events WHERE seq=43),
 (SELECT status FROM runs WHERE id='unfinished'),
 (SELECT count(*) FROM events WHERE kind='notice'),
 (SELECT count(*) FROM projects),
 (SELECT revision FROM settings WHERE id=1),
 (SELECT count(*) FROM preparations),
 (SELECT count(*) FROM worktrees),
 (SELECT count(*) FROM runs)`
	var first string
	for attempt := range 2 {
		output, err := testCommand("--dir", directory, "query", query).CombinedOutput()
		var result history.QueryResult
		if err != nil || json.Unmarshal(output, &result) != nil {
			t.Fatalf("query after upgrade: %s %v", output, err)
		}
		want := `[["68656C6C6F0D0300","café","interrupted",1,0,0,0,0,2]]`
		got, err := json.Marshal(result.Rows)
		if err != nil || string(got) != want {
			t.Fatalf("migration/recovery result: %s %v", got, err)
		}
		if attempt == 0 {
			first = string(output)
			if output, err = testCommand("--dir", directory, "server", "restart").CombinedOutput(); err != nil {
				t.Fatalf("restart upgraded server: %s %v", output, err)
			}
		} else if string(output) != first {
			t.Fatal("restart changed migrated data or repeated recovery")
		}
	}
}

func testCommand(args ...string) *exec.Cmd {
	executable, _ := os.Executable()
	cmd := exec.Command(executable, args...)
	cmd.Env = append(os.Environ(), "BBFLOW_TEST_CLI=1")
	return cmd
}

func startTestServer(t *testing.T, directory string) string {
	t.Helper()
	t.Setenv("BBFLOW_DIR", directory)
	t.Cleanup(func() {
		output, err := testCommand("--dir", directory, "server", "stop").CombinedOutput()
		if err != nil {
			t.Errorf("test server cleanup: %v: %s", err, output)
		}
	})
	output, err := testCommand("--dir", directory, "server", "start").CombinedOutput()
	if err != nil {
		log, _ := os.ReadFile(filepath.Join(directory, "server.log"))
		t.Fatalf("server startup: %v: %s\n%s", err, output, log)
	}
	info, err := (client.Target{Dir: directory}).Health()
	if err != nil {
		t.Fatal(err)
	}
	return strconv.Itoa(info.Port)
}

func TestServerLifecycleAndRestartStopsActiveRun(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "new-archive")
	startTestServer(t, directory)
	target := client.Target{Dir: directory}
	before, err := target.Health()
	if err != nil {
		t.Fatal(err)
	}
	// The launcher has already exited. The daemon must still answer requests.
	if output, err := testCommand("--dir", directory, "server", "start").CombinedOutput(); err != nil || !strings.Contains(string(output), "already running") {
		t.Fatalf("duplicate start: %s %v", output, err)
	}
	same, _ := target.Health()
	if same.Instance != before.Instance {
		t.Fatal("start replaced the running server")
	}
	executable, _ := os.Executable()
	c := launchAgent(t, t.TempDir(), "wait")
	waitFor(t, func() bool { return strings.Contains(c.text(), "READY") })
	store := archive(t, directory)
	listed, _ := store.ListSessions(history.SessionFilter{Limit: 100})
	sessions := listed.Sessions
	pid := sessions[0].Run.PID
	output, err := testCommand("--dir", directory, "server", "restart").CombinedOutput()
	if err != nil {
		t.Fatalf("restart: %v: %s", err, output)
	}
	c.wait(t, 137)
	after, err := target.Health()
	if err != nil || after.Instance == before.Instance || after.PID == before.PID {
		t.Fatalf("server not replaced: %+v %v", after, err)
	}
	if after.Port != before.Port {
		t.Fatalf("restart changed the port from %d to %d", before.Port, after.Port)
	}
	if after.Executable != executable {
		t.Fatalf("restart used %s, expected %s", after.Executable, executable)
	}
	if err = syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("agent survived restart: %v", err)
	}
	latest, _ := store.LatestRun(sessions[0].ID)
	if latest.Status != "stopped" {
		t.Fatalf("run not finalized: %+v", latest)
	}
	if output, err = testCommand("--dir", directory, "server", "stop").CombinedOutput(); err != nil {
		t.Fatalf("stop: %s %v", output, err)
	}
	if _, err = target.Health(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("server still listening: %v", err)
	}
	if output, err = testCommand("--dir", directory, "server", "stop").CombinedOutput(); err != nil {
		t.Fatalf("repeated stop: %s %v", output, err)
	}
}

// Open browser tabs keep their address only when the port stays the same. A held port
// must not block startup.
func TestServerReusesItsPortOrSavesANewOne(t *testing.T) {
	directory := t.TempDir()
	target := client.Target{Dir: directory}
	port := startTestServer(t, directory)
	stop := func() {
		t.Helper()
		if output, err := testCommand("--dir", directory, "server", "stop").CombinedOutput(); err != nil {
			t.Fatalf("stop: %s %v", output, err)
		}
	}
	start := func() string {
		t.Helper()
		if output, err := testCommand("--dir", directory, "server", "start").CombinedOutput(); err != nil {
			t.Fatalf("start: %s %v", output, err)
		}
		info, err := target.Health()
		if err != nil {
			t.Fatal(err)
		}
		return strconv.Itoa(info.Port)
	}
	stop()
	if got := start(); got != port {
		t.Fatalf("start used port %s, expected %s", got, port)
	}
	stop()
	holder, err := net.Listen("tcp4", "127.0.0.1:"+port)
	if err != nil {
		t.Fatal(err)
	}
	moved := start()
	if moved == port {
		t.Fatal("start used a held port")
	}
	if log, _ := os.ReadFile(filepath.Join(directory, "server.log")); !strings.Contains(string(log), "cannot use its earlier port "+port) {
		t.Fatalf("the log does not report the held port:\n%s", log)
	}
	stop()
	holder.Close()
	if got := start(); got != moved {
		t.Fatalf("start used port %s, expected the saved port %s", got, moved)
	}
}

// A port from Settings applies at the next start. When another program holds it, the
// server uses its earlier port, so open tabs keep their address. Settings keeps the port
// for the next start.
func TestServerUsesThePortFromSettings(t *testing.T) {
	directory := t.TempDir()
	target := client.Target{Dir: directory}
	first := startTestServer(t, directory)
	cli := func(args ...string) string {
		t.Helper()
		output, err := testCommand(append([]string{"--dir", directory}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %s %v", args, output, err)
		}
		return string(output)
	}
	port := func() string {
		t.Helper()
		info, err := target.Health()
		if err != nil {
			t.Fatal(err)
		}
		return strconv.Itoa(info.Port)
	}
	hold := func(port string) net.Listener {
		t.Helper()
		listener, err := net.Listen("tcp4", "127.0.0.1:"+port)
		if err != nil {
			t.Fatal(err)
		}
		return listener
	}
	free := func() string {
		t.Helper()
		listener := hold("0")
		defer listener.Close()
		return strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
	}
	logged := func(want string) {
		t.Helper()
		if log, _ := os.ReadFile(filepath.Join(directory, "server.log")); !strings.Contains(string(log), want) {
			t.Fatalf("the log does not contain %q:\n%s", want, log)
		}
	}

	// A save rejects a port that another program holds now. Browsers can resolve localhost
	// to ::1, so a port that another program holds only there is held too.
	held := free()
	holder := hold(held)
	if ipv6, err := net.Listen("tcp6", "[::1]:0"); err == nil {
		holder.Close()
		held = strconv.Itoa(ipv6.Addr().(*net.TCPAddr).Port)
		holder = ipv6
	}
	if output, err := testCommand("--dir", directory, "settings", "set", "port", held).CombinedOutput(); err == nil || !strings.Contains(string(output), "another program uses port "+held) {
		t.Fatalf("saved a held port: %s %v", output, err)
	}
	holder.Close()

	chosen := free()
	if output := cli("settings", "set", "port", chosen); !strings.Contains(output, "applies at the next server start") {
		t.Fatal(output)
	}
	if got := port(); got != first {
		t.Fatalf("the save moved the running server to port %s", got)
	}
	cli("server", "restart")
	if got := port(); got != chosen {
		t.Fatalf("restart used port %s, expected the port %s from Settings", got, chosen)
	}
	// The server holds the IPv6 side of its port too. A browser that resolves localhost
	// to ::1 reaches the server. A system without IPv6 loopback has no IPv6 side.
	other, err := net.Listen("tcp6", "[::1]:"+chosen)
	switch {
	case err == nil:
		other.Close()
		t.Fatal("another program can take the IPv6 side of the server port")
	case errors.Is(err, syscall.EADDRNOTAVAIL), errors.Is(err, syscall.EAFNOSUPPORT):
	case !errors.Is(err, syscall.EADDRINUSE):
		t.Fatal("unexpected IPv6 listen error:", err)
	default:
		ipv6 := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp6", "[::1]:"+chosen)
		}}}
		response, err := ipv6.Get("http://localhost:" + chosen + "/")
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatal("the home page through ::1 returned", response.Status)
		}
	}

	// The server keeps the earlier port when another program holds the new port.
	next := free()
	cli("settings", "set", "port", next)
	holder = hold(next)
	cli("server", "restart")
	if got := port(); got != chosen {
		t.Fatalf("restart used port %s, expected the earlier port %s", got, chosen)
	}
	logged("cannot use port " + next + " from Settings")
	holder.Close()
	cli("server", "restart")
	if got := port(); got != next {
		t.Fatalf("restart used port %s, expected the port %s from Settings", got, next)
	}

	// With no usable port, the server uses a free port. Settings keeps its port.
	cli("server", "stop")
	holder = hold(next)
	cli("server", "start")
	moved := port()
	if moved == next {
		t.Fatal("restart used a held port")
	}
	logged("uses the new port " + moved)
	if output := cli("settings", "get"); !strings.Contains(output, `"port": `+next) {
		t.Fatalf("the fallback changed Settings:\n%s", output)
	}
	holder.Close()

	// The automatic port keeps the last port.
	cli("settings", "set", "port", "0")
	cli("server", "restart")
	if got := port(); got != moved {
		t.Fatalf("restart used port %s, expected the last port %s", got, moved)
	}
}

func TestServerRefusesTamperedMetadata(t *testing.T) {
	directory, other := t.TempDir(), t.TempDir()
	startTestServer(t, directory)
	startTestServer(t, other)
	original, err := instance.Read(directory)
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := instance.Read(other)
	if err != nil {
		t.Fatal(err)
	}
	// Copy another live server's endpoint, even claiming the requested directory.
	foreign.DataDir = original.DataDir
	if err = instance.Publish(foreign); err != nil {
		t.Fatal(err)
	}
	defer instance.Publish(original)
	for _, action := range []string{"start", "stop", "restart"} {
		output, err := testCommand("--dir", directory, "server", action).CombinedOutput()
		if err == nil {
			t.Fatalf("%s accepted foreign server: %s", action, output)
		}
	}
	for _, contents := range []string{"{", ""} {
		if contents == "" {
			instance.Remove(directory)
		} else {
			if err = os.WriteFile(filepath.Join(directory, "server.json"), []byte(contents), 0600); err != nil {
				t.Fatal(err)
			}
		}
		for _, action := range []string{"start", "stop", "restart"} {
			if output, err := testCommand("--dir", directory, "server", action).CombinedOutput(); err == nil {
				t.Fatalf("%s accepted missing/broken metadata: %s", action, output)
			}
		}
	}
	if _, err = (client.Target{Dir: other}).Health(); err != nil {
		t.Fatalf("foreign server affected: %v", err)
	}
}

func TestStaleMetadataAndSymlinkDirectory(t *testing.T) {
	foreignDir := t.TempDir()
	startTestServer(t, foreignDir)
	foreign, err := instance.Read(foreignDir)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	foreign.DataDir, err = filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	if err = instance.Publish(foreign); err != nil {
		t.Fatal(err)
	}
	// When the archive lock is free, discard stale metadata. Another live server can use
	// the old port. Stop never contacts that server.
	if output, err := testCommand("--dir", directory, "server", "stop").CombinedOutput(); err != nil {
		t.Fatalf("stale stop: %s %v", output, err)
	}
	if err = instance.Publish(foreign); err != nil {
		t.Fatal(err)
	}
	startTestServer(t, directory)
	info, err := (client.Target{Dir: directory}).Health()
	if err != nil || info.Instance == foreign.Instance || info.Port == foreign.Port {
		t.Fatalf("stale start: %+v %v", info, err)
	}
	stat, err := os.Stat(filepath.Join(directory, "server.json"))
	if err != nil || stat.Mode().Perm() != 0600 {
		t.Fatalf("descriptor permissions: %v %v", stat, err)
	}
	link := filepath.Join(t.TempDir(), "instance-link")
	if err = os.Symlink(directory, link); err != nil {
		t.Fatal(err)
	}
	viaLink, err := (client.Target{Dir: link}).Health()
	if err != nil || viaLink.Instance != info.Instance {
		t.Fatalf("symlink lookup: %+v %v", viaLink, err)
	}
	if output, err := testCommand("--dir", link, "server", "start").CombinedOutput(); err != nil || !strings.Contains(string(output), "already running") {
		t.Fatalf("symlink start: %s %v", output, err)
	}
	// Simulate a crash without active agents. Startup must replace its stale file.
	if err = syscall.Kill(info.PID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	if err = waitServerRelease(client.Target{Dir: directory}); err != nil {
		t.Fatal(err)
	}
	if output, err := testCommand("--dir", directory, "server", "start").CombinedOutput(); err != nil {
		t.Fatalf("crash recovery: %s %v", output, err)
	}
	after, err := (client.Target{Dir: directory}).Health()
	if err != nil || after.Instance == info.Instance {
		t.Fatalf("crashed instance reused: %+v %v", after, err)
	}
	if _, err = (client.Target{Dir: foreignDir}).Health(); err != nil {
		t.Fatalf("foreign server affected: %v", err)
	}
}

func TestViewDisconnectLeavesSessionAndServerRunning(t *testing.T) {
	directory := t.TempDir()
	startTestServer(t, directory)
	c := launchAgent(t, t.TempDir(), "wait")
	waitFor(t, func() bool { return strings.Contains(c.text(), "READY") })
	store := archive(t, directory)
	listed, _ := store.ListSessions(history.SessionFilter{Limit: 100})
	sessions := listed.Sessions
	pid := sessions[0].Run.PID
	c.Close()
	if err := syscall.Kill(pid, 0); err != nil {
		t.Fatalf("agent died with client: %v", err)
	}
	waitFor(t, func() bool { return sessionInfos(t, 10)[0].Viewers == 0 })
	resumed := resumeView(t, sessions[0].ID)
	waitFor(t, func() bool { return strings.Contains(resumed.text(), "READY") })
	latest, _ := store.LatestRun(sessions[0].ID)
	if latest.PID != pid || latest.Status != "running" {
		t.Fatalf("resume replaced run: %+v", latest)
	}
	stopTestSession(t, sessions[0].ID)
	resumed.wait(t, 137)
	if _, err := (client.Target{Dir: directory}).Health(); err != nil {
		t.Fatalf("server exited with client: %v", err)
	}

}

func TestServerStopWaitsForDetachedSession(t *testing.T) {
	directory := t.TempDir()
	startTestServer(t, directory)
	c := launchAgent(t, t.TempDir(), "wait")
	waitFor(t, func() bool { return strings.Contains(c.text(), "READY") })
	store := archive(t, directory)
	listed, _ := store.ListSessions(history.SessionFilter{Limit: 100})
	sessions := listed.Sessions
	c.Close()
	if output, err := testCommand("--dir", directory, "server", "stop").CombinedOutput(); err != nil {
		t.Fatalf("stop: %s %v", output, err)
	}
	run, err := store.LatestRun(sessions[0].ID)
	if err != nil || run.Status != "stopped" {
		t.Fatalf("detached session not finalized: %+v %v", run, err)
	}
	if err := syscall.Kill(run.PID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("detached child survived server stop: %v", err)
	}
}

// A server holds its archive lock until it exits, but it closes its listener first.
// Start and stop must wait for that release. They must not report an unverified server.
func TestLifecycleWaitsForShuttingDownServer(t *testing.T) {
	for _, action := range []string{"start", "stop", "restart"} {
		t.Run(action, func(t *testing.T) {
			directory, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { testCommand("--dir", directory, "server", "stop").Run() })
			listener, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			port := listener.Addr().(*net.TCPAddr).Port
			listener.Close()
			unlock, err := lockServerFile(directory, "server.lock")
			if err != nil {
				t.Fatal(err)
			}
			closing := protocol.ServerInfo{Protocol: protocol.Version, Instance: "closing", PID: os.Getpid(), DataDir: directory, Port: port}
			if err = instance.Publish(closing); err != nil {
				t.Fatal(err)
			}
			released := time.Now().Add(500 * time.Millisecond)
			time.AfterFunc(time.Until(released), unlock)
			output, err := testCommand("--dir", directory, "server", action).CombinedOutput()
			if err != nil || time.Now().Before(released) {
				t.Fatalf("%s during shutdown: %s %v", action, output, err)
			}
			info, err := (client.Target{Dir: directory}).Health()
			if action == "stop" {
				if !strings.Contains(string(output), "Stopped bbflow") {
					t.Fatalf("stop output: %s", output)
				}
				return
			}
			if err != nil || info.Instance == closing.Instance {
				t.Fatalf("%s did not start a new server: %+v %v", action, info, err)
			}
		})
	}
}
