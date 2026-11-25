package server

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"bbflow/internal/history"
	"bbflow/internal/protocol"
	agent "bbflow/internal/runtime"
	"bbflow/internal/terminal"
)

// The server owns the active session. Attachments are replaceable views. Their
// cancellation must never cancel the process or recording.
type runningSession struct {
	id        string
	controls  chan agent.Control
	cancel    context.CancelFunc
	done      chan struct{}
	mu        sync.Mutex
	clients   map[*attachment]struct{}
	sizeOwner *attachment // The PTY uses this view's size.
	controlMu sync.Mutex  // Orders accepted controls and size owner changes.
	terminal  *terminal.State
	revision  int64
	runID     string
	tool      string // The tool of the run. It does not change.
	toolID    string // The tool ID of the run, or empty for Shell. It does not change.
	ended     bool
	exit      protocol.Message
	activity  activity
	side      bool // A side terminal has no run, no recording, and no session status.
	// received runs after the PTY accepts an input that has an ID. It gets the input
	// bytes. It can be nil.
	received func(id string, data []byte)
	// quiet records that a recorded output is not session activity. It can be nil.
	quiet func(seq int64) error
	// classified is the sequence of the latest event that publish completed. The quiet
	// flags of the events up to it are final. See history.OutputBounds.
	classified int64
	shell      string // Identifies the shell of a side terminal.
}

type attachment struct {
	conn     *protocol.Conn
	messages chan protocol.Message // Carries reliable receipts only.
	changed  chan struct{}         // Combines render requests. Excludes PTY events.
	closed   chan struct{}
	once     sync.Once
	size     protocol.Size  // Stores the viewport. Only the size owner resizes the PTY.
	history  terminal.Cache // Keeps rendered rows for a narrower viewport. Requires the session lock.
	// shown describes the reports of the frame that the view acknowledged last. pending
	// describes the frame that the view did not acknowledge yet. buttons holds the
	// mouse buttons that the view pressed on a terminal cell. Only the goroutine of the
	// attachment uses them.
	shown, pending *terminal.Reports
	buttons        terminal.Buttons
	// endsGesture is true when the pending frame makes xterm.js stop the reports of a
	// mouse gesture: a full frame, or a frame with another mouse tracking mode.
	endsGesture bool
}

// report tells whether the input of this view is a focus report or a mouse report. The
// view marks its reports, because a paste can have the same bytes. The marked input
// must also be a report in a frame of the view. report uses these frames, not the
// current modes of the application, because the view makes its reports from the frame
// that it shows. It returns the bytes for the PTY, see terminal.Reports.Translate.
func (a *attachment) report(message protocol.Message) (data []byte, ok bool) {
	if message.Type != "input" || !message.Report {
		return nil, false
	}
	for _, frame := range []*terminal.Reports{a.shown, a.pending} {
		if frame == nil {
			continue
		}
		if data, ok := frame.Translate(message.Data, &a.buttons); ok {
			return data, true
		}
	}
	return nil, false
}

func (a *attachment) close() { a.once.Do(func() { close(a.closed); a.conn.Close() }) }
func (a *attachment) wake() {
	select {
	case a.changed <- struct{}{}:
	default:
	}
}

func (r *runningSession) subscribe(conn *protocol.Conn, size protocol.Size) *attachment {
	r.mu.Lock()
	defer r.mu.Unlock()
	a := &attachment{conn: conn, messages: make(chan protocol.Message, 16), changed: make(chan struct{}, 1), closed: make(chan struct{}), size: size}
	if r.clients == nil {
		r.clients = make(map[*attachment]struct{})
	}
	r.clients[a] = struct{}{}
	if r.sizeOwner == nil && !r.ended {
		r.sizeOwner = a
	}
	a.wake()
	return a
}

// frameSize returns the size of the next frame of a view. previous is the last frame of
// the view. A view gets frames of its own size. A resize of the size owner reaches the
// emulator later. Until then, the size owner gets frames of the emulator size, not a crop
// of the screen at its new size. Thus one resize gives the view one full frame. A view
// that shows its own size keeps it, for example a view that took the size with input.
// Requires r.mu.
func (r *runningSession) frameSize(a *attachment, previous *terminal.View) protocol.Size {
	if r.sizeOwner == a && previous != nil && previous.Size != a.size {
		return r.terminal.Size()
	}
	return a.size
}

func (r *runningSession) leave(a *attachment) {
	r.controlMu.Lock()
	defer r.controlMu.Unlock()
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.clients, a)
	if r.sizeOwner == a {
		r.sizeOwner = nil
	}
}
func (a *attachment) inputAck(id string, err error) {
	message := protocol.Message{Type: "input-ack", ID: id}
	if err != nil {
		message.Error = "Input delivery is uncertain: " + err.Error()
	}
	select {
	case <-a.closed:
	case a.messages <- message:
	default:
		a.close()
	}
}

// Every view can send input and signals. The PTY uses the size of the view that most
// recently sent user input: typed keys, a paste, or a message. A focus report or a mouse
// report is input that the user did not type. It reaches the PTY, but it does not change
// the size owner. Thus a mouse report can come from a view that shows other rows than
// the PTY has. The PTY gets the report with the terminal row of the cell that the view
// shows. When no view has the size, a view that sends its size takes it.
// Signals never change the size owner. Serialize accepted controls so that a size
// change always reaches the PTY before the input that caused it. Input receipts always
// go to the view that sent the input.
func (r *runningSession) control(a *attachment, message protocol.Message) {
	r.controlMu.Lock()
	defer r.controlMu.Unlock()
	r.mu.Lock()
	_, present := r.clients[a]
	if !present || r.ended {
		r.mu.Unlock()
		return
	}
	if message.Type == "resize" {
		a.size = message.Size
	}
	var controls []agent.Control
	translated, report := a.report(message)
	if report {
		message.Data = translated
	}
	// The runtime records a report as a quiet event. Only input that the server accepts as
	// a report is one.
	message.Report = report
	userInput := message.Type == "input" && !report
	if r.sizeOwner != a && (userInput || (message.Type == "resize" && r.sizeOwner == nil)) {
		r.sizeOwner = a
		if userInput {
			// The runtime ignores a resize to the current PTY size.
			controls = append(controls, agent.Control{Message: protocol.Message{Type: "resize", Size: a.size}})
		}
	}
	// A report can have no bytes for the PTY, such as a click outside the terminal. A
	// requested receipt still tells the view that the server completed the input.
	ignored := report && len(message.Data) == 0
	if ignored && message.ID != "" {
		a.inputAck(message.ID, nil)
	}
	if (message.Type != "resize" || r.sizeOwner == a) && !ignored {
		control := agent.Control{Message: message}
		if message.Type == "input" && message.ID != "" {
			received := r.received
			control.Ack = func(err error) {
				a.inputAck(message.ID, err)
				if err == nil && received != nil {
					received(message.ID, message.Data)
				}
			}
		}
		controls = append(controls, control)
	}
	// A view without the size gets a crop or a padding of the screen at its new size at
	// once. The size owner gets the frame of its new size when the emulator applies the
	// resize. The runtime ignores a resize to the current size, so such a resize of the
	// size owner gets its frame at once. See frameSize.
	if message.Type == "resize" && (r.sizeOwner != a || message.Size == r.terminal.Size()) {
		r.revision++
		a.wake()
	}
	// The runtime ignores a resize to the current PTY size, so the application does not
	// redraw. Such a resize must not hide the application output that follows it.
	if len(controls) > 0 && (message.Type != "resize" || message.Size != r.terminal.Size()) {
		r.activity.viewAction(time.Now())
	}
	r.mu.Unlock()
	for _, control := range controls {
		select {
		case r.controls <- control:
		case <-r.done:
			return
		case <-a.closed:
			return
		}
	}
}

// publish gives a recorded event to the emulator and wakes the views. Output of a
// session is application activity when it changes what a view shows after the echo
// window of a view action. publish marks other output as quiet in the archive.
func (r *runningSession) publish(event history.Event) ([]byte, error) {
	responses, quiet, err := r.apply(event)
	if err == nil && quiet && r.quiet != nil {
		err = r.quiet(event.Seq)
	}
	if err == nil {
		r.mu.Lock()
		r.classified = event.Seq
		r.mu.Unlock()
	}
	return responses, err
}

func (r *runningSession) apply(event history.Event) (responses []byte, quiet bool, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.terminal == nil {
		r.terminal = terminal.New(protocol.Size{Cols: 80, Rows: 24})
	}
	now := time.Now()
	switch {
	case event.Kind != "output" || r.side:
		responses, err = r.terminal.Apply(event)
	case !r.activity.afterEcho(now):
		// The echo of typed input or the redraw after a size change. A comparison would
		// not change the status.
		responses, err = r.terminal.Apply(event)
		quiet = true
	default:
		var changed bool
		responses, changed, err = r.terminal.ApplyChange(event)
		if changed {
			r.activity.applicationOutput(now)
		}
		quiet = !changed
	}
	if err != nil {
		return nil, false, err
	}
	r.runID = event.RunID
	r.revision++
	for client := range r.clients {
		client.wake()
	}
	return responses, quiet, nil
}

// finish ends the terminal. Each view gets the exit code, the recorded run status, and
// the run ID.
func (r *runningSession) finish(code int, status string, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ended = true
	r.sizeOwner = nil
	r.revision++
	r.exit = protocol.Message{Type: "exit", Code: code, Status: status, Run: r.runID}
	if err != nil {
		r.exit.Error = err.Error()
	}
	for client := range r.clients {
		client.wake()
	}
}

func (s *Server) sessionAttachment(ctx context.Context, conn *protocol.Conn, session history.Session, run *agent.Launch, notice string) func() {
	s.mu.Lock()
	runContext, cancel := context.WithCancel(ctx)
	r := &runningSession{id: session.ID, controls: make(chan agent.Control, 16), cancel: cancel, done: make(chan struct{}), terminal: terminal.New(run.Size), revision: 1, tool: run.Tool, toolID: run.ToolID, activity: activity{output: time.Now()}}
	r.received = func(id string, data []byte) { s.titleAfterReceipt(session.ID, id, data) }
	r.quiet = s.store.MarkQuiet
	s.sessions[session.ID] = r
	s.mu.Unlock()
	launch := func() {
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer cancel()
			code, err := agent.Run(runContext, s.store, session, *run, r.controls, r.publish)
			err = errors.Join(err, s.saveScreen(r))
			// A run that failed before its start event has no recorded status.
			status := ""
			if run, lookupErr := s.store.SessionRun(session.ID, r.run()); lookupErr == nil {
				status = run.Status
			}
			r.finish(code, status, err)
			s.mu.Lock()
			delete(s.sessions, session.ID)
			s.mu.Unlock()
			close(r.done)
		}()
	}
	return func() { s.attach(conn, r, run.Size, launch, notice) }
}

// Session launches always use the server environment and interactive shell.
func prepareRun(request *protocol.Run) (*agent.Launch, error) {
	if request == nil || !terminal.ValidSize(request.Size) {
		return nil, errors.New("invalid new session request")
	}
	run := agent.Launch{Run: *request}
	if err := history.ValidateCommand(run.Command); err != nil {
		return nil, err
	}
	workspace, err := expandWorkspace(run.Workspace)
	if err != nil {
		return nil, err
	}
	run.Workspace = workspace
	if run.Shell, run.Env, err = serverShell(); err != nil {
		return nil, err
	}
	return &run, nil
}

// serverShell resolves $SHELL, or /bin/sh when it is unset, and the environment of a
// new terminal.
func serverShell() (string, []string, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	if !filepath.IsAbs(shell) && filepath.Base(shell) != shell {
		return "", nil, errors.New("SHELL must be an absolute path or a name on the server PATH")
	}
	path, err := exec.LookPath(shell)
	if err != nil {
		return "", nil, err
	}
	shell, err = filepath.Abs(path)
	if err != nil {
		return "", nil, err
	}
	return shell, append(os.Environ(), "TERM=xterm-256color"), nil
}

// run returns the ID of the run, or an empty string before its process starts.
func (r *runningSession) run() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.runID
}

func (s *Server) running(id string) *runningSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessions[id]
}

// resumeSession shows the latest terminal of a session, or the earlier terminal of
// runID. A view joins a live terminal. Other terminals show their saved final screen. A
// view of an earlier terminal never attaches to the live process, and the process
// continues.
func (s *Server) resumeSession(conn *protocol.Conn, id, runID string, size protocol.Size) {
	if !terminal.ValidSize(size) {
		s.reply(conn, nil, errors.New("terminal size must be 2–512 columns and 1–256 rows"))
		return
	}
	if r := s.running(id); r != nil && (runID == "" || runID == r.run()) {
		s.attach(conn, r, size, nil, "")
		return
	}
	session, err := s.store.Session(id)
	if err != nil {
		s.reply(conn, nil, err)
		return
	}
	run := session.Run
	if runID != "" {
		earlier, err := s.store.SessionRun(id, runID)
		if err != nil {
			s.reply(conn, nil, err)
			return
		}
		run = &earlier
	}
	status := "ended"
	if run != nil {
		status, runID = run.Status, run.ID
	}
	if err = conn.Send(protocol.Message{Type: "session", Session: id, Status: status}); err != nil {
		return
	}
	view, err := s.loadScreen(id, runID)
	if err != nil {
		s.reply(conn, nil, err)
		return
	}
	data, _ := view.Render(nil)
	if err = conn.Send(protocol.Message{Type: "frame", Data: data, Size: view.Size, Revision: 1, Full: true}); err != nil {
		return
	}
	conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	for {
		ack, err := conn.Receive()
		if err != nil {
			return
		}
		if ack.Type == "ping" {
			conn.Send(protocol.Message{Type: "pong"})
			continue
		}
		if ack.Type != "frame-ack" || ack.Revision != 1 {
			s.reply(conn, nil, errors.New("expected frame acknowledgement"))
			return
		}
		conn.Send(protocol.Message{Type: "history-end"})
		return
	}
}

// Only one frame can be outstanding. Capture continues to update the emulator while the
// client renders. After acknowledgment, compare the latest state with the accepted
// baseline. A non-empty notice goes to this view in its session message.
func (s *Server) attach(conn *protocol.Conn, r *runningSession, size protocol.Size, launch func(), notice string) {
	a := r.subscribe(conn, size)
	if launch != nil {
		launch()
	}
	defer a.close()
	defer r.leave(a)
	if err := conn.Send(protocol.Message{Type: "session", Session: r.id, Active: true, Shell: r.shell, Notice: notice}); err != nil {
		return
	}
	// Each live view gets the session status now and after each change.
	status := ""
	sendStatus := func() error {
		if r.side {
			return nil
		}
		next := r.status(time.Now())
		if next == status || next == "ended" {
			return nil
		}
		status = next
		return conn.Send(protocol.Message{Type: "status", Status: status})
	}
	if sendStatus() != nil {
		return
	}
	if launch == nil {
		r.control(a, protocol.Message{Type: "resize", Size: size})
	}
	incoming := make(chan protocol.Message, 16)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		defer a.close()
		for {
			conn.SetReadDeadline(time.Now().Add(30 * time.Second))
			message, err := conn.Receive()
			if err != nil {
				return
			}
			select {
			case incoming <- message:
			case <-a.closed:
				return
			}
		}
	}()
	defer func() { a.close(); <-readerDone }()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	var previous *terminal.View
	var sent, acked int64
	var sentAt time.Time
	dirty := true
	// saved tells that the view got the saved screen of the ended terminal.
	saved := false
	for {
		if dirty && sent == acked && (previous == nil || time.Since(sentAt) >= 50*time.Millisecond) {
			r.mu.Lock()
			revision, ended, exit := r.revision, r.ended, r.exit
			var next *terminal.View
			switch {
			case saved:
			case revision != sent || previous == nil:
				next = r.terminal.ViewFor(r.frameSize(a, previous), &a.history)
			case ended && !r.side:
				// A view of another size shows a crop or a padding of the screen. Its last
				// frame is the saved screen, as a reload shows it.
				if screen := r.terminal.View(); screen.Size != previous.Size {
					screen.TrimHistory()
					next, revision, saved = screen, sent+1, true
				}
			}
			r.mu.Unlock()
			if next != nil {
				data, full := next.Render(previous)
				if err := conn.Send(protocol.Message{Type: "frame", Data: data, Size: next.Size, Revision: revision, Full: full}); err != nil {
					return
				}
				a.endsGesture = full || previous.Reports.Tracking != next.Reports.Tracking
				previous, sent, sentAt = next, revision, time.Now()
				a.pending = &next.Reports
			} else if ended {
				conn.Send(exit)
				return
			}
			dirty = false
		}
		select {
		case <-a.closed:
			return
		case <-a.changed:
			dirty = true
		case <-ticker.C:
			if sent != acked && time.Since(sentAt) > 30*time.Second {
				return
			}
			if sendStatus() != nil {
				return
			}
			// Combine output while a frame is outstanding. Render at most 20 times per second.
			if dirty && sent == acked {
				continue
			}
		case message := <-a.messages:
			if err := conn.Send(message); err != nil {
				return
			}
		case control := <-incoming:
			switch control.Type {
			case "frame-ack":
				if control.Revision != sent || sent == acked {
					s.reply(conn, nil, errors.New("unexpected frame acknowledgement"))
					return
				}
				acked = sent
				a.shown, a.pending = a.pending, nil
				// The view sent the reports of its gesture before this acknowledgment.
				if a.endsGesture {
					a.buttons = 0
				}
				dirty = true
			case "ping":
				if conn.Send(protocol.Message{Type: "pong"}) != nil {
					return
				}
			case "input", "resize", "signal":
				if acked == 0 {
					s.reply(conn, nil, errors.New("terminal is not ready for input"))
					return
				}
				if control.Type == "input" && len(control.ID) > 80 {
					return
				}
				if control.Type == "resize" && !terminal.ValidSize(control.Size) {
					s.reply(conn, nil, errors.New("terminal size must be 2–512 columns and 1–256 rows"))
					return
				}
				if control.Type == "signal" && syscall.Signal(control.Signal) != syscall.SIGINT {
					continue
				}
				r.control(a, control)
			default:
				s.reply(conn, nil, errors.New("unsupported terminal control"))
				return
			}
		}
	}
}

func (s *Server) listSessions(filter history.SessionFilter) (protocol.SessionPage, error) {
	filter, err := s.orderFilter(filter)
	if err != nil {
		return protocol.SessionPage{}, err
	}
	page, err := s.store.ListSessions(filter)
	if err != nil {
		return protocol.SessionPage{}, err
	}
	result := protocol.SessionPage{Sessions: make([]protocol.SessionInfo, 0, len(page.Sessions)), More: page.More}
	now := time.Now()
	for _, session := range page.Sessions {
		info := protocol.SessionInfo{ID: session.ID, ProjectID: session.ProjectID, ParentID: session.ParentID, Context: session.Context, Archived: session.Archived, Pinned: session.Pinned, Title: session.Title, AutoTitle: session.AutoTitle, Workspace: session.Workspace, Updated: session.Updated, Status: s.sessionStatus(session.Session, now), Preparation: session.Preparation, Worktree: session.Worktree}
		if session.Run != nil {
			info.RunStatus = session.Run.Status
		}
		if r := s.running(session.ID); r != nil {
			r.mu.Lock()
			info.Viewers = len(r.clients)
			r.mu.Unlock()
		}
		result.Sessions = append(result.Sessions, info)
	}
	return result, nil
}

// orderFilter adds the bounds of output with a final quiet flag to a session list filter.
// See history.OutputBounds. It reads the latest event first. A terminal that
// starts after that read records only later output, and a terminal leaves the sessions
// after its last publish. Thus the output up to that event of a session without an entry
// has a final flag.
func (s *Server) orderFilter(filter history.SessionFilter) (history.SessionFilter, error) {
	recorded, err := s.store.LastEvent()
	if err != nil {
		return filter, err
	}
	filter.Bounds = &history.OutputBounds{Recorded: recorded, Classified: s.classified()}
	return filter, nil
}

// classified returns the classified sequence of each live terminal that published an
// event. Before its first event, a terminal has no output, so it needs no entry.
func (s *Server) classified() map[string]int64 {
	s.mu.Lock()
	sessions := make([]*runningSession, 0, len(s.sessions))
	for _, r := range s.sessions {
		sessions = append(sessions, r)
	}
	s.mu.Unlock()
	classified := make(map[string]int64, len(sessions))
	for _, r := range sessions {
		r.mu.Lock()
		if r.classified > 0 {
			classified[r.id] = r.classified
		}
		r.mu.Unlock()
	}
	return classified
}

// archiveSession archives or restores a session. Archive of a top-level session also
// archives its sub-sessions. members are the sub-sessions that the user confirmed. Nil
// confirms none. See history.Store.SetSessionArchived for the rules.
func (s *Server) archiveSession(id string, archived bool, members []string) error {
	// Serialize archive changes with launch to prevent a race with a new PTY or worktree.
	s.launchMu.Lock()
	defer s.launchMu.Unlock()
	ids, err := s.store.SetSessionArchived(id, archived, func(id string) bool { return s.running(id) != nil }, members)
	if err != nil || !archived {
		return err
	}
	// An archived session keeps no side terminal.
	for _, id := range ids {
		if _, err = s.stopSide(id, ""); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) stopSession(id string) (any, error) {
	if r := s.running(id); r != nil {
		r.cancel()
		select {
		case <-r.done:
			return map[string]bool{"stopped": true}, nil
		case <-time.After(10 * time.Second):
			return nil, errors.New("session has not finished stopping")
		}
	}
	if _, err := s.store.Session(id); err != nil {
		return nil, err
	}
	return map[string]bool{"stopped": false}, nil
}
