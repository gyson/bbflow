package server

import (
	"context"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bbflow/internal/history"

	"bbflow/internal/protocol"
)

func stubInstalled(t *testing.T, installed map[string]bool, err error) {
	t.Helper()
	original := InstalledTools
	InstalledTools = func(context.Context, map[string]string) (map[string]bool, error) { return installed, err }
	t.Cleanup(func() { InstalledTools = original })
}

func TestStartTurnsOnInstalledBuiltinToolsOnce(t *testing.T) {
	s, _ := composerServer(t)
	stubInstalled(t, map[string]bool{"claude": true, "agy": true}, nil)
	if err := s.checkTools(context.Background()); err != nil {
		t.Fatal(err)
	}
	settings, err := s.store.Settings()
	if err != nil {
		t.Fatal(err)
	}
	on := []string{}
	for _, tool := range settings.Tools {
		if tool.Enabled {
			on = append(on, tool.Type)
		}
	}
	if strings.Join(on, ",") != "claude,agy" || settings.CheckTools || settings.Revision != 0 {
		t.Fatalf("on %v, check %v, revision %d", on, settings.CheckTools, settings.Revision)
	}
	// The check runs once. A later start keeps the choices of the user.
	settings.Tools[1].Enabled = false
	if _, err = s.store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	stubInstalled(t, map[string]bool{"claude": true}, nil)
	if err = s.checkTools(context.Background()); err != nil {
		t.Fatal(err)
	}
	if settings, _ = s.store.Settings(); settings.Tools[1].Enabled {
		t.Fatal("a second start turned the tool on again")
	}
}

func TestFailedToolCheckEndsWithAllBuiltinToolsOff(t *testing.T) {
	s, _ := composerServer(t)
	stubInstalled(t, nil, errors.New("no shell"))
	if err := s.checkTools(context.Background()); err != nil {
		t.Fatal(err)
	}
	settings, _ := s.store.Settings()
	for _, tool := range settings.Tools {
		if tool.Enabled || settings.CheckTools {
			t.Fatalf("a failed check turned on %q or stayed pending", tool.Name)
		}
	}
}

func TestToolsThatAreOffAreNoChoice(t *testing.T) {
	s, _ := composerServer(t)
	project, err := s.addProject("Off project", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	draft, err := s.prepareProject(context.Background(), project.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	request := &protocol.Request{Session: draft.ID, Preparation: &protocol.PreparationConfig{Revision: draft.Preparation.Revision, ToolID: "builtin-codex"}}
	if _, err = s.savePreparation(request); err == nil || !strings.Contains(err.Error(), "is off") {
		t.Fatal("a draft selected a tool that is off", err)
	}
	if _, _, err = s.continueTool("builtin-codex", "", ""); err == nil || !strings.Contains(err.Error(), "is off") {
		t.Fatal("a new terminal used a tool that is off", err)
	}
	// Shell that is off is no choice either.
	{
		settings, _ := s.store.Settings()
		settings.Tools = append(settings.Tools, history.Tool{ID: "script", Name: "Script", Command: "./script.sh"})
		settings.ShellOff, settings.DefaultTool = true, "script"
		if _, err = s.store.SaveSettings(settings); err != nil {
			t.Fatal(err)
		}
		if _, _, err = s.continueTool("", "", ""); err == nil || !strings.Contains(err.Error(), "Shell is off") {
			t.Fatal("a new terminal used Shell that is off", err)
		}
		shell := &protocol.Request{Session: draft.ID, Preparation: &protocol.PreparationConfig{Revision: draft.Preparation.Revision, ToolID: "script"}}
		moved, err := s.savePreparation(shell)
		if err != nil {
			t.Fatal(err)
		}
		shell.Preparation.ToolID, shell.Preparation.Revision = "", moved.Preparation.Revision
		if _, err = s.savePreparation(shell); err == nil || !strings.Contains(err.Error(), "Shell is off") {
			t.Fatal("a draft selected Shell that is off", err)
		}
		request.Preparation.Revision = moved.Preparation.Revision
		settings, _ = s.store.Settings()
		settings.ShellOff, settings.DefaultTool = false, ""
		if _, err = s.store.SaveSettings(settings); err != nil {
			t.Fatal(err)
		}
	}
	settings, _ := s.store.Settings()
	for i := range settings.Tools {
		settings.Tools[i].Enabled = settings.Tools[i].ID == "builtin-codex"
	}
	if _, err = s.store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	saved, err := s.savePreparation(request)
	if err != nil || saved.Preparation.ToolName != "Codex" || saved.Preparation.Command != "codex --no-alt-screen" {
		t.Fatal("the draft did not select the tool after it turned on", saved.Preparation, err)
	}
	// A draft keeps a tool that turns off after it was chosen.
	settings, _ = s.store.Settings()
	for i := range settings.Tools {
		settings.Tools[i].Enabled = false
	}
	if _, err = s.store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	request.Preparation.Revision = saved.Preparation.Revision
	if kept, err := s.savePreparation(request); err != nil || kept.Preparation.ToolID != "builtin-codex" {
		t.Fatal("the draft lost its tool", err)
	}
}

func TestBuiltinToolPathIsTheProgram(t *testing.T) {
	s, _ := composerServer(t)
	dir := t.TempDir()
	codex := filepath.Join(dir, "codex")
	if err := os.WriteFile(codex, []byte("#!/bin/sh\necho '{\"models\":[{\"slug\":\"gpt-test\",\"visibility\":\"list\",\"supported_reasoning_levels\":[]}]}'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	setPath := func(path string) error {
		settings, _ := s.store.Settings()
		for i := range settings.Tools {
			if settings.Tools[i].Type == "codex" {
				settings.Tools[i].Path = path
			}
		}
		_, err := s.store.SaveSettings(settings)
		return err
	}
	// Without a path, each type has its plain CLI name.
	if want := map[string]string{"codex": "codex", "claude": "claude", "agy": "agy", "code-puppy": "code-puppy"}; !maps.Equal(s.programs(), want) {
		t.Fatalf("programs %v", s.programs())
	}
	for _, invalid := range []string{"/a b/codex", "$HOME/codex", "codex; id"} {
		if err := setPath(invalid); err == nil {
			t.Fatalf("accepted the path %q", invalid)
		}
	}
	// Only a built-in tool has a path.
	settings, _ := s.store.Settings()
	settings.Tools = append(settings.Tools, history.Tool{ID: "mine", Name: "Mine", Command: "codex", Path: codex})
	if _, err := s.store.SaveSettings(settings); err == nil || !strings.Contains(err.Error(), "only a built-in tool") {
		t.Fatal("a tool of the user got a path", err)
	}
	if err := setPath(codex); err != nil {
		t.Fatal(err)
	}
	programs := s.programs()
	if programs["codex"] != codex || programs["claude"] != "claude" {
		t.Fatalf("programs %v", programs)
	}
	// The check finds a path of an executable file. The other names are not programs of
	// this test.
	programs["claude"], programs["agy"], programs["code-puppy"] = "bbflow-absent-claude", dir+"/absent", "bbflow-absent-puppy"
	installed, err := InstalledTools(context.Background(), programs)
	if err != nil || !maps.Equal(installed, map[string]bool{"codex": true}) {
		t.Fatalf("installed %v %v", installed, err)
	}
	// The model list and the title tool run the path.
	list, err := s.toolModels(context.Background(), "codex", false)
	if err != nil || list.Source != codex+" debug models" || list.Models[0].ID != "gpt-test" {
		t.Fatalf("model list %+v %v", list, err)
	}
	title, err := findTitleToolWith(history.TitleChoice{Tool: "codex", Model: "gpt-test"}, s.programs())
	if err != nil || !strings.HasPrefix(title.Command, codex+" exec --skip-git-repo-check ") || !strings.HasSuffix(title.Command, " --model gpt-test -") {
		t.Fatalf("title command %q %v", title.Command, err)
	}
	// A change of the path runs the list again with the new program.
	other := filepath.Join(t.TempDir(), "codex")
	if err = os.WriteFile(other, []byte("#!/bin/sh\necho '{\"models\":[{\"slug\":\"gpt-other\",\"visibility\":\"list\",\"supported_reasoning_levels\":[]}]}'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err = setPath(other); err != nil {
		t.Fatal(err)
	}
	if list, err = s.toolModels(context.Background(), "codex", false); err != nil || list.Source != other+" debug models" || list.Models[0].ID != "gpt-other" {
		t.Fatalf("model list after the change %+v %v", list, err)
	}
	// Sessions run the path too, with the fixed arguments of the type.
	settings, _ = s.store.Settings()
	for _, tool := range settings.Tools {
		if tool.Builtin && tool.Type == "codex" && tool.Command != other+" --no-alt-screen" {
			t.Fatalf("the command did not take the path: %q", tool.Command)
		}
	}
}
