// Package desktop opens a file or a URL with the default application of the user.
package desktop

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
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
	cmd := exec.CommandContext(ctx, name, target)
	// An application that the opener starts can keep the output pipe open. Do not wait
	// for it after the opener exits.
	cmd.WaitDelay = time.Second
	if output, err := cmd.CombinedOutput(); err != nil {
		if detail := strings.TrimSpace(string(output)); detail != "" {
			err = fmt.Errorf("%w: %s", err, detail)
		}
		return err
	}
	return nil
}
