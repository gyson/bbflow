// Package install shares the release installer with the update command.
package install

import (
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
)

//go:embed install.sh
var script string

// Release compares the installed executable with the latest release.
type Release struct {
	Installed, Available string
}

// Newer reports whether the available release is newer than the installed executable.
func (r Release) Newer() bool {
	installed, available := strings.Split(r.Installed, "."), strings.Split(r.Available, ".")
	for i := range 3 {
		a, _ := strconv.Atoi(available[i])
		c, _ := strconv.Atoi(installed[i])
		if a != c {
			return a > c
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
	var release Release
	command := installer(destination, "--check")
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

// Lock serializes updates of the executables in the directory of destination. It
// waits for an update that another command runs, and tells waiting about the wait. It
// locks the directory itself, so it creates no file. Call the returned function to
// release the lock.
func Lock(destination string, waiting io.Writer) (func(), error) {
	directory, err := os.Open(filepath.Dir(destination))
	if err != nil {
		return nil, err
	}
	fd := int(directory.Fd())
	err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		fmt.Fprintf(waiting, "Waiting for another bbflow update in %s to finish.\n", filepath.Dir(destination))
		for err = syscall.Flock(fd, syscall.LOCK_EX); errors.Is(err, syscall.EINTR); {
			err = syscall.Flock(fd, syscall.LOCK_EX)
		}
	}
	if err != nil {
		directory.Close()
		return nil, err
	}
	return func() { directory.Close() }, nil
}

// Install downloads and verifies one release, then renames it over destination.
// Failures before the rename preserve the installed executable.
func Install(destination, version string, stdout, stderr io.Writer) error {
	command := installer(destination, "--version", version, "--no-next-steps")
	command.Stdout, command.Stderr = stdout, stderr
	return command.Run()
}

// installer runs the embedded script for the directory of destination. It never
// downloads or runs a remote installer script.
func installer(destination string, args ...string) *exec.Cmd {
	command := exec.Command("/bin/sh", append([]string{"-s", "--", "--dir", filepath.Dir(destination)}, args...)...)
	command.Stdin = strings.NewReader(script)
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
