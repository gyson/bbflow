// Package models knows the agent CLIs that bbflow can start with a chosen model and
// thinking effort. It builds the model and effort options of a startup command, and it
// reads the model list of each CLI.
package models

import (
	"errors"
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
// then adds the model and effort options at the end. See Command.
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

// Validate checks a tool type with its model and effort. An empty model or effort
// selects the default of the CLI.
func Validate(kind, model, effort string) error {
	if kind != "" && kind != Custom && !Typed(kind) {
		return errors.New("tool type must be codex, claude, agy, code-puppy, or custom")
	}
	if !Typed(kind) {
		if model != "" || effort != "" {
			return errors.New("a custom tool has no model or effort; put them in its command")
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
	}
	return nil
}

// Command returns the startup command with the model and effort options of the type.
// The options go at the end, so the command must end with the agent call. An empty
// model or effort adds no option.
func Command(kind, command, model, effort string) string {
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
	if len(options) == 0 {
		return command
	}
	return strings.TrimRight(command, " ") + " " + strings.Join(options, " ")
}
