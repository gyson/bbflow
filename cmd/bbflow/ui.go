package main

import (
	"errors"
	"flag"
	"fmt"
	"os/exec"
	"runtime"
	"strings"

	"bbflow/internal/client"
)

// homeURL is the address of the home page. Browsers resolve localhost to the loopback
// interface. The server accepts this host name and 127.0.0.1.
func homeURL(port int) string {
	return fmt.Sprintf("http://localhost:%d/", port)
}

// ui also runs the Open UI item of the menu companion.
func ui(target client.Target, args []string) error {
	flags := flag.NewFlagSet("ui", flag.ContinueOnError)
	flags.Usage = func() {
		fmt.Println("Usage: bbflow [--dir DIR] ui\n\nOpen the running server's home page in your default browser.")
	}
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("ui takes no positional arguments")
	}
	info, err := target.Health()
	if err != nil {
		return fmt.Errorf("cannot open the UI: %w\nStart the server with bbflow --dir %q server start", err, target.Dir)
	}
	url := homeURL(info.Port)
	var opener string
	switch runtime.GOOS {
	case "darwin":
		opener = "open"
	case "linux":
		opener = "xdg-open"
	default:
		return fmt.Errorf("opening a browser is unsupported on %s; open %s manually", runtime.GOOS, url)
	}
	if output, err := exec.Command(opener, url).CombinedOutput(); err != nil {
		if detail := strings.TrimSpace(string(output)); detail != "" {
			err = fmt.Errorf("%w: %s", err, detail)
		}
		return fmt.Errorf("open default browser: %w; open %s manually", err, url)
	}
	fmt.Printf("Opened %s in your default browser.\n", url)
	return nil
}
