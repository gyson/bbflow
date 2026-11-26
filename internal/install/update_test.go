package install

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// use applies the fixture environment to this process for the update functions.
func (f *fixture) use(extra ...string) {
	f.t.Helper()
	for _, entry := range f.environment(extra...) {
		name, value, _ := strings.Cut(entry, "=")
		f.t.Setenv(name, value)
	}
}

func TestUpdateInvokedExecutable(t *testing.T) {
	for _, alias := range []bool{false, true} {
		t.Run(map[bool]string{false: "direct", true: "symlink"}[alias], func(t *testing.T) {
			f := newFixture(t)
			f.existing("0.9.0")
			f.release("0.10.0", "arm64", "0.10.0")
			executable := f.destination
			if alias {
				executable = filepath.Join(f.root, "alias")
				if err := os.Symlink(f.destination, executable); err != nil {
					t.Fatal(err)
				}
			}
			other := filepath.Join(f.root, "do-not-install-here")
			f.use("TEST_TAG=v0.10.0", "BBFLOW_INSTALL_DIR="+other)
			destination, err := Destination(executable)
			if want, _ := filepath.EvalSymlinks(f.destination); err != nil || destination != want {
				t.Fatal("destination", destination, err)
			}
			release, err := Check(destination)
			if err != nil || release != (Release{Installed: "0.9.0", Available: "0.10.0"}) || !release.Newer() {
				t.Fatalf("check: %+v %v", release, err)
			}
			var output bytes.Buffer
			if err = Install(destination, release.Available, &output, &output); err != nil || !strings.Contains(output.String(), "Installed bbflow 0.10.0") {
				t.Fatalf("install: %s %v", output.String(), err)
			}
			// bbflow update prints its own next steps.
			if strings.Contains(output.String(), "server restart") || strings.Contains(output.String(), "Start with") {
				t.Fatal("printed installer next steps", output.String())
			}
			if _, err := os.Stat(other); !os.IsNotExist(err) {
				t.Fatal("updated the environment's directory", err)
			}
			if alias {
				if target, err := os.Readlink(executable); err != nil || target != f.destination {
					t.Fatal("replaced invocation symlink", target, err)
				}
			}
		})
	}
}

func TestUpdateCheckDownloadsNoBinaries(t *testing.T) {
	for _, tc := range []struct {
		installed string
		newer     bool
	}{{"0.0.1", false}, {"0.10.0", false}, {"0.0.0", true}} {
		t.Run(tc.installed, func(t *testing.T) {
			f := newFixture(t)
			f.existing(tc.installed)
			f.use()
			before, _ := os.Stat(f.destination)
			release, err := Check(f.destination)
			if err != nil || release.Available != "0.0.1" || release.Newer() != tc.newer {
				t.Fatalf("check: %+v %v", release, err)
			}
			after, err := os.Stat(f.destination)
			if err != nil || !os.SameFile(before, after) {
				t.Fatal("check replaced the executable", err)
			}
			requests, _ := os.ReadFile(filepath.Join(f.root, "requests"))
			if strings.Contains(string(requests), "releases/assets/") {
				t.Fatal("check downloaded assets")
			}
		})
	}
}

// The server shows the reason of a failed check in the web UI. It gets the installer
// messages, not only the exit status.
func TestFailedCheckGivesTheInstallerReason(t *testing.T) {
	f := newFixture(t)
	f.existing("0.0.1")
	f.use("TEST_AUTH_FAIL=1")
	_, err := CheckContext(t.Context(), f.destination)
	if err == nil || !strings.HasPrefix(err.Error(), "cannot read release") || strings.Contains(err.Error(), "exit status") {
		t.Fatal("failed check:", err)
	}
}

func TestReleaseOrdering(t *testing.T) {
	for _, tc := range []struct {
		installed, available string
		newer                bool
	}{{"0.0.9", "0.0.10", true}, {"0.0.10", "0.0.9", false}, {"0.1.0", "0.0.99", false}, {"1.2.3", "1.2.3", false}, {"0.9.9", "1.0.0", true}} {
		if got := (Release{Installed: tc.installed, Available: tc.available}).Newer(); got != tc.newer {
			t.Errorf("%s to %s: newer %v", tc.installed, tc.available, got)
		}
	}
}

func TestUpdateRefusesRenamedExecutable(t *testing.T) {
	f := newFixture(t)
	f.existing("0.0.0")
	renamed := f.destination + "-custom"
	if err := os.Rename(f.destination, renamed); err != nil {
		t.Fatal(err)
	}
	if _, err := Destination(renamed); err == nil || !strings.Contains(err.Error(), "renamed executable") {
		t.Fatal("accepted renamed executable", err)
	}
}

func TestVersionReadsInstalledExecutable(t *testing.T) {
	f := newFixture(t)
	f.existing("0.9.0")
	if version, err := Version(f.destination); err != nil || version != "0.9.0" {
		t.Fatalf("version: %q %v", version, err)
	}
	f.existing("dev")
	if _, err := Version(f.destination); err == nil || !strings.Contains(err.Error(), "unsupported version") {
		t.Fatal("accepted a development version", err)
	}
}
