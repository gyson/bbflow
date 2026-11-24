package server

import (
	"context"
	"fmt"
	"sync"
	"time"

	"bbflow/internal/models"
	"bbflow/internal/protocol"
)

// A model list command reads a catalog, and Antigravity reads it from the network. The
// Codex catalog is close to 1 MB.
const (
	modelListTimeout = 30 * time.Second
	modelListOutput  = 4 << 20
)

// modelListCommand returns the list command of a tool type with a program. Tests replace
// it.
var modelListCommand = models.ListCommand

// modelLists keeps the last model list of each tool type until a refresh or a change of
// its program. Each type has its own lock, so a slow list does not delay the list of
// another type.
type modelLists struct {
	mu       sync.Mutex
	locks    map[string]*sync.Mutex
	lists    map[string]protocol.ToolModels
	programs map[string]string // The program that printed each list.
}

func (m *modelLists) lock(kind string) *sync.Mutex {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.locks == nil {
		m.locks, m.lists, m.programs = map[string]*sync.Mutex{}, map[string]protocol.ToolModels{}, map[string]string{}
	}
	if m.locks[kind] == nil {
		m.locks[kind] = &sync.Mutex{}
	}
	return m.locks[kind]
}

// toolModels returns the model list of a tool type. The first request, each refresh, and
// a request after a change of the program run the list command of the type. The program
// is the CLI path of the built-in tool of the type. See toolPrograms. A failed
// command saves no list, so the next request runs it again. A type without a list command
// returns its built-in list.
func (s *Server) toolModels(ctx context.Context, kind string, refresh bool) (protocol.ToolModels, error) {
	if !models.Typed(kind) {
		return protocol.ToolModels{}, fmt.Errorf("%s has no model list", models.Name(kind))
	}
	program := s.programs()[kind]
	command := modelListCommand(kind, program)
	if command == "" {
		return protocol.ToolModels{Catalog: models.Builtin(kind)}, nil
	}
	lock := s.models.lock(kind)
	lock.Lock()
	defer lock.Unlock()
	s.models.mu.Lock()
	list, found := s.models.lists[kind]
	found = found && s.models.programs[kind] == program
	s.models.mu.Unlock()
	if found && !refresh {
		return list, nil
	}
	output, err := runCLI(ctx, command, "", modelListTimeout, modelListOutput)
	if err != nil {
		return protocol.ToolModels{}, fmt.Errorf("%s did not list its models: %w", models.Name(kind), err)
	}
	catalog, err := models.Parse(kind, []byte(output))
	if err != nil {
		return protocol.ToolModels{}, fmt.Errorf("cannot read the output of %s: %w", command, err)
	}
	// The view shows the command with the program that ran.
	catalog.Source = models.ListCommand(kind, program)
	list = protocol.ToolModels{Catalog: catalog, Loaded: time.Now().UTC().Format(time.RFC3339)}
	s.models.mu.Lock()
	s.models.lists[kind], s.models.programs[kind] = list, program
	s.models.mu.Unlock()
	return list, nil
}
