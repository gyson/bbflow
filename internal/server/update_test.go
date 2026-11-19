package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

// fakeReleases gives the offers of offers in order, and then the last one again. Check
// waits for gate when it is set. Update fails with fail, or returns ended.
type fakeReleases struct {
	mu       sync.Mutex
	offers   []protocol.Update
	checks   int
	gate     chan struct{}
	checking chan struct{} // Check sends on it before it waits for gate.
	updates  []string
	fail     error
	ended    chan error
}

func (f *fakeReleases) Check(context.Context) (*protocol.Update, error) {
	f.mu.Lock()
	gate, checking := f.gate, f.checking
	f.mu.Unlock()
	if gate != nil {
		checking <- struct{}{}
		<-gate
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	offer := f.offers[min(f.checks, len(f.offers)-1)]
	f.checks++
	return &offer, nil
}

func (f *fakeReleases) Update(_ context.Context, offer protocol.Update, instance string) (<-chan error, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.updates = append(f.updates, offer.Available+" "+offer.State+" "+instance)
	return f.ended, f.fail
}

func (f *fakeReleases) set(fail error, ended chan error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fail, f.ended = fail, ended
}

func (f *fakeReleases) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.checks
}

// updateServer runs an in-process server with releases and a status watch.
type updateServer struct {
	t      *testing.T
	target client.Target
	info   protocol.ServerInfo
	watch  *protocol.Conn
}

func serveReleases(t *testing.T, releases Releases) *updateServer {
	t.Helper()
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
	u := &updateServer{t: t, target: client.Target{Dir: directory}}
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if u.info, err = u.target.Health(); err == nil {
			break
		} else if time.Now().After(deadline) {
			t.Fatal(err)
		}
	}
	if u.watch, err = u.target.Connect(protocol.Request{Operation: "status-watch"}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { u.watch.Close() })
	return u
}

// next returns the offer of the first statuses message that matches.
func (u *updateServer) next(reason string, match func(*protocol.Update) bool) *protocol.Update {
	u.t.Helper()
	for {
		u.watch.SetReadDeadline(time.Now().Add(5 * time.Second))
		message, err := u.watch.Receive()
		if err != nil {
			u.t.Fatalf("%s: %v", reason, err)
		}
		if message.Type == "statuses" && match(message.Update) {
			return message.Update
		}
	}
}

func (u *updateServer) start(version string) error {
	_, err := u.target.Call(protocol.Request{Operation: "update-start", Version: version})
	return err
}

func (u *updateServer) setCheck(enabled bool) {
	u.t.Helper()
	result, err := u.target.Call(protocol.Request{Operation: "settings-get"})
	var settings history.Settings
	if err == nil {
		err = json.Unmarshal(result, &settings)
	}
	settings.UpdateCheck = enabled
	if err == nil {
		_, err = u.target.Call(protocol.Request{Operation: "settings-save", Settings: &settings})
	}
	if err != nil {
		u.t.Fatal(err)
	}
}

var offer002 = protocol.Update{Version: "0.0.1", Available: "0.0.2"}

func TestServerOffersAndStartsUpdates(t *testing.T) {
	releases := &fakeReleases{offers: []protocol.Update{offer002}}
	u := serveReleases(t, releases)
	offer := u.next("offer after start", func(o *protocol.Update) bool { return o != nil })
	if *offer != (protocol.Update{Version: "0.0.1", Available: "0.0.2", State: "available"}) {
		t.Fatalf("offer: %+v", offer)
	}
	// A view can start only the offered release.
	if err := u.start("0.0.3"); err == nil || !strings.Contains(err.Error(), "not available now") {
		t.Fatal("started another release:", err)
	}
	releases.set(errors.New("download failed"), nil)
	if err := u.start("0.0.2"); err != nil {
		t.Fatal(err)
	}
	if failed := u.next("failed download", func(o *protocol.Update) bool { return o != nil && o.State == "failed" }); failed.Error != "download failed" {
		t.Fatalf("failed download: %+v", failed)
	}
	// The second attempt starts the updater. It shows as in progress until the updater
	// ends while this server still runs.
	ended := make(chan error, 1)
	releases.set(nil, ended)
	if err := u.start("0.0.2"); err != nil {
		t.Fatal(err)
	}
	u.next("update in progress", func(o *protocol.Update) bool { return o != nil && o.State == "updating" })
	if err := u.start("0.0.2"); err == nil || !strings.Contains(err.Error(), "already in progress") {
		t.Fatal("started a second update:", err)
	}
	// An update in progress stays visible when the setting changes to off.
	u.setCheck(false)
	ended <- errors.New("the restart failed")
	if failed := u.next("failed restart", func(o *protocol.Update) bool { return o == nil || o.State == "failed" }); failed != nil {
		t.Fatalf("the off setting shows a failed update: %+v", failed)
	}
	// The off setting hides the offer, so a view cannot start it.
	if err := u.start("0.0.2"); err == nil || !strings.Contains(err.Error(), "release check is off") {
		t.Fatal("started a hidden offer:", err)
	}
	// The setting shows the earlier result again. The server checks only once a day.
	u.setCheck(true)
	if failed := u.next("setting on", func(o *protocol.Update) bool { return o != nil }); failed.State != "failed" || failed.Error != "the restart failed" {
		t.Fatalf("offer after the setting changed: %+v", failed)
	}
	if releases.count() != 1 {
		t.Fatalf("the server checked %d times", releases.count())
	}
	releases.mu.Lock()
	defer releases.mu.Unlock()
	want := []string{"0.0.2 updating " + u.info.Instance, "0.0.2 updating " + u.info.Instance}
	if strings.Join(releases.updates, ",") != strings.Join(want, ",") {
		t.Fatalf("updates: %q", releases.updates)
	}
}

// A settings save applies at once, also while a slow check runs. The result of that
// check then stays hidden, and a view cannot start it.
func TestOffSettingAppliesDuringCheck(t *testing.T) {
	releases := &fakeReleases{offers: []protocol.Update{offer002}, gate: make(chan struct{}), checking: make(chan struct{})}
	u := serveReleases(t, releases)
	<-releases.checking
	u.setCheck(false)
	close(releases.gate)
	if err := u.start("0.0.2"); err == nil || !strings.Contains(err.Error(), "release check is off") {
		t.Fatal("started the offer of a check that the setting turned off:", err)
	}
	// When the setting changes to on, the view shows the result of that check. The
	// server does not check again.
	u.setCheck(true)
	if offer := u.next("setting on", func(o *protocol.Update) bool { return o != nil }); offer.State != "available" {
		t.Fatalf("offer: %+v", offer)
	}
	if releases.count() != 1 {
		t.Fatalf("the server checked %d times", releases.count())
	}
}

// A view confirmed a restart, but the executable changed. The update changes nothing,
// and the server checks again at once for a new offer.
func TestStaleOfferChecksAgain(t *testing.T) {
	restart := protocol.Update{Version: "0.0.1", Available: "0.0.2", Installed: true}
	releases := &fakeReleases{offers: []protocol.Update{restart, offer002}}
	u := serveReleases(t, releases)
	u.next("restart offer", func(o *protocol.Update) bool { return o != nil && o.Installed })
	releases.set(fmt.Errorf("%w: it has bbflow 0.0.1 now", ErrStaleOffer), nil)
	if err := u.start("0.0.2"); err != nil {
		t.Fatal(err)
	}
	offer := u.next("new offer", func(o *protocol.Update) bool { return o != nil && o.State == "available" && !o.Installed })
	if *offer != (protocol.Update{Version: "0.0.1", Available: "0.0.2", State: "available"}) || releases.count() != 2 {
		t.Fatalf("offer after a stale restart: %+v after %d checks", offer, releases.count())
	}
}

func TestUpdateSettingKeepsTheNewestSave(t *testing.T) {
	u := updates{enabled: true, revision: 1, wake: make(chan struct{}, 1)}
	u.saved(history.Settings{Revision: 3, UpdateCheck: false})
	// The reply to an earlier save can come later. It does not apply.
	u.saved(history.Settings{Revision: 2, UpdateCheck: true})
	if enabled, _ := u.due(); enabled {
		t.Fatal("an earlier save turned the check on again")
	}
}

func TestDevelopmentBuildCannotStartUpdate(t *testing.T) {
	if err := (&Server{}).startUpdate("0.0.2"); err == nil || !strings.Contains(err.Error(), "cannot update") {
		t.Fatal("started an update without releases:", err)
	}
}
