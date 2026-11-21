package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"runtime"

	"bbflow/internal/client"
	"bbflow/internal/desktop"
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
	if err := desktop.Open(context.Background(), url); err != nil {
		if errors.Is(err, desktop.ErrUnsupported) {
			return fmt.Errorf("opening a browser is unsupported on %s; open %s manually", runtime.GOOS, url)
		}
		return fmt.Errorf("open default browser: %w; open %s manually", err, url)
	}
	fmt.Printf("Opened %s in your default browser.\n", url)
	return nil
}
