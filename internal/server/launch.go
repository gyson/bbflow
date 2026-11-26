package server

import (
	"context"
	"errors"
	"path/filepath"
	"time"

	"bbflow/internal/history"
	"bbflow/internal/models"
	"bbflow/internal/protocol"
	agent "bbflow/internal/runtime"
)

// prepareProject creates a draft in a project. With parentID, it creates a sub-session
// draft in the family of that session, in the project of the family. Its default Git base
// is the current checkout of the managed worktree of the parent. See parentBase.
func (s *Server) prepareProject(ctx context.Context, projectID, parentID string) (history.Session, error) {
	s.launchMu.Lock()
	defer s.launchMu.Unlock()
	var parent history.Session
	if parentID != "" {
		var err error
		if parent, err = s.store.Session(parentID); err != nil {
			return history.Session{}, err
		}
		// A family has one level. A sub-session of a sub-session joins the same family.
		if parent.ParentID != "" {
			if parent, err = s.store.Session(parent.ParentID); err != nil {
				return history.Session{}, err
			}
		}
		if parent.ProjectID == "" {
			return history.Session{}, errors.New("this session has no project; add its project again before you add a sub-session")
		}
		projectID = parent.ProjectID
	}
	project, err := s.store.Project(projectID)
	if err != nil {
		return history.Session{}, err
	}
	settings, err := s.store.Settings()
	if err != nil {
		return history.Session{}, err
	}
	p := history.Preparation{ToolID: settings.DefaultTool, ToolName: "Shell", Base: settings.Base}
	for _, tool := range settings.Tools {
		if tool.ID == p.ToolID {
			p.ToolName, p.ToolType, p.Command = tool.Name, tool.Type, tool.Command
			p.Model, p.Effort, p.Permission, p.CodeMode = tool.Model, tool.Effort, tool.Permission, tool.CodeMode
		}
	}
	workspace, err := agent.Canonical(project.Workspace)
	if err != nil {
		return history.Session{}, err
	}
	p.Worktree = settings.Worktree && inspectRepository(ctx, workspace).Available
	if parent.ID == "" {
		return s.store.CreatePreparation("", workspace, project.ID, p)
	}
	if base := parentBase(ctx, parent.Worktree); base != "" {
		p.Base = base
	}
	return s.store.CreateSubPreparation(parent.ID, workspace, project.ID, p)
}

// parentBase returns the current branch of a managed worktree, or its commit when the
// checkout is detached. Thus a new worktree of a sub-session starts from the latest
// commit of its parent, also after the parent switched branches. When Git cannot read the
// checkout, for example after its removal, parentBase returns the branch that the
// worktree was created with. Without a worktree, it returns an empty string.
func parentBase(ctx context.Context, w *history.Worktree) string {
	if w == nil {
		return ""
	}
	if branch, err := git(ctx, w.Path, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil && branch != "" {
		return branch
	}
	if commit, err := git(ctx, w.Path, "rev-parse", "--verify", "HEAD"); err == nil && commit != "" {
		return commit
	}
	return w.Branch
}

func (s *Server) savePreparation(request *protocol.Request) (history.Session, error) {
	s.launchMu.Lock()
	defer s.launchMu.Unlock()
	if request.Preparation == nil {
		return history.Session{}, errors.New("missing launch settings")
	}
	session, err := s.store.Session(request.Session)
	if err != nil {
		return history.Session{}, err
	}
	if session.Preparation == nil || session.Preparation.State != "draft" {
		return history.Session{}, errors.New("session already started; reload the session")
	}
	p, edit := *session.Preparation, request.Preparation
	// A change of the tool copies its name, type, and command. The view sends the model,
	// the effort, the permission mode, and Code Mode, also the defaults of a newly
	// selected tool.
	if edit.ToolID != p.ToolID {
		p.ToolID, p.ToolName, p.ToolType, p.Command = edit.ToolID, "Shell", "", ""
		settings, err := s.store.Settings()
		if err != nil {
			return history.Session{}, err
		}
		if edit.ToolID == "" {
			if err = shellChoice(settings); err != nil {
				return history.Session{}, err
			}
		} else {
			tool, err := enabledTool(settings, edit.ToolID)
			if err != nil {
				return history.Session{}, err
			}
			p.ToolName, p.ToolType, p.Command = tool.Name, tool.Type, tool.Command
		}
	}
	p.Revision, p.Worktree, p.Base, p.Branch = edit.Revision, edit.Worktree, edit.Base, edit.Branch
	p.Model, p.Effort, p.Permission, p.CodeMode = edit.Model, edit.Effort, edit.Permission, edit.CodeMode
	return s.store.SavePreparation(session.ID, request.Name, p)
}

// Claim launch before filesystem or process changes. After a lost connection, only
// reattach. Reconnect and restart must not repeat a possibly delivered command.
func (s *Server) launchPrepared(ctx context.Context, id string, revision int64, size protocol.Size) (history.Session, *agent.Launch, error) {
	session, err := s.store.Session(id)
	if err != nil {
		return session, nil, err
	}
	p := session.Preparation
	if session.Archived {
		return session, nil, errors.New("restore this draft before starting it")
	}
	if p == nil || p.State != "draft" || p.Revision != revision {
		return session, nil, errors.New("session already started or launch settings changed; reload the session")
	}
	// A sub-session without a worktree starts in the current workspace of its parent. The
	// parent has its launch workspace only after its first terminal started. A launch that
	// stopped before that keeps the project folder as its workspace.
	workspace := session.Workspace
	if session.ParentID != "" && !p.Worktree {
		parent, err := s.store.Session(session.ParentID)
		if err != nil {
			return session, nil, err
		}
		if parent.Run == nil {
			return session, nil, errors.New("start the parent session first, or choose a new worktree")
		}
		workspace = parent.Workspace
	}
	command := models.Command(p.ToolType, p.Command, p.Model, p.Effort, p.Permission, p.CodeMode)
	run, err := prepareRun(&protocol.Run{Workspace: workspace, Title: session.Title, Command: command, Size: size})
	if err != nil {
		return session, nil, err
	}
	source, err := agent.Canonical(run.Workspace)
	if err != nil {
		return session, nil, err
	}
	run.Workspace = source
	if err = s.store.SetPreparationState(id, revision, "draft", "creating"); err != nil {
		return session, nil, err
	}
	if p.Worktree {
		var worktree history.Worktree
		run.Workspace, worktree, err = s.createWorktree(ctx, id, source, p.Base, p.Branch)
		if err != nil {
			// Return to preparation only if no checkout could have been created.
			current, readErr := s.store.Session(id)
			if readErr == nil && (current.Worktree == nil || current.Worktree.State == "removed") {
				err = errors.Join(err, s.store.SetPreparationState(id, revision, "creating", "draft"))
			} else {
				err = errors.Join(err, s.store.SetPreparationState(id, revision, "creating", "interrupted"))
			}
			return session, nil, err
		}
		session.Worktree = &worktree
	}
	// The workspace is known only now. A sub-session without its own worktree can start
	// in the managed worktree of its parent.
	run.Command = s.trustWorktree(p.ToolType, run.Command, run.Workspace)
	// Each launch records the derived title, also under a user title. A session from
	// before the upgrade has none, so it never gets an automatic title. The title names
	// the project folder, also for a sub-session in the workspace of its parent.
	autoTitle := p.ToolName + " · " + filepath.Base(source)
	if workspace != session.Workspace {
		autoTitle = p.ToolName + " · " + filepath.Base(session.Workspace)
	}
	if run.Title == "" {
		run.Title = autoTitle
	}
	run.Tool, run.ToolID = p.ToolName, p.ToolID
	if err = s.store.SetLaunchWorkspace(id, autoTitle, run.Workspace); err != nil {
		return session, nil, err
	}
	if err = s.store.SetPreparationState(id, revision, "creating", "launched"); err != nil {
		return session, nil, err
	}
	session.Workspace, session.AutoTitle = run.Workspace, autoTitle
	session.Preparation.State = "launched"
	return session, run, nil
}

// refreshPreparedBase fetches the remote-tracking base of a worktree draft. It runs
// before launchMu, so that a slow remote does not delay other launches. A fetch changes
// only the remote-tracking ref. launchPrepared still checks the draft and its revision.
// See refreshBase for the problem and the error.
func (s *Server) refreshPreparedBase(ctx context.Context, id string, revision int64) (string, error) {
	session, err := s.store.Session(id)
	if err != nil {
		return "", nil
	}
	p := session.Preparation
	if p == nil || !p.Worktree || p.State != "draft" || p.Revision != revision || session.Archived {
		return "", nil
	}
	return refreshBase(ctx, session.Workspace, p.Base)
}

// startKeepalive is the interval of running statuses before the session message. The
// browser closes a request with no reply after 12 seconds. A base fetch and a checkout
// can take longer. Tests make it shorter.
var startKeepalive = 5 * time.Second

// keepStarting sends a running status to the starting view at each interval until the
// returned function stops it. The function returns after the last send.
func keepStarting(conn *protocol.Conn) func() {
	done, finished := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(startKeepalive)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				conn.Send(protocol.Message{Type: "status", Status: "running"})
			}
		}
	}()
	return func() { close(done); <-finished }
}

func (s *Server) startPrepared(ctx context.Context, conn *protocol.Conn, request *protocol.Request) {
	stop := keepStarting(conn)
	problem, err := s.refreshPreparedBase(ctx, request.Session, request.Revision)
	if err != nil {
		stop()
		s.reply(conn, nil, err)
		return
	}
	s.launchMu.Lock()
	session, run, err := s.launchPrepared(ctx, request.Session, request.Revision, request.Size)
	var attach func()
	if err == nil {
		attach = s.sessionAttachment(ctx, conn, session, run, baseNotice(problem, session.Worktree))
	}
	s.launchMu.Unlock()
	// Stop the statuses outside launchMu. A slow view must not delay other launches.
	stop()
	if err != nil {
		s.reply(conn, nil, err)
		return
	}
	attach()
}
