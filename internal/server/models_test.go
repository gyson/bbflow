package server

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bbflow/internal/history"
	"bbflow/internal/models"
	"bbflow/internal/protocol"
)

func TestDraftsTakeToolDefaultsAndLaunchWithTheChosenModel(t *testing.T) {
	s, _ := composerServer(t)
	project, err := s.addProject("Model project", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// The built-in Codex and Code Puppy tools have default models. Script is a tool of the
	// user.
	settings, err := s.store.Settings()
	if err != nil {
		t.Fatal(err)
	}
	for i := range settings.Tools {
		tool := &settings.Tools[i]
		tool.Enabled = true
		switch tool.Type {
		case models.Codex:
			tool.Model, tool.Effort = "gpt-6-luna", "medium"
		case models.CodePuppy:
			tool.Model = "codex-gpt-6-luna"
		}
	}
	settings.Tools = append(settings.Tools, history.Tool{ID: "script", Name: "Script", Command: "echo script"})
	settings.DefaultTool = "builtin-codex"
	if _, err = s.store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	draft, err := s.prepareProject(context.Background(), project.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	p := draft.Preparation
	if p.ToolType != models.Codex || p.Model != "gpt-6-luna" || p.Effort != "medium" || p.Command != "codex --no-alt-screen" {
		t.Fatalf("the draft did not copy the tool defaults: %+v", p)
	}
	save := func(tool, model, effort string) (history.Session, error) {
		current, err := s.store.Session(draft.ID)
		if err != nil {
			t.Fatal(err)
		}
		return s.savePreparation(&protocol.Request{Session: draft.ID, Preparation: &protocol.PreparationConfig{
			Revision: current.Preparation.Revision, ToolID: tool, Model: model, Effort: effort}})
	}
	// The draft keeps its choice. Settings keep the defaults.
	saved, err := save("builtin-codex", "gpt-6-sol", "high")
	if err != nil || saved.Preparation.Model != "gpt-6-sol" || saved.Preparation.Effort != "high" {
		t.Fatalf("the draft did not save its model: %+v %v", saved.Preparation, err)
	}
	for _, invalid := range [][3]string{{"builtin-codex", "gpt; id", ""}, {"builtin-code-puppy", "codex-gpt-6-luna", "high"}, {"script", "gpt-6-luna", ""}, {"", "gpt-6-luna", ""}} {
		if _, err = save(invalid[0], invalid[1], invalid[2]); err == nil {
			t.Fatalf("accepted %q", invalid)
		}
	}
	// A new tool brings its own type and command.
	saved, err = save("script", "", "")
	if err != nil || saved.Preparation.ToolType != models.Custom || saved.Preparation.Command != "echo script" {
		t.Fatalf("the tool change did not copy the type: %+v %v", saved.Preparation, err)
	}
	saved, err = save("builtin-codex", "gpt-6-sol", "high")
	if err != nil {
		t.Fatal(err)
	}
	_, run, err := s.launchPrepared(context.Background(), draft.ID, saved.Preparation.Revision, protocol.Size{Rows: 24, Cols: 80})
	if err != nil {
		t.Fatal(err)
	}
	if want := "codex --no-alt-screen --model gpt-6-sol -c model_reasoning_effort=high"; run.Command != want || run.Tool != "Codex" {
		t.Fatalf("launch command %q, tool %q; want %q", run.Command, run.Tool, want)
	}
	// A new terminal of an ended session launches with the model and the effort of the
	// view, as a draft does. The view sends the defaults of the tool, unless the user
	// changes them. An empty value selects the default of the CLI.
	for _, c := range []struct{ tool, model, effort, name, command string }{
		{"builtin-code-puppy", "codex-gpt-6-luna", "", "Code Puppy", "code-puppy --model codex-gpt-6-luna"},
		{"builtin-codex", "gpt-6-sol", "high", "Codex", "codex --no-alt-screen --model gpt-6-sol -c model_reasoning_effort=high"},
		{"builtin-codex", "", "", "Codex", "codex --no-alt-screen"},
		{"script", "", "", "Script", "echo script"},
		{"", "", "", "Shell", ""},
	} {
		name, command, err := s.continueTool(c.tool, c.model, c.effort, project.Workspace)
		if err != nil || name != c.name || command != c.command {
			t.Fatalf("continue %q %q %q: %q %q %v", c.tool, c.model, c.effort, name, command, err)
		}
	}
	// A new terminal rejects the same choices as a draft. Shell has no model or effort.
	for _, invalid := range [][3]string{{"builtin-codex", "gpt; id", ""}, {"builtin-code-puppy", "codex-gpt-6-luna", "high"}, {"script", "gpt-6-luna", ""}, {"", "gpt-6-luna", ""}, {"", "", "high"}} {
		if _, _, err = s.continueTool(invalid[0], invalid[1], invalid[2], project.Workspace); err == nil {
			t.Fatalf("a new terminal accepted %q", invalid)
		}
	}
}

func TestToolModelsRunsTheListCommandUntilARefresh(t *testing.T) {
	dir := t.TempDir()
	count := filepath.Join(dir, "count")
	script := filepath.Join(dir, "models")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho run >> '"+count+"'\necho 'Fetching available models...'\nprintf 'gemini-4-neon-high\\tGemini 4 Neon (High)\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	failing := filepath.Join(dir, "failing")
	if err := os.WriteFile(failing, []byte("#!/bin/sh\necho 'not signed in' >&2\nexit 3\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	commands := map[string]string{models.Agy: script, models.CodePuppy: failing}
	original := modelListCommand
	modelListCommand = func(kind, program string) string { return commands[kind] }
	t.Cleanup(func() { modelListCommand = original })
	s := &Server{}
	runs := func() int {
		data, _ := os.ReadFile(count)
		return strings.Count(string(data), "run")
	}
	for range 2 {
		list, err := s.toolModels(context.Background(), models.Agy, false)
		if err != nil || len(list.Models) != 1 || list.Models[0].ID != "gemini-4-neon" || list.Loaded == "" || list.Source != "agy models" {
			t.Fatalf("got %+v %v", list, err)
		}
	}
	if runs() != 1 {
		t.Fatalf("the list command ran %d times without a refresh", runs())
	}
	if _, err := s.toolModels(context.Background(), models.Agy, true); err != nil || runs() != 2 {
		t.Fatalf("a refresh did not run the command again: %d %v", runs(), err)
	}
	// A failed list saves nothing, so the next request tries again.
	for range 2 {
		if _, err := s.toolModels(context.Background(), models.CodePuppy, false); err == nil || !strings.Contains(err.Error(), "not signed in") {
			t.Fatalf("failure not reported: %v", err)
		}
	}
	// Claude Code has a built-in list, and a custom tool has no list.
	if list, err := s.toolModels(context.Background(), models.Claude, false); err != nil || len(list.Models) == 0 || list.Loaded != "" {
		t.Fatalf("got %+v %v", list, err)
	}
	if _, err := s.toolModels(context.Background(), models.Custom, false); err == nil {
		t.Fatal("a custom tool listed models")
	}
}
