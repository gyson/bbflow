package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"bbflow/internal/client"
)

const usage = `Usage:
  bbflow --version
  bbflow update
  bbflow [--dir DIR] server start|stop|restart
  bbflow [--dir DIR] ui
  bbflow [--dir DIR] query SQL
  bbflow skill

--dir selects a bbflow instance, not the agent's working directory.
Start the server with bbflow server start, then open bbflow ui.
Create and manage interactive shell sessions in the web UI.
Closing a browser view leaves its session running.
Agents: run bbflow skill to learn how to read sessions and recorded history.`

// Local builds use development storage. The release target sets this at link time.
var instanceDirName = ".bbflow-dev"

// Release builds set the version from their tag.
var version = "dev"

func main() {
	if err := run(os.Args[1:]); err != nil && !errors.Is(err, flag.ErrHelp) {
		fmt.Fprintln(os.Stderr, "bbflow:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	flags := flag.NewFlagSet("bbflow", flag.ContinueOnError)
	flags.Usage = func() { fmt.Println(usage) }
	directory := flags.String("dir", defaultInstanceDir(), "bbflow instance directory")
	showVersion := flags.Bool("version", false, "Print the executable version")
	if err := flags.Parse(args); err != nil {
		return err
	}
	args = flags.Args()
	if *showVersion {
		if len(args) != 0 {
			return errors.New("--version takes no command or arguments")
		}
		fmt.Println("bbflow", version)
		return nil
	}
	if len(args) == 0 || args[0] == "help" {
		fmt.Println(usage)
		return nil
	}
	switch args[0] {
	case "update":
		return update(args[1:])
	case "skill":
		return skill(args[1:])
	}
	path, err := filepath.Abs(*directory)
	if err != nil {
		return err
	}
	target := client.Target{Dir: path}
	switch args[0] {
	case "server":
		return serverCommand(target, args[1:])
	case "ui":
		return ui(target, args[1:])
	case "query":
		return query(target, args[1:])
	default:
		return fmt.Errorf("unknown command %q\n%s", args[0], usage)
	}
}

func defaultInstanceDir() string {
	if directory := os.Getenv("BBFLOW_DIR"); directory != "" {
		return directory
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, instanceDirName)
}
