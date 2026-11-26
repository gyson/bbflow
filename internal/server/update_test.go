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

// fakeReleases gives the offers of offers in order, and then the last one again. A nil
// offer reports the newest release. Check waits for gate when it is set, and it fails
// with checkFail. Update fails with fail, or returns ended.
type fakeReleases struct {
	mu        sync.Mutex
	offers    []*protocol.Update
	checks    int
	gate      chan struct{}
	checking  chan struct{} // Check sends on it before it waits for gate.
	checkFail error
	updates   []string
	fail      error
	ended     chan error
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
	if f.checkFail != nil {
		return nil, f.checkFail
	}
	if offer == nil {
		return nil, nil
	}
	fresh := *offer
	return &fresh, nil
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
		_, err := Serve(ctx, listener, store, "0.0.1", releases)
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

// state returns the release check state of the first statuses message that matches.
func (u *updateServer) state(reason string, match func(protocol.Release) bool) protocol.Release {
	u.t.Helper()
	for {
		u.watch.SetReadDeadline(time.Now().Add(5 * time.Second))
		message, err := u.watch.Receive()
		if err != nil {
			u.t.Fatalf("%s: %v", reason, err)
		}
		if message.Type == "statuses" && message.Release != nil && match(*message.Release) {
			return *message.Release
		}
	}
}

// next returns the offer of the first statuses message whose offer matches.
func (u *updateServer) next(reason string, match func(*protocol.Update) bool) *protocol.Update {
	u.t.Helper()
	return u.state(reason, func(r protocol.Release) bool { return match(r.Offer) }).Offer
}

func (u *updateServer) check() error {
	_, err := u.target.Call(protocol.Request{Operation: "update-check"})
	return err
}

func (u *updateServer) start(version string, revision int64) error {
	_, err := u.target.Call(protocol.Request{Operation: "update-start", Version: version, Revision: revision})
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
	releases := &fakeReleases{offers: []*protocol.Update{&offer002}}
	u := serveReleases(t, releases)
	offer := u.next("offer after start", func(o *protocol.Update) bool { return o != nil })
	if *offer != (protocol.Update{Revision: 1, Version: "0.0.1", Available: "0.0.2", State: "available"}) {
		t.Fatalf("offer: %+v", offer)
	}
	// A view can start only the offered release.
	if err := u.start("0.0.3", 1); err == nil || !strings.Contains(err.Error(), "not available now") {
		t.Fatal("started another release:", err)
	}
	releases.set(errors.New("download failed"), nil)
	if err := u.start("0.0.2", 1); err != nil {
		t.Fatal(err)
	}
	if failed := u.next("failed download", func(o *protocol.Update) bool { return o != nil && o.State == "failed" }); failed.Error != "download failed" {
		t.Fatalf("failed download: %+v", failed)
	}
	// The second attempt starts the updater. It shows as in progress until the updater
	// ends while this server still runs.
	ended := make(chan error, 1)
	releases.set(nil, ended)
	if err := u.start("0.0.2", 1); err != nil {
		t.Fatal(err)
	}
	u.next("update in progress", func(o *protocol.Update) bool { return o != nil && o.State == "updating" })
	if err := u.start("0.0.2", 1); err == nil || !strings.Contains(err.Error(), "already in progress") {
		t.Fatal("started a second update:", err)
	}
	// The off setting controls only the daily check. The offer stays.
	u.setCheck(false)
	ended <- errors.New("the restart failed")
	if failed := u.next("failed restart", func(o *protocol.Update) bool { return o == nil || o.State == "failed" }); failed == nil || failed.Error != "the restart failed" {
		t.Fatalf("offer after a failed restart: %+v", failed)
	}
	// The server checks only once a day.
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

// The views see a running check, its time, and its failure. A failed check keeps the
// offer of the last successful check.
func TestStatusShowsTheCheck(t *testing.T) {
	releases := &fakeReleases{offers: []*protocol.Update{nil, &offer002}, gate: make(chan struct{}), checking: make(chan struct{})}
	u := serveReleases(t, releases)
	<-releases.checking
	if running := u.state("running check", func(r protocol.Release) bool { return r.Checking }); running != (protocol.Release{Version: "0.0.1", CanUpdate: true, Checking: true}) {
		t.Fatalf("running check: %+v", running)
	}
	// Later checks do not wait.
	releases.mu.Lock()
	gate := releases.gate
	releases.gate = nil
	releases.mu.Unlock()
	close(gate)
	newest := u.state("newest release", func(r protocol.Release) bool { return !r.Checking })
	if newest.Offer != nil || newest.Error != "" {
		t.Fatalf("check without a newer release: %+v", newest)
	}
	if checked, err := time.Parse(time.RFC3339, newest.Checked); err != nil || time.Since(checked) > time.Minute {
		t.Fatalf("check time %q: %v", newest.Checked, err)
	}
	if err := u.check(); err != nil {
		t.Fatal(err)
	}
	u.next("offer of a requested check", func(o *protocol.Update) bool { return o != nil })
	releases.mu.Lock()
	releases.checkFail = errors.New("GitHub is down")
	releases.mu.Unlock()
	if err := u.check(); err != nil {
		t.Fatal(err)
	}
	failed := u.state("failed check", func(r protocol.Release) bool { return r.Error != "" })
	if failed.Error != "GitHub is down" || failed.Checking || failed.Offer == nil || failed.Offer.Available != "0.0.2" {
		t.Fatalf("failed check: %+v", failed)
	}
}

// A check request runs at once, also while the setting is off. A running check answers
// another request. The result shows, and a view can start its offer.
func TestCheckNowRunsWhileTheSettingIsOff(t *testing.T) {
	releases := &fakeReleases{offers: []*protocol.Update{nil, &offer002}, gate: make(chan struct{}), checking: make(chan struct{})}
	u := serveReleases(t, releases)
	<-releases.checking
	// A settings save applies at once, also while a slow check runs.
	u.setCheck(false)
	releases.gate <- struct{}{}
	u.state("first check", func(r protocol.Release) bool { return !r.Checking && r.Checked != "" })
	for range 2 {
		if err := u.check(); err != nil {
			t.Fatal(err)
		}
	}
	<-releases.checking
	if err := u.check(); err != nil {
		t.Fatal(err)
	}
	releases.gate <- struct{}{}
	state := u.state("offer while the setting is off", func(r protocol.Release) bool { return r.Offer != nil })
	if state.Checking || *state.Offer != (protocol.Update{Revision: 1, Version: "0.0.1", Available: "0.0.2", State: "available"}) {
		t.Fatalf("state after the check: %+v", state)
	}
	if releases.count() != 2 {
		t.Fatalf("the server checked %d times", releases.count())
	}
	releases.set(nil, make(chan error))
	if err := u.start("0.0.2", 1); err != nil {
		t.Fatal(err)
	}
	u.next("update in progress", func(o *protocol.Update) bool { return o != nil && o.State == "updating" })
}

// A view confirmed a restart, but the executable changed. The update changes nothing,
// and the server checks again at once for a new offer.
func TestStaleOfferChecksAgain(t *testing.T) {
	restart := protocol.Update{Version: "0.0.1", Available: "0.0.2", Installed: true}
	releases := &fakeReleases{offers: []*protocol.Update{&restart, &offer002}}
	u := serveReleases(t, releases)
	u.next("restart offer", func(o *protocol.Update) bool { return o != nil && o.Installed })
	releases.set(fmt.Errorf("%w: it has bbflow 0.0.1 now", ErrStaleOffer), nil)
	if err := u.start("0.0.2", 1); err != nil {
		t.Fatal(err)
	}
	offer := u.next("new offer", func(o *protocol.Update) bool { return o != nil && o.State == "available" && !o.Installed })
	if *offer != (protocol.Update{Revision: 2, Version: "0.0.1", Available: "0.0.2", State: "available"}) || releases.count() != 2 {
		t.Fatalf("offer after a stale restart: %+v after %d checks", offer, releases.count())
	}
	// Another view confirmed the restart before the new check. Its confirmation does
	// not start the download of the new offer.
	if err := u.start("0.0.2", 1); err == nil || !strings.Contains(err.Error(), "changed after you opened it") {
		t.Fatal("an earlier confirmation started the new offer:", err)
	}
	releases.set(nil, make(chan error))
	if err := u.start("0.0.2", 2); err != nil {
		t.Fatal(err)
	}
	u.next("update in progress", func(o *protocol.Update) bool { return o != nil && o.State == "updating" })
	releases.mu.Lock()
	defer releases.mu.Unlock()
	if len(releases.updates) != 2 {
		t.Fatalf("updates: %q", releases.updates)
	}
}

// A check with the same release and action keeps the revision, so an open dialog stays
// valid. Another release or another action gets a new revision.
func TestCheckKeepsTheRevisionOfTheSameOffer(t *testing.T) {
	u := updates{}
	revision := func(offer *protocol.Update) int64 {
		if offer != nil {
			fresh := *offer
			offer = &fresh
		}
		u.ended(offer, nil, time.Now())
		if u.offer == nil {
			return 0
		}
		return u.offer.Revision
	}
	restart := protocol.Update{Version: "0.0.1", Available: "0.0.2", Installed: true}
	newer := protocol.Update{Version: "0.0.1", Available: "0.0.3"}
	for i, want := range []struct {
		offer    *protocol.Update
		revision int64
	}{{&offer002, 1}, {&offer002, 1}, {&restart, 2}, {&newer, 3}, {nil, 0}, {&newer, 4}} {
		if got := revision(want.offer); got != want.revision {
			t.Fatalf("check %d: revision %d, want %d", i, got, want.revision)
		}
	}
}

func TestUpdateSettingKeepsTheNewestSave(t *testing.T) {
	u := updates{enabled: true, revision: 1, wake: make(chan struct{}, 1)}
	u.saved(history.Settings{Revision: 3, UpdateCheck: false})
	// The reply to an earlier save can come later. It does not apply.
	u.saved(history.Settings{Revision: 2, UpdateCheck: true})
	if start, enabled := u.next(time.Time{}); start || enabled {
		t.Fatal("an earlier save turned the check on again")
	}
}

// A development build shows its version, but it cannot check or update.
func TestDevelopmentBuildCannotUpdate(t *testing.T) {
	u := serveReleases(t, nil)
	if state := u.state("status", func(protocol.Release) bool { return true }); state != (protocol.Release{Version: "0.0.1"}) {
		t.Fatalf("release state: %+v", state)
	}
	if err := u.check(); err == nil || !strings.Contains(err.Error(), "cannot check") {
		t.Fatal("checked without releases:", err)
	}
	if err := u.start("0.0.2", 1); err == nil || !strings.Contains(err.Error(), "cannot update") {
		t.Fatal("started an update without releases:", err)
	}
}
