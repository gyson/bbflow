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

// workspaceOpen opens a current HTML file of the session workspace in the default
// browser of the user. The browser loads it as a file: page. Such a page has an opaque
// origin, and the server rejects WebSocket connections from it. Thus a report that an
// agent wrote cannot control bbflow.
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
	// A symbolic link with an HTML name can lead to another file. The browser reads the
	// path again after this check. A change at that time changes only the page that the
	// browser shows, because the browser and not the file type selects the application.
	path, info, err := s.workspaceEntry(id, request.Path)
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

// workspaceReveal shows a current file of the session workspace in Finder. Finder
// selects the file and does not open it.
func (s *Server) workspaceReveal(ctx context.Context, id string, request *protocol.DiffRequest) error {
	if request == nil {
		return errors.New("missing diff request")
	}
	if !workspacePath(request.Path) {
		return errors.New("the file path must name a file in the session workspace")
	}
	path, _, err := s.workspaceEntry(id, request.Path)
	if err != nil {
		return err
	}
	if s.reveal == nil {
		return errors.New("this server cannot show files in Finder")
	}
	ctx, cancel := context.WithTimeout(ctx, openTimeout)
	defer cancel()
	if err = s.reveal(ctx, path); err != nil {
		return fmt.Errorf("cannot show the file in Finder: %w", err)
	}
	return nil
}

// workspaceEntry returns the absolute path of an entry of the session workspace. The
// caller checks the relative path with workspacePath first. No part of the path can be
// a symbolic link, so the path cannot lead out of the workspace.
func (s *Server) workspaceEntry(id, relative string) (string, fs.FileInfo, error) {
	session, err := s.store.Session(id)
	if err != nil {
		return "", nil, err
	}
	workspace, err := agent.Canonical(session.Workspace)
	if err != nil {
		return "", nil, fmt.Errorf("the session workspace is not available: %w", err)
	}
	path := filepath.Join(workspace, relative)
	resolved, err := filepath.EvalSymlinks(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "", nil, errors.New("the file is not in the session workspace now")
	case err != nil:
		return "", nil, err
	case resolved != path:
		return "", nil, errors.New("the path goes through a symbolic link")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return "", nil, err
	}
	return path, info, nil
}
