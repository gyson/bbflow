// Package models knows the agent CLIs that bbflow can start with a chosen model, thinking
// effort, permission mode, and, for Claude Code, Code Mode. It builds the options of a
// startup command, and it reads the model list of each CLI.
package models

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// The tool types. Custom adds no options to its command.
const (
	Custom    = "custom"
	Codex     = "codex"
	Claude    = "claude"
	Agy       = "agy"
	CodePuppy = "code-puppy"
)

// Types lists the tool types in the order of the Type menu.
var Types = []string{Codex, Claude, Agy, CodePuppy, Custom}

// Name returns the name of a tool type for messages.
func Name(kind string) string {
	switch kind {
	case Codex:
		return "Codex"
	case Claude:
		return "Claude Code"
	case Agy:
		return "Antigravity"
	case CodePuppy:
		return "Code Puppy"
	}
	return "Custom"
}

// Typed tells if bbflow adds model options for the type.
func Typed(kind string) bool {
	return kind == Codex || kind == Claude || kind == Agy || kind == CodePuppy
}

// programPattern accepts a program name or path that the shell does not interpret,
// except a ~ at its start.
var programPattern = regexp.MustCompile(`^[A-Za-z0-9_./~+@-]+$`)

// ValidPath checks the optional CLI path of a built-in tool: a program name or a path
// that the shell does not interpret, except a ~ at its start. An empty path selects the
// plain CLI name.
//
// A path with a folder must start with / or ~/. Sessions, the model lists, the CLI check,
// and the title tools run in different folders, so a relative path would name different
// files for them.
func ValidPath(path string) error {
	if path == "" {
		return nil
	}
	if len(path) > 500 || !programPattern.MatchString(path) {
		return errors.New("a CLI path has at most 500 letters, digits, and the characters _ . / ~ + @ -, without spaces")
	}
	if strings.Contains(path, "/") && !strings.HasPrefix(path, "/") && !strings.HasPrefix(path, "~/") {
		return errors.New("a CLI path with a folder must start with / or ~/, because tools run in different folders")
	}
	return nil
}

// presetArgs are the fixed arguments of the built-in tool of each type. Codex needs
// --no-alt-screen, so that bbflow can record its scrollback.
var presetArgs = map[string]string{Codex: "--no-alt-screen"}

// BuiltinCommand returns the startup command of a built-in tool: its CLI path, or the
// plain CLI name when the path is empty, then the fixed arguments of its type. The launch
// then adds the model, effort, and permission options at the end. See Command.
// Code Mode adds an environment variable at the start.
func BuiltinCommand(kind, path string) string {
	program := path
	if program == "" {
		program = kind
	}
	if args := presetArgs[kind]; args != "" {
		return program + " " + args
	}
	return program
}

// The names of models and efforts go into a shell command line without quotes, so they
// can hold only characters that the shell does not interpret.
var (
	modelPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$`)
	effortPattern = regexp.MustCompile(`^[a-z]{1,20}$`)
)

// Validate checks a tool type with its model, effort, permission mode, and Code Mode. An
// empty model, effort, or permission mode selects the default of the CLI. Only Claude
// Code has Code Mode. Code Mode off adds nothing, so the CLI uses its own setting.
func Validate(kind, model, effort, permission string, codeMode bool) error {
	if kind != "" && kind != Custom && !Typed(kind) {
		return errors.New("tool type must be codex, claude, agy, code-puppy, or custom")
	}
	if !Typed(kind) {
		if model != "" || effort != "" || permission != "" || codeMode {
			return errors.New("a custom tool has no model, effort, permissions, or Code Mode; put them in its command")
		}
		return nil
	}
	if model != "" && !modelPattern.MatchString(model) {
		return errors.New("a model name has at most 200 letters, digits, and the characters . _ : / @ + -")
	}
	if effort != "" && !effortPattern.MatchString(effort) {
		return errors.New("an effort is one lowercase word")
	}
	switch {
	case kind == CodePuppy && effort != "":
		return errors.New("Code Puppy has no effort option")
	case kind == Agy && effort != "" && model == "":
		return errors.New("choose an Antigravity model before its effort")
	case permission != "" && permissionOptions(kind, permission) == "":
		return fmt.Errorf("%s has no permission mode %q", Name(kind), permission)
	case codeMode && kind != Claude:
		return fmt.Errorf("%s has no Code Mode; only Claude Code has it", Name(kind))
	}
	return nil
}

// CodeModePrefix turns on the experimental Code Mode of Claude Code. Claude Code has no
// option for it. Its documentation turns it on with this environment variable in the
// shell, so the launch puts the variable before the command. The variable then applies
// to that process only. A "0" in the settings of the user or in managed settings still
// keeps Code Mode off.
const CodeModePrefix = "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 "

// Permission is one choice of the Permissions menu of a tool type. Value is the saved
// value. Options are the options that the launch adds. The web view has the same list,
// with a label for each value.
type Permission struct {
	Value   string
	Options string
}

// permissions lists the permission modes of each type, in the order of the menu. An empty
// value, the CLI default, adds no option, so the CLI uses its own setting.
//
// The Codex modes are the choices of its /permissions menu. Ask for approval and Read Only
// also select the user as the reviewer, because the Codex configuration of the user can
// set approvals_reviewer to auto_review, which is Approve for me.
var permissions = map[string][]Permission{
	Codex: {
		{"ask", "--sandbox workspace-write --ask-for-approval on-request -c approvals_reviewer=user"},
		{"approve-for-me", "--approve-for-me"},
		{"read-only", "--sandbox read-only --ask-for-approval on-request -c approvals_reviewer=user"},
		{"full-access", "--sandbox danger-full-access --ask-for-approval never"},
	},
	Claude: {
		{"manual", "--permission-mode manual"},
		{"accept-edits", "--permission-mode acceptEdits"},
		{"plan", "--permission-mode plan"},
		{"auto", "--permission-mode auto"},
		{"dont-ask", "--permission-mode dontAsk"},
		{"bypass-permissions", "--permission-mode bypassPermissions"},
	},
	Agy: {
		{"accept-edits", "--mode accept-edits"},
		{"auto", "--mode auto"},
		{"plan", "--mode plan"},
		{"skip-permissions", "--dangerously-skip-permissions"},
	},
	CodePuppy: {
		{"confirm", "--yolo false"},
		{"yolo", "--yolo true"},
	},
}

// permissionOptions returns the options of a permission mode, or an empty string when the
// type has no such mode.
func permissionOptions(kind, permission string) string {
	for _, p := range permissions[kind] {
		if p.Value == permission {
			return p.Options
		}
	}
	return ""
}

// Command returns the startup command with the model, effort, and permission options of
// the type. The options go at the end, so the command must end with the agent call. An
// empty model, effort, or permission mode adds no option. For Claude Code, Code Mode
// puts CodeModePrefix before the command, so the command must start with the agent call
// too. Code Mode off adds nothing.
func Command(kind, command, model, effort, permission string, codeMode bool) string {
	command = withOptions(kind, command, model, effort, permission)
	if codeMode && kind == Claude {
		return CodeModePrefix + command
	}
	return command
}

// withOptions adds the model, effort, and permission options of the type to the command.
func withOptions(kind, command, model, effort, permission string) string {
	var options []string
	switch kind {
	case Codex:
		if model != "" {
			options = append(options, "--model "+model)
		}
		if effort != "" {
			options = append(options, "-c model_reasoning_effort="+effort)
		}
	case Claude:
		if model != "" {
			options = append(options, "--model "+model)
		}
		if effort != "" {
			options = append(options, "--effort "+effort)
		}
	case Agy:
		// Antigravity names the effort in the model ID, for example gemini-4-neon-high.
		if model != "" && effort != "" {
			options = append(options, "--model "+model+"-"+effort)
		} else if model != "" {
			options = append(options, "--model "+model)
		}
	case CodePuppy:
		if model != "" {
			options = append(options, "--model "+model)
		}
	}
	if mode := permissionOptions(kind, permission); mode != "" {
		options = append(options, mode)
	}
	if len(options) == 0 {
		return command
	}
	return strings.TrimRight(command, " ") + " " + strings.Join(options, " ")
}
