package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"bbflow/internal/protocol"
)

// The server reads the latest release when it starts, then after each interval. A
// restart reads it again.
const releaseInterval = 24 * time.Hour

// Releases reads and installs bbflow releases for the server. The executable supplies
// it, because it owns the release version and the installer.
type Releases interface {
	// Check returns the newest release that this server can use, without State. It
	// returns nil when the server runs that release already. It downloads no binaries.
	Check(ctx context.Context) (*protocol.Update, error)
	// Update installs version when the executable has another version. Then it starts an
	// updater process, which stops the server with this instance ID and starts the new
	// version. When the updater ends while this server runs, the channel gets the reason.
	Update(ctx context.Context, version, instance string) (<-chan error, error)
}

// updates holds the release offer of the server. The status watch sends it.
type updates struct {
	mu      sync.Mutex
	offer   *protocol.Update
	enabled bool          // The update check setting.
	wake    chan struct{} // A settings save wakes the check.
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

func (u *updates) setEnabled(enabled bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.enabled = enabled
}

// checked replaces the offer with the result of a check. It keeps an update in progress.
func (u *updates) checked(offer *protocol.Update) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.offer != nil && u.offer.State == "updating" {
		return
	}
	if offer != nil {
		offer.State, offer.Error = "available", ""
	}
	u.offer = offer
}

// start marks the offer of version as in progress. Only one update runs at a time.
func (u *updates) start(version string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	switch {
	case u.offer == nil || u.offer.Available != version:
		return fmt.Errorf("bbflow %s is not available now; reload the page to see the current offer", version)
	case u.offer.State == "updating":
		return fmt.Errorf("the update to bbflow %s is already in progress", version)
	}
	u.offer.State, u.offer.Error = "updating", ""
	return nil
}

func (u *updates) failed(version string, err error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.offer != nil && u.offer.Available == version {
		u.offer.State, u.offer.Error = "failed", err.Error()
	}
}

// settingsChanged wakes the release check, so that a changed setting applies at once.
func (s *Server) settingsChanged() {
	select {
	case s.updates.wake <- struct{}{}:
	default:
	}
}

// checkReleases reads the latest release at start and then once a day while the update
// check setting is on. It reads nothing while the setting is off. When the setting
// changes to on after the check is due, the check runs at once.
func (s *Server) checkReleases(ctx context.Context) {
	var due time.Time
	for {
		settings, err := s.store.Settings()
		enabled := err == nil && settings.UpdateCheck
		s.updates.setEnabled(enabled)
		var next <-chan time.Time
		if enabled {
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
func (s *Server) startUpdate(version string) error {
	if s.releases == nil {
		return errors.New("this bbflow build cannot update; install a release")
	}
	if err := s.updates.start(version); err != nil {
		return err
	}
	s.jobs.Add(1)
	go func() {
		defer s.jobs.Done()
		ended, err := s.releases.Update(s.ctx, version, s.info.Instance)
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
