package server

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"bbflow/internal/client"
	"bbflow/internal/history"
	"bbflow/internal/protocol"
)

// fakeReleases offers one release. Update fails with fail, or returns ended.
type fakeReleases struct {
	mu        sync.Mutex
	checks    int
	instances []string
	fail      error
	ended     chan error
}

func (f *fakeReleases) Check(context.Context) (*protocol.Update, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.checks++
	return &protocol.Update{Version: "0.0.1", Available: "0.0.2"}, nil
}

func (f *fakeReleases) Update(_ context.Context, version, instance string) (<-chan error, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.instances = append(f.instances, version+" "+instance)
	return f.ended, f.fail
}

func (f *fakeReleases) set(fail error, ended chan error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fail, f.ended = fail, ended
}

func TestServerOffersAndStartsUpdates(t *testing.T) {
	// Clients compare the canonical directory, and the macOS temporary folder is a symlink.
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store, err := history.Open(filepath.Join(directory, "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	releases := &fakeReleases{}
	ctx, cancel := context.WithCancel(context.Background())
	served := make(chan error, 1)
	go func() {
		_, err := Serve(ctx, listener, store, releases)
		served <- err
	}()
	t.Cleanup(func() {
		cancel()
		if err := <-served; err != nil {
			t.Error(err)
		}
		store.Close()
	})
	target := client.Target{Dir: directory}
	var info protocol.ServerInfo
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if info, err = target.Health(); err == nil {
			break
		} else if time.Now().After(deadline) {
			t.Fatal(err)
		}
	}
	watch, err := target.Connect(protocol.Request{Operation: "status-watch"})
	if err != nil {
		t.Fatal(err)
	}
	defer watch.Close()
	// next returns the offer of the first statuses message that matches.
	next := func(reason string, match func(*protocol.Update) bool) *protocol.Update {
		t.Helper()
		for {
			watch.SetReadDeadline(time.Now().Add(5 * time.Second))
			message, err := watch.Receive()
			if err != nil {
				t.Fatalf("%s: %v", reason, err)
			}
			if message.Type == "statuses" && match(message.Update) {
				return message.Update
			}
		}
	}
	start := func(version string) error {
		_, err := target.Call(protocol.Request{Operation: "update-start", Version: version})
		return err
	}
	setCheck := func(enabled bool) {
		t.Helper()
		result, err := target.Call(protocol.Request{Operation: "settings-get"})
		var settings history.Settings
		if err == nil {
			err = json.Unmarshal(result, &settings)
		}
		settings.UpdateCheck = enabled
		if err == nil {
			_, err = target.Call(protocol.Request{Operation: "settings-save", Settings: &settings})
		}
		if err != nil {
			t.Fatal(err)
		}
	}

	offer := next("offer after start", func(u *protocol.Update) bool { return u != nil })
	if *offer != (protocol.Update{Version: "0.0.1", Available: "0.0.2", State: "available"}) {
		t.Fatalf("offer: %+v", offer)
	}
	// A view can start only the offered release.
	if err = start("0.0.3"); err == nil || !strings.Contains(err.Error(), "not available now") {
		t.Fatal("started another release:", err)
	}
	releases.set(errors.New("download failed"), nil)
	if err = start("0.0.2"); err != nil {
		t.Fatal(err)
	}
	if failed := next("failed download", func(u *protocol.Update) bool { return u != nil && u.State == "failed" }); failed.Error != "download failed" {
		t.Fatalf("failed download: %+v", failed)
	}
	// The second attempt starts the updater. It shows as in progress until the updater
	// ends while this server still runs.
	ended := make(chan error, 1)
	releases.set(nil, ended)
	if err = start("0.0.2"); err != nil {
		t.Fatal(err)
	}
	next("update in progress", func(u *protocol.Update) bool { return u != nil && u.State == "updating" })
	if err = start("0.0.2"); err == nil || !strings.Contains(err.Error(), "already in progress") {
		t.Fatal("started a second update:", err)
	}
	// An update in progress stays visible when the setting changes to off.
	setCheck(false)
	ended <- errors.New("the restart failed")
	if failed := next("failed restart", func(u *protocol.Update) bool { return u == nil || u.State == "failed" }); failed != nil {
		t.Fatalf("the off setting shows a failed update: %+v", failed)
	}
	// The setting shows the earlier result again. The server checks only once a day.
	setCheck(true)
	if failed := next("setting on", func(u *protocol.Update) bool { return u != nil }); failed.State != "failed" || failed.Error != "the restart failed" {
		t.Fatalf("offer after the setting changed: %+v", failed)
	}
	releases.mu.Lock()
	defer releases.mu.Unlock()
	if releases.checks != 1 {
		t.Fatalf("the server checked %d times", releases.checks)
	}
	want := []string{"0.0.2 " + info.Instance, "0.0.2 " + info.Instance}
	if strings.Join(releases.instances, ",") != strings.Join(want, ",") {
		t.Fatalf("updates: %q", releases.instances)
	}
}

func TestDevelopmentBuildCannotStartUpdate(t *testing.T) {
	if err := (&Server{}).startUpdate("0.0.2"); err == nil || !strings.Contains(err.Error(), "cannot update") {
		t.Fatal("started an update without releases:", err)
	}
}
