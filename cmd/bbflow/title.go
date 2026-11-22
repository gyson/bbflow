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
	"bbflow/internal/protocol"
)

const titleToolUsage = `Usage:
  bbflow [--dir DIR] title-tool list
  bbflow [--dir DIR] title-tool show
  bbflow [--dir DIR] title-tool set TOOL
  bbflow [--dir DIR] title-tool set custom [COMMAND]
  bbflow [--dir DIR] title-tool test

TOOL is none, claude, codex, code-puppy, apple, or custom.
list prints the exact command of each built-in title tool.
show prints the saved title tool and the command that the server runs for it.
set tests the tool with a sample message, then saves it. A failed test saves nothing.
A test can take up to 90 seconds. none saves without a test.
set custom without COMMAND tests the saved custom command again.
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
		return setTitleTool(target, strings.TrimSpace(args[1]), "", true)
	case args[0] == "set" && len(args) == 3 && strings.TrimSpace(args[1]) == "custom":
		// An empty COMMAND is an error of the server. It does not select the saved command.
		return setTitleTool(target, "custom", args[2], false)
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
// runs for it. For custom, command is the custom command. An unknown tool gives no
// name, and the server rejects it.
func describeTitleTool(tools protocol.TitleTools, id, command string) (name, run string) {
	switch id {
	case "none":
		return "None", ""
	case "custom":
		return "Custom", command
	}
	for _, tool := range tools.Tools {
		if tool.ID == id {
			return tool.Name, tool.Command
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
	name, command := describeTitleTool(tools, settings.TitleTool, settings.TitleCommand)
	switch settings.TitleTool {
	case "none":
		fmt.Println("Title tool: None. Automatic titles are off.")
	case "custom":
		fmt.Printf("Title tool: Custom\nCommand: %s\nThis is your own command. bbflow does not limit what it can do.\n", command)
	default:
		fmt.Printf("Title tool: %s (built-in)\nCommand: %s\n", name, command)
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
func setTitleTool(target client.Target, tool, command string, saved bool) error {
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
			command = settings.TitleCommand
		}
		var run string
		name, run = describeTitleTool(tools, tool, command)
		noteTitleTest(name, run)
	}
	result, err := target.CallWithin(protocol.Request{Operation: "title-tool-set", Settings: &history.Settings{TitleTool: tool, TitleCommand: command}}, titleTestWait)
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
	name, command := describeTitleTool(tools, settings.TitleTool, settings.TitleCommand)
	noteTitleTest(name, command)
	// Send the custom command that the note shows, so that the test runs this command.
	choice := &history.Settings{TitleTool: settings.TitleTool}
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
