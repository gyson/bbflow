package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"

	"bbflow/internal/client"
	"bbflow/internal/history"
	"bbflow/internal/protocol"
)

const toolUsage = `Usage:
  bbflow [--dir DIR] tool list
  bbflow [--dir DIR] tool add [--default] NAME COMMAND
  bbflow [--dir DIR] tool remove NAME

list prints one tool on each line: the name, a tab, and the command.
add creates a tool or replaces the command of the tool with this name.
Put --default before NAME. Quote a command that contains spaces.`

const settingsUsage = `Usage:
  bbflow [--dir DIR] settings get [KEY]
  bbflow [--dir DIR] settings set KEY VALUE

get prints all settings as JSON. get KEY prints one value as text.

Keys:
  appearance    system, light, or dark
  default-tool  a tool name, or "" for the built-in Shell
  worktree      true or false
  base          the default Git branch or commit, such as HEAD
  update-check  true or false: read the latest release from GitHub once a day
  port          1024 to 65535, or 0 for an automatic port; applies at the next server start
  remote-host   the host name of this computer in Tailscale Serve, or "" for none
  remote-login  the Tailscale login that can use remote access, or "" for none

Remote access is on only while remote-host and remote-login are both set.
In the JSON, default-tool is defaultTool, update-check is updateCheck, remote-host is
remoteHost, and remote-login is remoteLogin.
Use bbflow title-tool to select the title tool.`

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
		if len(settings.Tools) == 0 {
			fmt.Println("No tools are saved.")
			return nil
		}
		// A name and a command have no control characters, so the tab divides each line.
		// Padding to one column would need the display width of each character.
		for _, tool := range settings.Tools {
			fmt.Printf("%s\t%s\n", tool.Name, tool.Command)
		}
		return nil
	case "add":
		makeDefault := flags.Bool("default", false, "make this tool the default tool")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		// The flag package stops at NAME, so an option after it is an argument. After
		// the option terminator --, the first argument is NAME, also when it is --default.
		rest := args[1:]
		terminated := flags.NArg() < len(rest) && rest[len(rest)-flags.NArg()-1] == "--"
		if !terminated && flags.NArg() > 1 && (slices.Contains(flags.Args()[1:], "--default") || slices.Contains(flags.Args()[1:], "-default")) {
			return errors.New("put --default before NAME, for example: bbflow tool add --default Codex \"codex --search\"")
		}
		if flags.NArg() != 2 {
			return errors.New("provide a name and one quoted command, for example: bbflow tool add Codex \"codex --search\"")
		}
		name, command := strings.TrimSpace(flags.Arg(0)), flags.Arg(1)
		added := false
		_, err := changeSettings(target, func(settings *history.Settings) error {
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
			tool.Command = command
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
		_, err := changeSettings(target, func(settings *history.Settings) error {
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
	case args[0] == "get" && len(args) == 2:
		settings, err := loadSettings(target)
		if err != nil {
			return err
		}
		value, err := settingValue(settings, args[1], "show")
		if err == nil {
			fmt.Println(value)
		}
		return err
	case args[0] == "get":
		return errors.New("settings get takes at most one key")
	case args[0] == "set" && len(args) == 3:
		key, value := args[1], args[2]
		port := 0
		saved, err := changeSettings(target, func(settings *history.Settings) error {
			port = settings.Port
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
				enabled, err := parseSwitch(key, value)
				if err != nil {
					return err
				}
				settings.Worktree = enabled
			case "base":
				settings.Base = value
			case "update-check":
				enabled, err := parseSwitch(key, value)
				if err != nil {
					return err
				}
				settings.UpdateCheck = enabled
			case "port":
				number, err := strconv.Atoi(strings.TrimSpace(value))
				if err != nil {
					return fmt.Errorf("port must be from %d to 65535, or 0 for an automatic port", history.MinPort)
				}
				settings.Port = number
			case "remote-host":
				settings.RemoteHost = value
			case "remote-login":
				settings.RemoteLogin = value
			default:
				_, err := settingValue(*settings, key, "set TOOL")
				return err
			}
			return nil
		})
		if err != nil {
			return err
		}
		// Print the saved value, because the server replaces an empty value by its default.
		shown, err := settingValue(saved, key, "")
		if err != nil {
			return err
		}
		switch {
		case key == "default-tool" && shown == "":
			shown = "the built-in Shell"
		case key == "port" && shown == "0":
			shown = "0, the automatic port"
		case (key == "remote-host" || key == "remote-login") && shown == "":
			shown = "none"
		}
		fmt.Printf("Saved %s: %s.\n", key, shown)
		if key == "remote-host" || key == "remote-login" {
			if saved.RemoteAccess() {
				fmt.Println("Remote access is on.")
			} else {
				fmt.Println("Remote access is off. It needs both remote-host and remote-login.")
			}
		}
		if key == "port" && saved.Port != port {
			fmt.Println("The port applies at the next server start. A server restart stops all sessions.")
		}
		return nil
	case args[0] == "set":
		return errors.New("provide one key and one value, for example: bbflow settings set appearance dark")
	default:
		return fmt.Errorf("unknown settings command %q\n%s", args[0], settingsUsage)
	}
}

// settingValue returns the text of one setting, in the form that settings set accepts.
// The built-in Shell is the empty default tool. A default tool whose name another tool
// has is an error, because settings set cannot select it by that name. The title tool
// has its own command, so its key is an error that names the title-tool subcommand to
// use.
func settingValue(settings history.Settings, key, titleTool string) (string, error) {
	switch key {
	case "appearance":
		return settings.Appearance, nil
	case "default-tool":
		for _, tool := range settings.Tools {
			if tool.ID == settings.DefaultTool {
				_, err := findTool(settings.Tools, tool.Name)
				return tool.Name, err
			}
		}
		return "", nil
	case "worktree":
		return strconv.FormatBool(settings.Worktree), nil
	case "base":
		return settings.Base, nil
	case "update-check":
		return strconv.FormatBool(settings.UpdateCheck), nil
	case "port":
		return strconv.Itoa(settings.Port), nil
	case "remote-host":
		return settings.RemoteHost, nil
	case "remote-login":
		return settings.RemoteLogin, nil
	case "title-tool":
		return "", fmt.Errorf("title-tool is not a settings key; use bbflow title-tool %s", titleTool)
	}
	return "", fmt.Errorf("unknown settings key %q; use appearance, default-tool, worktree, base, update-check, port, remote-host, or remote-login", key)
}

// parseSwitch reads the value of a setting that is on or off. Only true and false are
// values, as the help tells.
func parseSwitch(key, value string) (bool, error) {
	switch value {
	case "true":
		return true, nil
	case "false":
		return false, nil
	}
	return false, fmt.Errorf("%s must be true or false", key)
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
// to the new revision. It returns the saved settings.
func changeSettings(target client.Target, change func(*history.Settings) error) (history.Settings, error) {
	for attempt := 0; ; attempt++ {
		settings, err := loadSettings(target)
		if err != nil {
			return settings, err
		}
		revision := settings.Revision
		if err = change(&settings); err != nil {
			return settings, err
		}
		result, err := target.Call(protocol.Request{Operation: "settings-save", Settings: &settings})
		if err == nil {
			var saved history.Settings
			err = json.Unmarshal(result, &saved)
			return saved, err
		}
		if attempt == 2 {
			return settings, err
		}
		if latest, readErr := loadSettings(target); readErr != nil || latest.Revision == revision {
			return settings, err
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
