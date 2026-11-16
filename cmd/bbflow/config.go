package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"bbflow/internal/client"
	"bbflow/internal/history"
	"bbflow/internal/protocol"
)

const toolUsage = `Usage:
  bbflow [--dir DIR] tool list
  bbflow [--dir DIR] tool add [--continue COMMAND] [--default] NAME COMMAND
  bbflow [--dir DIR] tool remove NAME

add creates a tool, or replaces the commands of the tool with this name.
Put options before NAME. Quote a command that contains spaces.`

const settingsUsage = `Usage:
  bbflow [--dir DIR] settings get
  bbflow [--dir DIR] settings set KEY VALUE

Keys:
  appearance    system, light, or dark
  default-tool  a tool name, or "" for the built-in Shell
  worktree      true or false
  base          the default Git branch or commit, such as HEAD`

func toolCommand(target client.Target, args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Println(toolUsage)
		return nil
	}
	flags := flag.NewFlagSet("tool "+args[0], flag.ContinueOnError)
	flags.Usage = func() { fmt.Println(toolUsage) }
	switch args[0] {
	case "list":
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return errors.New("tool list takes no arguments")
		}
		settings, err := loadSettings(target)
		if err != nil {
			return err
		}
		return printJSON(settings.Tools)
	case "add":
		continueCommand := flags.String("continue", "", "continue command with {prompt} once")
		makeDefault := flags.Bool("default", false, "make this tool the default tool")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 2 {
			return errors.New("provide a name and one quoted command, for example: bbflow tool add Codex \"codex --search\"")
		}
		name, command := strings.TrimSpace(flags.Arg(0)), flags.Arg(1)
		added := false
		err := changeSettings(target, func(settings *history.Settings) error {
			index, err := findTool(settings.Tools, name)
			if err != nil {
				return err
			}
			added = index < 0
			if added {
				settings.Tools = append(settings.Tools, history.Tool{ID: history.ID(), Name: name})
				index = len(settings.Tools) - 1
			}
			tool := &settings.Tools[index]
			tool.Command, tool.ContinueCommand = command, *continueCommand
			if *makeDefault {
				settings.DefaultTool = tool.ID
			}
			return nil
		})
		if err == nil && added {
			fmt.Printf("Added tool %q.\n", name)
		} else if err == nil {
			fmt.Printf("Updated tool %q.\n", name)
		}
		return err
	case "remove":
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 1 {
			return errors.New("provide the name of one tool to remove")
		}
		name := strings.TrimSpace(flags.Arg(0))
		err := changeSettings(target, func(settings *history.Settings) error {
			index, err := findTool(settings.Tools, name)
			if err != nil {
				return err
			}
			if index < 0 {
				return fmt.Errorf("tool %q does not exist", name)
			}
			if settings.DefaultTool == settings.Tools[index].ID {
				settings.DefaultTool = ""
			}
			settings.Tools = append(settings.Tools[:index], settings.Tools[index+1:]...)
			return nil
		})
		if err == nil {
			fmt.Printf("Removed tool %q.\n", name)
		}
		return err
	default:
		return fmt.Errorf("unknown tool command %q\n%s", args[0], toolUsage)
	}
}

func settingsCommand(target client.Target, args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Println(settingsUsage)
		return nil
	}
	switch {
	case args[0] == "get" && len(args) == 1:
		settings, err := loadSettings(target)
		if err != nil {
			return err
		}
		return printJSON(settings)
	case args[0] == "get":
		return errors.New("settings get takes no arguments")
	case args[0] == "set" && len(args) == 3:
		key, value := args[1], args[2]
		return changeSettings(target, func(settings *history.Settings) error {
			switch key {
			case "appearance":
				settings.Appearance = value
			case "default-tool":
				// A tool can have the name Shell, so only an empty value selects the
				// built-in Shell.
				if strings.TrimSpace(value) == "" {
					settings.DefaultTool = ""
					return nil
				}
				index, err := findTool(settings.Tools, value)
				if err != nil {
					return err
				}
				if index < 0 {
					return fmt.Errorf(`tool %q does not exist; use "" for the built-in Shell`, strings.TrimSpace(value))
				}
				settings.DefaultTool = settings.Tools[index].ID
			case "worktree":
				enabled, err := strconv.ParseBool(value)
				if err != nil {
					return errors.New("worktree must be true or false")
				}
				settings.Worktree = enabled
			case "base":
				settings.Base = value
			default:
				return fmt.Errorf("unknown settings key %q; use appearance, default-tool, worktree, or base", key)
			}
			return nil
		})
	case args[0] == "set":
		return errors.New("provide one key and one value, for example: bbflow settings set appearance dark")
	default:
		return fmt.Errorf("unknown settings command %q\n%s", args[0], settingsUsage)
	}
}

// findTool returns -1 when no tool has the name. Names are not unique in Settings, so
// a name that selects more than one tool is an error.
func findTool(tools []history.Tool, name string) (int, error) {
	name = strings.TrimSpace(name)
	found := -1
	for i, tool := range tools {
		if tool.Name != name {
			continue
		}
		if found >= 0 {
			return 0, fmt.Errorf("more than one tool has the name %q; rename one in Settings", name)
		}
		found = i
	}
	return found, nil
}

func loadSettings(target client.Target) (history.Settings, error) {
	var settings history.Settings
	result, err := target.Call(protocol.Request{Operation: "settings-get"})
	if err == nil {
		err = json.Unmarshal(result, &settings)
	}
	return settings, err
}

// changeSettings applies change to the latest saved settings. The server rejects a
// save from an earlier revision. If another client saved first, apply the change again
// to the new revision.
func changeSettings(target client.Target, change func(*history.Settings) error) error {
	for attempt := 0; ; attempt++ {
		settings, err := loadSettings(target)
		if err != nil {
			return err
		}
		revision := settings.Revision
		if err = change(&settings); err != nil {
			return err
		}
		_, err = target.Call(protocol.Request{Operation: "settings-save", Settings: &settings})
		if err == nil || attempt == 2 {
			return err
		}
		if latest, readErr := loadSettings(target); readErr != nil || latest.Revision == revision {
			return err
		}
	}
}

func printJSON(value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err == nil {
		_, err = fmt.Fprintln(os.Stdout, string(data))
	}
	return err
}
