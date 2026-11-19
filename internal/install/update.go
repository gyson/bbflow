// Package install shares the release installer with the update command.
package install

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

//go:embed install.sh
var script string

// Release compares the installed executable with the latest release.
type Release struct {
	Installed, Available string
}

// Newer reports whether the available release is newer than the installed executable.
func (r Release) Newer() bool { return Newer(r.Available, r.Installed) }

// Newer reports whether release version a is newer than release version b.
func Newer(a, b string) bool {
	first, second := strings.Split(a, "."), strings.Split(b, ".")
	for i := range 3 {
		x, _ := strconv.Atoi(first[i])
		y, _ := strconv.Atoi(second[i])
		if x != y {
			return x > y
		}
	}
	return false
}

// Destination resolves the executable that an update replaces. The command can use a
// symlink. The update replaces the actual file.
func Destination(executable string) (string, error) {
	executable, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return "", err
	}
	if filepath.Base(executable) != "bbflow" {
		return "", fmt.Errorf("cannot update a renamed executable: %s; reinstall bbflow instead", executable)
	}
	return executable, nil
}

// Check reads the latest release. It downloads no binaries and changes no files.
func Check(destination string) (Release, error) {
	return check(installer(context.Background(), destination, "--check"))
}

// CheckContext is Check for a caller without a terminal, such as the server. The end
// of ctx stops the check. See background.
func CheckContext(ctx context.Context, destination string) (Release, error) {
	return check(background(installer(ctx, destination, "--check")))
}

func check(command *exec.Cmd) (Release, error) {
	var release Release
	command.Stderr = os.Stderr
	output, err := command.Output()
	if err != nil {
		return release, err
	}
	for _, line := range strings.Split(string(output), "\n") {
		if value, ok := strings.CutPrefix(line, "Available release: "); ok {
			release.Available = value
		}
		if value, ok := strings.CutPrefix(line, "Installed version: "); ok {
			release.Installed = value
		}
	}
	if !valid(release.Available) || !valid(release.Installed) {
		return release, errors.New("the installer did not report the installed and available versions")
	}
	return release, nil
}

// Version runs destination and returns the release version that it reports.
func Version(destination string) (string, error) {
	output, err := exec.Command(destination, "--version").Output()
	if err != nil {
		return "", fmt.Errorf("cannot read the version of %s: %w", destination, err)
	}
	version, ok := strings.CutPrefix(strings.TrimSpace(string(output)), "bbflow ")
	if !ok || !valid(version) {
		return "", fmt.Errorf("%s reports an unsupported version: %q", destination, strings.TrimSpace(string(output)))
	}
	return version, nil
}

// ErrBusy reports that another update of the same executable runs now.
var ErrBusy = errors.New("another bbflow update runs now; try again after it ends")

// Lock serializes updates of the executables in the directory of destination. It
// waits for an update that another command runs, and tells waiting about the wait. A
// nil waiting does not wait and returns ErrBusy. Lock locks the directory itself, so it
// creates no file. The lock belongs to the open directory. It ends when every process
// closes its copy of the returned file.
func Lock(destination string, waiting io.Writer) (*os.File, error) {
	directory, err := os.Open(filepath.Dir(destination))
	if err != nil {
		return nil, err
	}
	fd := int(directory.Fd())
	err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) && waiting == nil {
		err = ErrBusy
	} else if errors.Is(err, syscall.EWOULDBLOCK) {
		fmt.Fprintf(waiting, "Waiting for another bbflow update in %s to finish.\n", filepath.Dir(destination))
		for err = syscall.Flock(fd, syscall.LOCK_EX); errors.Is(err, syscall.EINTR); {
			err = syscall.Flock(fd, syscall.LOCK_EX)
		}
	}
	if err != nil {
		directory.Close()
		return nil, err
	}
	return directory, nil
}

// Install downloads and verifies one release, then renames it over destination.
// Failures before the rename preserve the installed executable.
func Install(destination, version string, stdout, stderr io.Writer) error {
	command := installer(context.Background(), destination, "--version", version, "--no-next-steps")
	command.Stdout, command.Stderr = stdout, stderr
	return command.Run()
}

// InstallContext is Install for a caller without a terminal, such as the server. The
// installer writes its output to output. The end of ctx stops the installer. See
// background. An error gives the reason that the installer reported, when it gave one.
func InstallContext(ctx context.Context, destination, version string, output io.Writer) error {
	var stderr bytes.Buffer
	command := background(installer(ctx, destination, "--version", version, "--no-next-steps"))
	command.Stdout, command.Stderr = output, io.MultiWriter(output, &stderr)
	err := command.Run()
	if err != nil && ctx.Err() == nil {
		lines := strings.Split(strings.TrimSpace(stderr.String()), "\n")
		if reason, ok := strings.CutPrefix(lines[len(lines)-1], "bbflow installer: "); ok {
			return errors.New(reason)
		}
	}
	return err
}

// installer runs the embedded script for the directory of destination. It never
// downloads or runs a remote installer script.
func installer(ctx context.Context, destination string, args ...string) *exec.Cmd {
	command := exec.CommandContext(ctx, "/bin/sh", append([]string{"-s", "--", "--dir", filepath.Dir(destination)}, args...)...)
	command.Stdin = strings.NewReader(script)
	return command
}

// background runs the script in its own process group. Then the end of its context
// stops the script and its curl requests together, and the script removes its
// temporary files. A terminal Ctrl+C does not reach that group, so only a caller
// without a terminal uses it.
func background(command *exec.Cmd) *exec.Cmd {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error { return syscall.Kill(-command.Process.Pid, syscall.SIGTERM) }
	command.WaitDelay = 5 * time.Second
	return command
}

func valid(version string) bool {
	parts := strings.Split(version, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if _, err := strconv.ParseUint(part, 10, 32); err != nil || (len(part) > 1 && part[0] == '0') {
			return false
		}
	}
	return true
}
