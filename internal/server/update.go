package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"bbflow/internal/history"
	"bbflow/internal/protocol"
)

// The server reads the latest release when it starts, then after each interval. A
// restart reads it again.
const releaseInterval = 24 * time.Hour

// ErrStaleOffer reports that the executable changed after the check of the offer. Then
// the update changes nothing, and the server checks again for a new offer.
var ErrStaleOffer = errors.New("the executable changed after the release check")

// Releases reads and installs bbflow releases for the server. The executable supplies
// it, because it owns the release version and the installer.
type Releases interface {
	// Check returns the newest release that this server can use, without State. It
	// returns nil when the server runs that release already. It downloads no binaries.
	Check(ctx context.Context) (*protocol.Update, error)
	// Update does what the user confirmed for offer. It installs offer.Available when the
	// executable has an earlier version, and only restarts for an Installed offer. It
	// returns ErrStaleOffer when the executable no longer agrees with the offer. Then it
	// starts an updater process, which stops the server with this instance ID and
	// starts the new version. When the updater ends while this server runs, the channel
	// gets the reason.
	Update(ctx context.Context, offer protocol.Update, instance string) (<-chan error, error)
}

// updates holds the release check state of the server. The status watch sends it.
type updates struct {
	mu       sync.Mutex
	offer    *protocol.Update
	offers   int64 // The revision of the latest new offer.
	enabled  bool  // The update check setting. It controls only the daily check.
	revision int64 // The settings revision of enabled.
	recheck  bool  // Check at once, also while the setting is off.
	checking bool  // A check runs, or a requested check starts soon.
	checks   int64 // The checks that ended. Views tell two checks apart by it.
	checked  time.Time
	failure  string // The reason that the last check failed.
	// updateFailed tells why the last update failed. A new update removes it.
	updateFailed *protocol.UpdateFailure
	// held has the results of the checks that ended during an update. They apply in
	// order when the update fails, because the server then continues. Only the last
	// successful result and a later failed result can change the state, so held keeps
	// at most these two.
	held []checkResult
	// A settings save, a check request, or a stale offer wakes the check.
	wake chan struct{}
}

// checkResult is the result of one check.
type checkResult struct {
	offer *protocol.Update
	err   error
	at    time.Time
}

// load reads the update check setting when the server starts. Later saves apply
// through saved.
func (u *updates) load(store *history.Store) {
	u.revision, u.wake = -1, make(chan struct{}, 1)
	if settings, err := store.Settings(); err == nil {
		u.enabled, u.revision = settings.UpdateCheck, settings.Revision
	}
}

// current returns a copy of the check state that views show, without the version.
func (u *updates) current() protocol.Release {
	u.mu.Lock()
	defer u.mu.Unlock()
	release := protocol.Release{Checking: u.checking, Checks: u.checks, Error: u.failure}
	if !u.checked.IsZero() {
		release.Checked = u.checked.UTC().Format(time.RFC3339)
	}
	if u.offer != nil {
		offer := *u.offer
		release.Offer = &offer
	}
	if u.updateFailed != nil {
		failed := *u.updateFailed
		release.Failed = &failed
	}
	return release
}

// saved applies the update check setting of a settings save at once, also while a check
// runs. A later save can reply first, so only a newer revision applies.
func (u *updates) saved(settings history.Settings) {
	u.mu.Lock()
	if settings.Revision > u.revision {
		u.enabled, u.revision = settings.UpdateCheck, settings.Revision
	}
	u.mu.Unlock()
	u.notify()
}

func (u *updates) notify() {
	select {
	case u.wake <- struct{}{}:
	default:
	}
}

// request asks for a check at once, also while the setting is off. A running check
// answers the request. The check shows as running before the reply, so that the views
// see it.
func (u *updates) request() {
	u.mu.Lock()
	if !u.checking {
		u.recheck, u.checking = true, true
	}
	u.mu.Unlock()
	u.notify()
}

// next tells if a check starts now: on request, or while the setting is on after due.
// Then the check shows as running. enabled reports the setting.
func (u *updates) next(due time.Time) (start, enabled bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.recheck || u.enabled && !time.Now().Before(due) {
		u.recheck, u.checking = false, true
		return true, u.enabled
	}
	return false, u.enabled
}

// ended records the end of a check at the time at. During an update, it holds the
// result until the update fails.
func (u *updates) ended(offer *protocol.Update, err error, at time.Time) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.checking, u.checks = u.recheck, u.checks+1
	result := checkResult{offer: offer, err: err, at: at}
	if u.offer == nil || u.offer.State != "updating" {
		u.record(result)
		return
	}
	// A successful result replaces the earlier results. A failed result replaces only
	// a failed result after the last successful one.
	switch last := len(u.held) - 1; {
	case err == nil:
		u.held = []checkResult{result}
	case last >= 0 && u.held[last].err != nil:
		u.held[last] = result
	default:
		u.held = append(u.held, result)
	}
}

// record applies the result of a check. A failed check keeps the offer of the last
// successful check. A successful check replaces the offer. The same release and action
// keep their revision, so an open dialog stays valid. Another release or another action
// gets a new revision.
func (u *updates) record(result checkResult) {
	u.checked = result.at
	if result.err != nil {
		u.failure = result.err.Error()
		return
	}
	u.failure = ""
	offer := result.offer
	if offer != nil {
		if u.offer != nil && u.offer.Version == offer.Version && u.offer.Available == offer.Available && u.offer.Installed == offer.Installed {
			offer.Revision = u.offer.Revision
		} else {
			u.offers++
			offer.Revision = u.offers
		}
		offer.State = "available"
	}
	u.offer = offer
}

// start marks the offer with this version and revision as in progress and returns a
// copy of it. It removes the reason of an earlier failed update. Only one update runs at
// a time. A view cannot start an earlier offer that it confirmed before a new check.
func (u *updates) start(version string, revision int64) (protocol.Update, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	switch {
	case u.offer != nil && u.offer.State == "updating":
		return protocol.Update{}, fmt.Errorf("the update to bbflow %s is already in progress", u.offer.Available)
	case u.offer == nil || u.offer.Available != version:
		return protocol.Update{}, fmt.Errorf("bbflow %s is not available now; reload the page to see the current offer", version)
	case u.offer.Revision != revision:
		return protocol.Update{}, fmt.Errorf("the offer for bbflow %s changed after you opened it; open the update again and confirm the new offer", version)
	}
	u.offer.State, u.updateFailed = "updating", nil
	return *u.offer, nil
}

// failed records why the update to version failed. The reason stays with that version,
// also when a check changes the offer. The offer is available again, and the checks
// that ended during the update apply. A stale offer also asks for a new check, which
// replaces the offer.
func (u *updates) failed(version string, err error) {
	u.mu.Lock()
	if u.offer != nil && u.offer.Available == version {
		u.offer.State = "available"
	}
	for _, result := range u.held {
		u.record(result)
	}
	u.held = nil
	u.updateFailed = &protocol.UpdateFailure{Available: version, Error: err.Error()}
	stale := errors.Is(err, ErrStaleOffer)
	if stale {
		u.recheck, u.checking = true, true
	}
	u.mu.Unlock()
	if stale {
		u.notify()
	}
}

// checkReleases reads the latest release at start and then once a day while the update
// check setting is on. It reads nothing by itself while the setting is off. When the
// setting changes to on after the check is due, the check runs at once. A check request
// and a stale offer also start a check at once, also while the setting is off. Each
// check sets the next due time. A failed check keeps the earlier offer.
func (s *Server) checkReleases(ctx context.Context) {
	var due time.Time
	for {
		start, enabled := s.updates.next(due)
		if start {
			offer, err := s.releases.Check(ctx)
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				fmt.Fprintln(os.Stderr, "bbflow cannot check for a new release:", err)
			}
			s.updates.ended(offer, err, time.Now())
			due = time.Now().Add(releaseInterval)
			continue
		}
		var timer <-chan time.Time
		if enabled {
			timer = time.After(time.Until(due))
		}
		select {
		case <-ctx.Done():
			return
		case <-timer:
		case <-s.updates.wake:
		}
	}
}

// release returns the release check state that views show.
func (s *Server) release() protocol.Release {
	release := s.updates.current()
	release.Version, release.CanUpdate = s.version, s.releases != nil
	return release
}

// checkNow starts a release check at once, also while the update check setting is off.
// The status watch shows the result.
func (s *Server) checkNow() error {
	if s.releases == nil {
		return errors.New("this bbflow build cannot check for a new release; install a release")
	}
	s.updates.request()
	return nil
}

// startUpdate installs the offered release in the background and restarts the server
// with it. The status watch shows the progress. A restart ends all live sessions.
func (s *Server) startUpdate(version string, revision int64) error {
	if s.releases == nil {
		return errors.New("this bbflow build cannot update; install a release")
	}
	offer, err := s.updates.start(version, revision)
	if err != nil {
		return err
	}
	s.jobs.Add(1)
	go func() {
		defer s.jobs.Done()
		ended, err := s.releases.Update(s.ctx, offer, s.info.Instance)
		if err != nil {
			s.updates.failed(version, err)
			return
		}
		// The updater stops this server when it succeeds. Do not wait for it in a job,
		// because shutdown waits for the jobs.
		go func() {
			err := <-ended
			if s.ctx.Err() == nil {
				s.updates.failed(version, err)
			}
		}()
	}()
	return nil
}
