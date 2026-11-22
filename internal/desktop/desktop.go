// Package desktop opens a URL with the default application of the user, opens a file in
// the default web browser, or shows a file in Finder.
package desktop

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ErrUnsupported reports an operating system without a known opener.
var ErrUnsupported = errors.New("opening files is unsupported")

// Open runs `open` on macOS or `xdg-open` on Linux with target. The operating system
// chooses the application from the URL scheme or the file type. A target must not start
// with "-", so that the opener does not read it as an option.
func Open(ctx context.Context, target string) error {
	var name string
	switch runtime.GOOS {
	case "darwin":
		name = "open"
	case "linux":
		name = "xdg-open"
	default:
		return fmt.Errorf("%w on %s", ErrUnsupported, runtime.GOOS)
	}
	if strings.HasPrefix(target, "-") {
		return fmt.Errorf("invalid target %q", target)
	}
	_, err := run(ctx, name, target)
	return err
}

// browserScript prints the path of the application that opens https URLs. This is the
// default browser that the user selected in System Settings. It prints nothing when
// there is no such application.
const browserScript = `ObjC.import("AppKit"); ` +
	`const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.invalid/")); ` +
	`app.isNil() ? "" : app.path.js`

// OpenInBrowser opens a local file in the default web browser. The browser and not the
// file type selects the application. Thus an editor that owns HTML files does not open
// the file, and a file of another type does not run as a program. Only macOS has this
// opener now.
func OpenInBrowser(ctx context.Context, path string) error {
	if runtime.GOOS != "darwin" {
		return fmt.Errorf("%w: a file opens in the browser only on macOS", ErrUnsupported)
	}
	if !filepath.IsAbs(path) {
		return fmt.Errorf("the file path %q is not absolute", path)
	}
	output, err := run(ctx, "osascript", "-l", "JavaScript", "-e", browserScript)
	if err != nil {
		return fmt.Errorf("find the default browser: %w", err)
	}
	browser := strings.TrimSpace(output)
	if !filepath.IsAbs(browser) || !strings.HasSuffix(browser, ".app") {
		return errors.New("no default browser is set")
	}
	_, err = run(ctx, "open", "-a", browser, path)
	return err
}

// Reveal shows a file or a folder in a Finder window and selects it. Finder does not
// open the item. Only macOS has this opener now.
func Reveal(ctx context.Context, path string) error {
	if runtime.GOOS != "darwin" {
		return fmt.Errorf("%w: a file shows in Finder only on macOS", ErrUnsupported)
	}
	if !filepath.IsAbs(path) {
		return fmt.Errorf("the file path %q is not absolute", path)
	}
	_, err := run(ctx, "open", "-R", path)
	return err
}

// run runs a command and returns its standard output. An error includes the output of
// the command. An opener can start an application that keeps the output pipes open
// after the opener exits with success. WaitDelay then ends the wait, and the run is a
// success.
func run(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	if errors.Is(err, exec.ErrWaitDelay) {
		err = nil
	}
	if err != nil {
		if detail := strings.TrimSpace(stderr.String() + "\n" + stdout.String()); detail != "" {
			err = fmt.Errorf("%w: %s", err, detail)
		}
		return "", err
	}
	return stdout.String(), nil
}
