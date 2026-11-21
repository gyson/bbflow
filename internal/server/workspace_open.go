package server

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"bbflow/internal/protocol"
	agent "bbflow/internal/runtime"
)

// openTimeout limits the wait for the opener of the operating system.
const openTimeout = 10 * time.Second

// htmlFile reports a path with the .html or .htm extension, in any case.
func htmlFile(path string) bool {
	ext := filepath.Ext(path)
	return strings.EqualFold(ext, ".html") || strings.EqualFold(ext, ".htm")
}

// workspaceOpen opens a current HTML file of the session workspace with the default
// application of the user, normally the default browser. The browser loads it as a
// file: page. Such a page has an opaque origin, and the server rejects WebSocket
// connections from it. Thus a report that an agent wrote cannot control bbflow.
func (s *Server) workspaceOpen(ctx context.Context, id string, request *protocol.DiffRequest) error {
	if request == nil {
		return errors.New("missing diff request")
	}
	if !workspacePath(request.Path) {
		return errors.New("the file path must name a file in the session workspace")
	}
	if !htmlFile(request.Path) {
		return errors.New("only an HTML file can open in the browser")
	}
	session, err := s.store.Session(id)
	if err != nil {
		return err
	}
	workspace, err := agent.Canonical(session.Workspace)
	if err != nil {
		return fmt.Errorf("the session workspace is not available: %w", err)
	}
	// The operating system chooses the application from the file that it finds. A
	// symbolic link with an HTML name can lead to a script or an application. Thus no
	// part of the path can be a symbolic link.
	path := filepath.Join(workspace, request.Path)
	resolved, err := filepath.EvalSymlinks(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return errors.New("the file is not in the session workspace now")
	case err != nil:
		return err
	case resolved != path:
		return errors.New("the path goes through a symbolic link")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("the path is not a regular file")
	}
	if s.open == nil {
		return errors.New("this server cannot open files")
	}
	ctx, cancel := context.WithTimeout(ctx, openTimeout)
	defer cancel()
	if err = s.open(ctx, path); err != nil {
		return fmt.Errorf("cannot open the file: %w", err)
	}
	return nil
}
