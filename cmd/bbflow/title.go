package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"bbflow/internal/client"
	"bbflow/internal/history"
	"bbflow/internal/models"
	"bbflow/internal/protocol"
)

const titleToolUsage = `Usage:
  bbflow [--dir DIR] title-tool list
  bbflow [--dir DIR] title-tool show
  bbflow [--dir DIR] title-tool set TOOL [--model MODEL] [--effort EFFORT]
  bbflow [--dir DIR] title-tool set custom [COMMAND]
  bbflow [--dir DIR] title-tool test

TOOL is none, claude, codex, code-puppy, apple, or custom.
list prints the exact command of each built-in title tool.
show prints the saved title tool and the command that the server runs for it.
set tests the tool with a sample message, then saves it. A failed test saves nothing.
A test can take up to 90 seconds. none saves without a test.
set custom without COMMAND tests the saved custom command again.
--model and --effort select the model and the thinking effort of claude, codex, or
code-puppy. Without them, set uses the default model and effort of the tool. An empty
value adds no option, so the CLI uses its own default. code-puppy has no effort.
test runs the saved title tool again and saves nothing.
Claude, Codex, and Code Puppy send the sample message to their provider.`

// titleTestWait is the time that the CLI waits for a title test. The server stops a
// title test after 90 seconds, so the CLI waits a little longer. See titleTimeout in
// internal/server/titles.go.
const titleTestWait = 100 * time.Second

func titleToolCommand(target client.Target, args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Println(titleToolUsage)
		return nil
	}
	switch {
	case args[0] == "list" && len(args) == 1:
		tools, err := loadTitleTools(target)
		if err != nil {
			return err
		}
		for _, tool := range tools.Tools {
			fmt.Printf("%-11s %s\n", tool.ID, tool.Command)
		}
		return nil
	case args[0] == "show" && len(args) == 1:
		return showTitleTool(target)
	case args[0] == "test" && len(args) == 1:
		return testTitleTool(target)
	case args[0] == "set" && len(args) == 2 && strings.TrimSpace(args[1]) != "":
		// custom without COMMAND uses the saved custom command.
		return setTitleTool(target, history.TitleChoice{Tool: strings.TrimSpace(args[1])}, true, nil)
	case args[0] == "set" && len(args) == 3 && strings.TrimSpace(args[1]) == "custom":
		// An empty COMMAND is an error of the server. It does not select the saved command.
		return setTitleTool(target, history.TitleChoice{Tool: "custom", Command: args[2]}, false, nil)
	case args[0] == "set" && len(args) > 3 && strings.TrimSpace(args[1]) != "custom" && strings.HasPrefix(args[2], "--"):
		choice := history.TitleChoice{Tool: strings.TrimSpace(args[1])}
		given := map[string]bool{}
		for rest := args[2:]; len(rest) > 0; rest = rest[2:] {
			if len(rest) < 2 || (rest[0] != "--model" && rest[0] != "--effort") || given[rest[0]] {
				return errors.New("after TOOL, give --model MODEL, --effort EFFORT, or both, each once")
			}
			given[rest[0]] = true
			if rest[0] == "--model" {
				choice.Model = rest[1]
			} else {
				choice.Effort = rest[1]
			}
		}
		return setTitleTool(target, choice, false, given)
	case args[0] == "set" && len(args) == 3 && strings.HasPrefix(args[2], "--"):
		return errors.New("after TOOL, give --model MODEL, --effort EFFORT, or both, each once")
	case args[0] == "set" && len(args) == 3:
		return errors.New("only the custom title tool takes a command")
	case args[0] == "set":
		return errors.New("provide one title tool, for example: bbflow title-tool set codex")
	case args[0] == "list" || args[0] == "show" || args[0] == "test":
		return fmt.Errorf("title-tool %s takes no arguments", args[0])
	default:
		return fmt.Errorf("unknown title-tool command %q\n%s", args[0], titleToolUsage)
	}
}

func loadTitleTools(target client.Target) (protocol.TitleTools, error) {
	var tools protocol.TitleTools
	result, err := target.Call(protocol.Request{Operation: "title-tools"})
	if err == nil {
		err = json.Unmarshal(result, &tools)
	}
	return tools, err
}

// describeTitleTool returns the name of a title tool and the command that the server
// runs for a choice. For custom, the command is the custom command. A tool with a type
// gets the options of the model and the effort. An unknown tool gives no name, and the
// server rejects it.
func describeTitleTool(tools protocol.TitleTools, choice history.TitleChoice) (name, run string) {
	switch choice.Tool {
	case "none":
		return "None", ""
	case "custom":
		return "Custom", choice.Command
	}
	for _, tool := range tools.Tools {
		if tool.ID == choice.Tool {
			if tool.Type == "" {
				return tool.Name, tool.Command
			}
			return tool.Name, models.Command(tool.Type, tool.Prefix, choice.Model, choice.Effort, "", false) + tool.Suffix
		}
	}
	return "", ""
}

// noteTitleTest tells on standard error which command the test runs.
func noteTitleTest(name, command string) {
	if name != "" && command != "" {
		fmt.Fprintf(os.Stderr, "Testing %s with this command:\n  %s\nThis can take up to 90 seconds.\n", name, command)
	}
}

// showTitleTool prints the saved title tool and its command. A built-in command comes
// from the running server, so it is the command that the server runs.
func showTitleTool(target client.Target) error {
	settings, err := loadSettings(target)
	if err != nil {
		return err
	}
	tools, err := loadTitleTools(target)
	if err != nil {
		return err
	}
	name, command := describeTitleTool(tools, settings.Choice())
	switch settings.TitleTool {
	case "none":
		fmt.Println("Title tool: None. Automatic titles are off.")
	case "custom":
		fmt.Printf("Title tool: Custom\nCommand: %s\nThis is your own command. bbflow does not limit what it can do.\n", command)
	default:
		fmt.Printf("Title tool: %s (built-in)\n", name)
		if history.TitleType(settings.TitleTool) != "" {
			fmt.Printf("Model: %s\nEffort: %s\n", orDefault(settings.TitleModel), orDefault(settings.TitleEffort))
		}
		fmt.Printf("Command: %s\n", command)
	}
	if settings.TitleTool != "custom" && settings.TitleCommand != "" {
		fmt.Printf("Saved custom command: %s\n", settings.TitleCommand)
	}
	return nil
}

// setTitleTool saves the title tool. The server first tests each tool except none with
// a sample message. A failed test saves nothing, and the server error tells why. With
// saved, custom uses the saved custom command. The CLI sends the command that it shows,
// so the test runs that command, also after another client saves another one.
func setTitleTool(target client.Target, choice history.TitleChoice, saved bool, given map[string]bool) error {
	tool := choice.Tool
	name := ""
	if tool != "none" {
		settings, err := loadSettings(target)
		if err != nil {
			return err
		}
		tools, err := loadTitleTools(target)
		if err != nil {
			return err
		}
		if tool == "custom" && saved {
			if settings.TitleCommand == "" {
				return errors.New("no custom command is saved; use bbflow title-tool set custom COMMAND")
			}
			choice.Command = settings.TitleCommand
		}
		// An option that is not given takes the default of the tool.
		for _, candidate := range tools.Tools {
			if candidate.ID == tool && !given["--model"] {
				choice.Model = candidate.Model
			}
			if candidate.ID == tool && !given["--effort"] {
				choice.Effort = candidate.Effort
			}
		}
		var run string
		name, run = describeTitleTool(tools, choice)
		noteTitleTest(name, run)
	}
	request := &history.Settings{TitleTool: tool, TitleCommand: choice.Command, TitleModel: choice.Model, TitleEffort: choice.Effort}
	result, err := target.CallWithin(protocol.Request{Operation: "title-tool-set", Settings: request}, titleTestWait)
	if err != nil {
		return err
	}
	var set protocol.TitleToolSet
	if err = json.Unmarshal(result, &set); err != nil {
		return err
	}
	if set.Title == "" {
		fmt.Println("Automatic titles are off.")
		return nil
	}
	fmt.Printf("%s is configured. Its test made the title %q from a sample message.\n", name, set.Title)
	return nil
}

// testTitleTool runs the saved title tool once with the sample message. It saves
// nothing.
func testTitleTool(target client.Target) error {
	settings, err := loadSettings(target)
	if err != nil {
		return err
	}
	if settings.TitleTool == "none" {
		return errors.New("the title tool is None, so there is nothing to test; select one with bbflow title-tool set TOOL")
	}
	tools, err := loadTitleTools(target)
	if err != nil {
		return err
	}
	name, command := describeTitleTool(tools, settings.Choice())
	noteTitleTest(name, command)
	// Send the custom command, the model, and the effort that the note shows, so that the
	// test runs this command.
	choice := &history.Settings{TitleTool: settings.TitleTool, TitleModel: settings.TitleModel, TitleEffort: settings.TitleEffort}
	if settings.TitleTool == "custom" {
		choice.TitleCommand = settings.TitleCommand
	}
	result, err := target.CallWithin(protocol.Request{Operation: "title-test", Settings: choice}, titleTestWait)
	if err != nil {
		return fmt.Errorf("the test of %s failed: %w", name, err)
	}
	var test protocol.TitleTest
	if err = json.Unmarshal(result, &test); err != nil {
		return err
	}
	fmt.Printf("Test passed. %s made the title %q from a sample message.\n", name, test.Title)
	return nil
}

// orDefault returns the value, or "CLI default" for an empty value.
func orDefault(value string) string {
	if value == "" {
		return "CLI default"
	}
	return value
}
