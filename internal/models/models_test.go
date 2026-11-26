package models

import (
	"reflect"
	"strings"
	"testing"
)

func TestCommand(t *testing.T) {
	for _, test := range []struct {
		kind, command, model, effort, permission, want string
	}{
		{Codex, "codex --no-alt-screen", "gpt-6-luna", "medium", "", "codex --no-alt-screen --model gpt-6-luna -c model_reasoning_effort=medium"},
		{Codex, "codex", "", "high", "", "codex -c model_reasoning_effort=high"},
		{Codex, "codex", "", "", "", "codex"},
		{Claude, "claude ", "opus", "high", "", "claude --model opus --effort high"},
		{Claude, "claude", "", "max", "", "claude --effort max"},
		{Agy, "agy", "gemini-4-neon", "high", "", "agy --model gemini-4-neon-high"},
		{Agy, "agy", "gemini-pro-orchestrator-neon", "", "", "agy --model gemini-pro-orchestrator-neon"},
		{CodePuppy, "code-puppy", "codex-gpt-6-luna", "", "", "code-puppy --model codex-gpt-6-luna"},
		{Custom, "./review.sh", "", "", "", "./review.sh"},
		{"", "", "", "", "", ""},
		// The permission options follow the model and effort options.
		{Codex, "codex --no-alt-screen", "gpt-6-luna", "high", "approve-for-me", "codex --no-alt-screen --model gpt-6-luna -c model_reasoning_effort=high --approve-for-me"},
		{Codex, "codex --no-alt-screen", "", "", "ask", "codex --no-alt-screen --sandbox workspace-write --ask-for-approval on-request -c approvals_reviewer=user"},
		{Codex, "codex", "", "", "read-only", "codex --sandbox read-only --ask-for-approval on-request -c approvals_reviewer=user"},
		{Codex, "codex", "", "", "full-access", "codex --sandbox danger-full-access --ask-for-approval never"},
		{Claude, "claude", "opus", "", "accept-edits", "claude --model opus --permission-mode acceptEdits"},
		{Claude, "claude", "", "", "manual", "claude --permission-mode manual"},
		{Claude, "claude", "", "", "dont-ask", "claude --permission-mode dontAsk"},
		{Claude, "claude", "", "", "bypass-permissions", "claude --permission-mode bypassPermissions"},
		{Agy, "agy", "gemini-4-neon", "high", "plan", "agy --model gemini-4-neon-high --mode plan"},
		{Agy, "agy", "", "", "skip-permissions", "agy --dangerously-skip-permissions"},
		{CodePuppy, "code-puppy", "", "", "yolo", "code-puppy --yolo true"},
		{CodePuppy, "code-puppy", "", "", "confirm", "code-puppy --yolo false"},
		// A mode of another type adds nothing. Validate rejects it before a launch.
		{Codex, "codex", "", "", "plan", "codex"},
		{Custom, "./review.sh", "", "", "yolo", "./review.sh"},
	} {
		if got := Command(test.kind, test.command, test.model, test.effort, test.permission, false); got != test.want {
			t.Errorf("Command(%q, %q, %q, %q, %q) = %q, want %q", test.kind, test.command, test.model, test.effort, test.permission, got, test.want)
		}
	}
}

func TestValidate(t *testing.T) {
	for _, test := range []struct {
		kind, model, effort, permission string
		ok                              bool
	}{
		{Codex, "gpt-6-luna", "medium", "", true},
		{Codex, "", "", "", true},
		{Claude, "claude-opus-5-5", "max", "", true},
		{Agy, "gemini-4-neon", "high", "", true},
		{Agy, "", "high", "", false},
		{CodePuppy, "codex-gpt-6-luna", "", "", true},
		{CodePuppy, "codex-gpt-6-luna", "low", "", false},
		{Custom, "", "", "", true},
		{Custom, "gpt-6-luna", "", "", false},
		{"", "", "", "", true},
		{"other", "", "", "", false},
		{Codex, "gpt; rm -rf ~", "", "", false},
		{Codex, "$(id)", "", "", false},
		{Codex, "gpt-6-luna", "High", "", false},
		{Codex, "-o", "", "", false},
		{Codex, "", "", "approve-for-me", true},
		{Codex, "gpt-6-luna", "high", "full-access", true},
		{Claude, "", "", "bypass-permissions", true},
		{Agy, "", "", "accept-edits", true},
		{CodePuppy, "", "", "yolo", true},
		// Each type accepts only its own modes, and Custom and Shell accept none.
		{Codex, "", "", "plan", false},
		{Claude, "", "", "approve-for-me", false},
		{Claude, "", "", "acceptEdits", false},
		{CodePuppy, "", "", "ask", false},
		{Custom, "", "", "approve-for-me", false},
		{"", "", "", "approve-for-me", false},
		{Codex, "", "", "ask; rm -rf ~", false},
	} {
		if err := Validate(test.kind, test.model, test.effort, test.permission, false); (err == nil) != test.ok {
			t.Errorf("Validate(%q, %q, %q, %q) = %v, want ok %v", test.kind, test.model, test.effort, test.permission, err, test.ok)
		}
	}
}

// Code Mode puts the environment variable before the command of Claude Code, also with
// a CLI path and the other options. Code Mode off adds nothing, and the other types get
// no variable.
func TestCodeModeCommand(t *testing.T) {
	for _, test := range []struct {
		kind, command, model, effort, permission string
		codeMode                                 bool
		want                                     string
	}{
		{Claude, "claude", "", "", "", true, "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude"},
		{Claude, "~/bin/claude", "opus", "high", "auto", true, "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 ~/bin/claude --model opus --effort high --permission-mode auto"},
		{Claude, "claude", "opus", "", "", false, "claude --model opus"},
		{Codex, "codex --no-alt-screen", "", "", "", true, "codex --no-alt-screen"},
		{Custom, "claude", "", "", "", true, "claude"},
	} {
		if got := Command(test.kind, test.command, test.model, test.effort, test.permission, test.codeMode); got != test.want {
			t.Errorf("Command(%q, %q, %q, %q, %q, %v) = %q, want %q", test.kind, test.command, test.model, test.effort, test.permission, test.codeMode, got, test.want)
		}
	}
}

// Only Claude Code accepts Code Mode.
func TestValidateCodeMode(t *testing.T) {
	for _, test := range []struct {
		kind string
		ok   bool
	}{
		{Claude, true}, {Codex, false}, {Agy, false}, {CodePuppy, false}, {Custom, false}, {"", false},
	} {
		if err := Validate(test.kind, "", "", "", true); (err == nil) != test.ok {
			t.Errorf("Validate(%q) with Code Mode = %v, want ok %v", test.kind, err, test.ok)
		}
		if err := Validate(test.kind, "", "", "", false); err != nil {
			t.Errorf("Validate(%q) without Code Mode = %v", test.kind, err)
		}
	}
}

// Each typed tool has permission modes. The values are unique in each type, and the
// options are fixed words that the shell does not interpret.
func TestPermissions(t *testing.T) {
	for _, kind := range Types {
		modes := permissions[kind]
		if Typed(kind) != (len(modes) > 0) {
			t.Errorf("%s has %d permission modes", kind, len(modes))
		}
		seen := map[string]bool{}
		for _, mode := range modes {
			if mode.Value == "" || seen[mode.Value] || strings.Trim(mode.Value, "abcdefghijklmnopqrstuvwxyz-") != "" {
				t.Errorf("%s has an invalid or repeated mode %q", kind, mode.Value)
			}
			seen[mode.Value] = true
			if mode.Options == "" || strings.Trim(mode.Options, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_=- ") != "" {
				t.Errorf("%s mode %q has options %q", kind, mode.Value, mode.Options)
			}
		}
	}
}

func TestParseCodex(t *testing.T) {
	output := `{"models":[
{"slug":"gpt-6-luna","display_name":"GPT-6-Luna","visibility":"list","default_reasoning_level":"medium",
 "supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"}]},
{"slug":"hidden-model","visibility":"hide","supported_reasoning_levels":[]},
{"slug":"gpt-6-sol","visibility":"list","default_reasoning_level":"unknown","supported_reasoning_levels":[{"effort":"ultra"},{"effort":"Bad Value"}]}
]}`
	catalog, err := Parse(Codex, []byte(output))
	if err != nil {
		t.Fatal(err)
	}
	want := []Model{
		{ID: "gpt-6-luna", Name: "gpt-6-luna", Efforts: []string{"low", "medium", "high"}, Default: "medium"},
		{ID: "gpt-6-sol", Name: "gpt-6-sol", Efforts: []string{"ultra"}},
	}
	if !reflect.DeepEqual(catalog.Models, want) || catalog.Source != "codex debug models" {
		t.Fatalf("got %#v", catalog)
	}
	if _, err := Parse(Codex, []byte("not json")); err == nil {
		t.Fatal("accepted output that is not JSON")
	}
	if _, err := Parse(Codex, []byte(`{"models":[]}`)); err == nil {
		t.Fatal("accepted an empty list")
	}
}

func TestParseAgy(t *testing.T) {
	output := "Fetching available models...\n" +
		"gemini-4-neon-high\tGemini 4 Neon (High)\n" +
		"gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)\n" +
		"gemini-4-neon-low\tGemini 4 Neon (Low)\n" +
		"gemini-pro-orchestrator-neon\tOrchestrator (Neon)\n" +
		"gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n" +
		"odd-high\tOdd name\n"
	catalog, err := Parse(Agy, []byte(output))
	if err != nil {
		t.Fatal(err)
	}
	want := []Model{
		{ID: "gemini-4-neon", Name: "Gemini 4 Neon", Efforts: []string{"low", "high", "xhigh"}},
		{ID: "gemini-pro-orchestrator-neon", Name: "Orchestrator (Neon)", Efforts: []string{}},
		{ID: "gpt-oss-120b", Name: "GPT-OSS 120B", Efforts: []string{"medium"}},
		{ID: "odd-high", Name: "Odd name", Efforts: []string{}},
	}
	if !reflect.DeepEqual(catalog.Models, want) {
		t.Fatalf("got %#v", catalog.Models)
	}
}

func TestParseCodePuppy(t *testing.T) {
	output := "  codex-gpt-5.6-luna  [chatgpt_oauth] gpt-5.6-luna\n* codex-gpt-6-luna  [chatgpt_oauth] gpt-6-luna\nNo header\n"
	catalog, err := Parse(CodePuppy, []byte(output))
	if err != nil {
		t.Fatal(err)
	}
	want := []Model{
		{ID: "codex-gpt-5.6-luna", Name: "codex-gpt-5.6-luna → gpt-5.6-luna", Efforts: []string{}},
		{ID: "codex-gpt-6-luna", Name: "codex-gpt-6-luna → gpt-6-luna", Efforts: []string{}},
	}
	if !reflect.DeepEqual(catalog.Models, want) {
		t.Fatalf("got %#v", catalog.Models)
	}
}

func TestBuiltin(t *testing.T) {
	catalog := Builtin(Claude)
	if catalog.Source != "" || len(catalog.Models) == 0 || !reflect.DeepEqual(catalog.Efforts, []string{"low", "medium", "high", "xhigh", "max"}) {
		t.Fatalf("got %#v", catalog)
	}
	if ListCommand(Claude, "claude") != "" || ListCommand(Custom, "x") != "" {
		t.Fatal("Claude Code and Custom have no list command")
	}
}

func TestValidPath(t *testing.T) {
	for path, ok := range map[string]bool{
		"": true, "codex": true, "/opt/homebrew/bin/codex": true, "~/.local/bin/agy": true,
		"/a b/codex": false, "$HOME/bin/codex": false, "`which codex`": false, "codex; id": false, "'codex'": false,
		"./bin/codex": false, "bin/codex": false, "../codex": false, strings.Repeat("a", 501): false,
	} {
		if err := ValidPath(path); (err == nil) != ok {
			t.Errorf("ValidPath(%q) = %v, want ok %v", path, err, ok)
		}
	}
	if got := ListCommand(Codex, "/opt/bin/codex"); got != "/opt/bin/codex debug models" {
		t.Fatal(got)
	}
}

func TestBuiltinCommand(t *testing.T) {
	for _, test := range []struct{ kind, path, want string }{
		{Codex, "", "codex --no-alt-screen"},
		{Codex, "/opt/homebrew/bin/codex", "/opt/homebrew/bin/codex --no-alt-screen"},
		{Claude, "", "claude"},
		{Agy, "~/.local/bin/agy", "~/.local/bin/agy"},
		{CodePuppy, "", "code-puppy"},
	} {
		if got := BuiltinCommand(test.kind, test.path); got != test.want {
			t.Errorf("BuiltinCommand(%q, %q) = %q, want %q", test.kind, test.path, got, test.want)
		}
	}
}
