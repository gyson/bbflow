package server

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"bbflow/internal/history"
	"bbflow/internal/models"
)

// agentTypes are the tool types with a CLI, in the order of the built-in tools.
var agentTypes = []string{models.Codex, models.Claude, models.Agy, models.CodePuppy}

// toolPrograms returns the program of each agent type: the CLI path of its built-in
// tool, or the plain CLI name when the path is empty. The model lists, the check for
// installed CLIs, and the title tools run this program. A session runs the startup
// command of its tool.
func toolPrograms(settings history.Settings) map[string]string {
	programs := map[string]string{}
	for _, kind := range agentTypes {
		programs[kind] = kind
	}
	for _, tool := range settings.Tools {
		if tool.Builtin && tool.Path != "" {
			programs[tool.Type] = tool.Path
		}
	}
	return programs
}

// programs returns toolPrograms of the saved settings. Without readable settings, each
// type has its plain CLI name.
func (s *Server) programs() map[string]string {
	var settings history.Settings
	if s.store != nil {
		settings, _ = s.store.Settings()
	}
	return toolPrograms(settings)
}

// InstalledTools returns the agent types whose program the server shell finds: a name on
// PATH, or a path of an executable file. It finds only the CLI. It does not tell if the
// user is signed in. Tests replace it, so that the result does not depend on the
// computer.
var InstalledTools = func(ctx context.Context, programs map[string]string) (map[string]bool, error) {
	// The shell prints the type of each program that it finds. A program has no
	// character that the shell interprets, except a ~ at its start.
	var lines []string
	for _, kind := range agentTypes {
		lines = append(lines, fmt.Sprintf("command -v %s >/dev/null 2>&1 && echo %s", programs[kind], kind))
	}
	output, err := runCLI(ctx, strings.Join(lines, "\n")+"\nexit 0", "", 10*time.Second, 4<<10)
	if err != nil {
		return nil, err
	}
	installed := map[string]bool{}
	for _, line := range strings.Fields(output) {
		if models.Typed(line) {
			installed[line] = true
		}
	}
	return installed, nil
}

// checkTools runs the tool check of Settings.CheckTools before the server takes
// requests. It turns on the built-in tools whose CLI the server finds. A failed check turns on
// no tool and ends the check, so that each start does not wait for it again.
func (s *Server) checkTools(ctx context.Context) error {
	settings, err := s.store.Settings()
	if err != nil || !settings.CheckTools {
		return err
	}
	installed, err := InstalledTools(ctx, toolPrograms(settings))
	if err != nil {
		log.Printf("tool check: %v", err)
	}
	_, err = s.store.FinishToolCheck(func(kind string) bool { return installed[kind] })
	return err
}

// shellChoice checks that Shell is on, for a new draft choice or a new terminal.
func shellChoice(settings history.Settings) error {
	if settings.ShellOff {
		return errors.New("Shell is off; turn it on in Settings, or choose another tool")
	}
	return nil
}

// enabledTool returns the tool of Settings with the ID, for a new draft choice or a new
// terminal. A tool that is off is not a choice.
func enabledTool(settings history.Settings, id string) (history.Tool, error) {
	for _, tool := range settings.Tools {
		if tool.ID != id {
			continue
		}
		if !tool.Enabled {
			return tool, fmt.Errorf("%q is off; turn it on in Settings, or choose another tool", tool.Name)
		}
		return tool, nil
	}
	return history.Tool{}, fmt.Errorf("tool no longer exists; choose Shell or a tool from Settings")
}
