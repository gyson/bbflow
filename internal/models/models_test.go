package models

import (
	"reflect"
	"strings"
	"testing"
)

func TestCommand(t *testing.T) {
	for _, test := range []struct {
		kind, command, model, effort, want string
	}{
		{Codex, "codex --no-alt-screen", "gpt-6-luna", "medium", "codex --no-alt-screen --model gpt-6-luna -c model_reasoning_effort=medium"},
		{Codex, "codex", "", "high", "codex -c model_reasoning_effort=high"},
		{Codex, "codex", "", "", "codex"},
		{Claude, "claude ", "opus", "high", "claude --model opus --effort high"},
		{Claude, "claude", "", "max", "claude --effort max"},
		{Agy, "agy", "gemini-4-neon", "high", "agy --model gemini-4-neon-high"},
		{Agy, "agy", "gemini-pro-orchestrator-neon", "", "agy --model gemini-pro-orchestrator-neon"},
		{CodePuppy, "code-puppy", "codex-gpt-6-luna", "", "code-puppy --model codex-gpt-6-luna"},
		{Custom, "./review.sh", "", "", "./review.sh"},
		{"", "", "", "", ""},
	} {
		if got := Command(test.kind, test.command, test.model, test.effort); got != test.want {
			t.Errorf("Command(%q, %q, %q, %q) = %q, want %q", test.kind, test.command, test.model, test.effort, got, test.want)
		}
	}
}

func TestValidate(t *testing.T) {
	for _, test := range []struct {
		kind, model, effort string
		ok                  bool
	}{
		{Codex, "gpt-6-luna", "medium", true},
		{Codex, "", "", true},
		{Claude, "claude-opus-5-5", "max", true},
		{Agy, "gemini-4-neon", "high", true},
		{Agy, "", "high", false},
		{CodePuppy, "codex-gpt-6-luna", "", true},
		{CodePuppy, "codex-gpt-6-luna", "low", false},
		{Custom, "", "", true},
		{Custom, "gpt-6-luna", "", false},
		{"", "", "", true},
		{"other", "", "", false},
		{Codex, "gpt; rm -rf ~", "", false},
		{Codex, "$(id)", "", false},
		{Codex, "gpt-6-luna", "High", false},
		{Codex, "-o", "", false},
	} {
		if err := Validate(test.kind, test.model, test.effort); (err == nil) != test.ok {
			t.Errorf("Validate(%q, %q, %q) = %v, want ok %v", test.kind, test.model, test.effort, err, test.ok)
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
