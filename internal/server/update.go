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

// updates holds the release offer of the server. The status watch sends it.
type updates struct {
	mu       sync.Mutex
	offer    *protocol.Update
	offers   int64 // The revision of the latest new offer.
	enabled  bool  // The update check setting.
	revision int64 // The settings revision of enabled.
	recheck  bool  // The offer is stale, so check before the next due time.
	// A settings save or a stale offer wakes the check.
	wake chan struct{}
}

// load reads the update check setting when the server starts. Later saves apply
// through saved.
func (u *updates) load(store *history.Store) {
	u.revision, u.wake = -1, make(chan struct{}, 1)
	if settings, err := store.Settings(); err == nil {
		u.enabled, u.revision = settings.UpdateCheck, settings.Revision
	}
}

// current returns a copy of the offer that views show, or nil. An update in progress
// shows also when the setting is off.
func (u *updates) current() *protocol.Update {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.offer == nil || !u.enabled && u.offer.State != "updating" {
		return nil
	}
	offer := *u.offer
	return &offer
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

// due reports whether the check is on. It also reports and clears a request to check
// before the next due time.
func (u *updates) due() (enabled, recheck bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if !u.enabled {
		return false, false
	}
	recheck, u.recheck = u.recheck, false
	return true, recheck
}

// checked replaces the offer with the result of a check. It keeps an update in progress.
// The same release and action keep their revision, so an open dialog stays valid.
// Another release or another action gets a new revision.
func (u *updates) checked(offer *protocol.Update) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.offer != nil && u.offer.State == "updating" {
		return
	}
	if offer != nil {
		if u.offer != nil && u.offer.Version == offer.Version && u.offer.Available == offer.Available && u.offer.Installed == offer.Installed {
			offer.Revision = u.offer.Revision
		} else {
			u.offers++
			offer.Revision = u.offers
		}
		offer.State, offer.Error = "available", ""
	}
	u.offer = offer
}

// start marks the offer with this version and revision as in progress and returns a
// copy of it. Only one update runs at a time. A view cannot start an offer that the off
// setting hides, or an earlier offer that it confirmed before a new check.
func (u *updates) start(version string, revision int64) (protocol.Update, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	switch {
	case u.offer != nil && u.offer.State == "updating":
		return protocol.Update{}, fmt.Errorf("the update to bbflow %s is already in progress", u.offer.Available)
	case !u.enabled:
		return protocol.Update{}, errors.New("the release check is off; turn on Check for a new version every day in Settings to update")
	case u.offer == nil || u.offer.Available != version:
		return protocol.Update{}, fmt.Errorf("bbflow %s is not available now; reload the page to see the current offer", version)
	case u.offer.Revision != revision:
		return protocol.Update{}, fmt.Errorf("the offer for bbflow %s changed after you opened it; open the update again and confirm the new offer", version)
	}
	u.offer.State, u.offer.Error = "updating", ""
	return *u.offer, nil
}

// failed shows the reason on the offer of version. A stale offer also asks for a new
// check, which replaces the offer.
func (u *updates) failed(version string, err error) {
	u.mu.Lock()
	if u.offer != nil && u.offer.Available == version {
		u.offer.State, u.offer.Error = "failed", err.Error()
	}
	stale := errors.Is(err, ErrStaleOffer)
	u.recheck = u.recheck || stale
	u.mu.Unlock()
	if stale {
		u.notify()
	}
}

// checkReleases reads the latest release at start and then once a day while the update
// check setting is on. It reads nothing while the setting is off. When the setting
// changes to on after the check is due, the check runs at once. A stale offer also
// starts a check at once. A failed check keeps the earlier offer.
func (s *Server) checkReleases(ctx context.Context) {
	var due time.Time
	for {
		var next <-chan time.Time
		if enabled, recheck := s.updates.due(); enabled {
			if recheck {
				due = time.Time{}
			}
			if wait := time.Until(due); wait > 0 {
				next = time.After(wait)
			} else {
				offer, err := s.releases.Check(ctx)
				if err == nil {
					s.updates.checked(offer)
				} else if ctx.Err() == nil {
					fmt.Fprintln(os.Stderr, "bbflow cannot check for a new release:", err)
				}
				due = time.Now().Add(releaseInterval)
				continue
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-next:
		case <-s.updates.wake:
		}
	}
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
