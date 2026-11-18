package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"bbflow/internal/client"
	"bbflow/internal/install"
	"bbflow/internal/protocol"
	"github.com/creack/pty"
)

func TestUpdateCommand(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "absent")
	unsupported := "development builds cannot update"
	if runtime.GOOS != "darwin" {
		unsupported = "macOS only"
	}
	for _, tc := range []struct {
		args []string
		want string
		ok   bool
	}{
		{[]string{"--help"}, "Usage: bbflow [--dir DIR] update", true},
		{nil, unsupported, false},
		{[]string{"extra"}, "takes no positional arguments", false},
		{[]string{"--version", "0.0.1"}, "flag provided but not defined", false},
	} {
		command := testCommand(append([]string{"--dir", directory, "update"}, tc.args...)...)
		output, err := command.CombinedOutput()
		if (err == nil) != tc.ok || !strings.Contains(string(output), tc.want) {
			t.Fatalf("%v: %s %v", tc.args, output, err)
		}
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatal("update accessed the instance", err)
	}
}

// updateFixture installs bbflow 0.0.1 and publishes a synthetic 0.0.2 release. Both
// versions run this test binary. A fake curl serves the release. No test contacts
// GitHub.
type updateFixture struct {
	t                         *testing.T
	root, assets, destination string
	env                       []string
}

func newUpdateFixture(t *testing.T) *updateFixture {
	t.Helper()
	if runtime.GOOS != "darwin" {
		t.Skip("updates are available for macOS only")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &updateFixture{t: t, root: root, assets: filepath.Join(root, "assets"), destination: filepath.Join(root, "install dir", "bbflow")}
	tools := filepath.Join(root, "tools")
	for _, directory := range []string{f.assets, tools, filepath.Dir(f.destination)} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	f.write(filepath.Join(tools, "curl"), `#!/bin/sh
cat > /dev/null
printf '%s\n' "$*" >> "$TEST_ASSETS/requests"
output= url=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --output) output=$2; shift 2 ;;
        https://*) url=$1; shift ;;
        *) shift ;;
    esac
done
case "$url" in
    */releases/latest|*/releases/tags/v0.0.2) cp "$TEST_ASSETS/release.json" "$output" ;;
    */releases/assets/1) cp "$TEST_ASSETS/release.tar.gz" "$output" ;;
    */releases/assets/2) cp "$TEST_ASSETS/checksums.txt" "$output" ;;
    *) exit 6 ;;
esac
`)
	f.write(f.destination, f.binary("0.0.1"))
	asset := "bbflow_0.0.2_darwin_" + runtime.GOARCH + ".tar.gz"
	f.archive(f.binary("0.0.2"))
	data, err := os.ReadFile(filepath.Join(f.assets, "release.tar.gz"))
	if err != nil {
		t.Fatal(err)
	}
	f.write(filepath.Join(f.assets, "checksums.txt"), fmt.Sprintf("%x  %s\n", sha256.Sum256(data), asset))
	metadata, _ := json.Marshal(map[string]any{
		"tag_name": "v0.0.2",
		"assets":   []map[string]any{{"name": asset, "id": 1}, {"name": "checksums.txt", "id": 2}},
	})
	f.write(filepath.Join(f.assets, "release.json"), string(metadata))
	f.env = append(os.Environ(), "PATH="+tools+string(os.PathListSeparator)+os.Getenv("PATH"),
		"TMPDIR="+root, "TEST_ASSETS="+f.assets, "GITHUB_TOKEN=")
	return f
}

// binary runs this test binary as the CLI of one release version.
func (f *updateFixture) binary(version string) string {
	executable, err := os.Executable()
	if err != nil {
		f.t.Fatal(err)
	}
	return fmt.Sprintf("#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'bbflow %s\\n'; exit 0; fi\nBBFLOW_TEST_CLI=1 BBFLOW_TEST_VERSION=%s BBFLOW_TEST_EXECUTABLE=\"$0\" exec '%s' \"$@\"\n", version, version, executable)
}

func (f *updateFixture) archive(binary string) {
	f.t.Helper()
	file, err := os.Create(filepath.Join(f.assets, "release.tar.gz"))
	if err != nil {
		f.t.Fatal(err)
	}
	gz := gzip.NewWriter(file)
	tw := tar.NewWriter(gz)
	if err = tw.WriteHeader(&tar.Header{Name: "bbflow", Mode: 0755, Size: int64(len(binary))}); err == nil {
		_, err = tw.Write([]byte(binary))
	}
	for _, closeErr := range []error{tw.Close(), gz.Close(), file.Close()} {
		if err == nil {
			err = closeErr
		}
	}
	if err != nil {
		f.t.Fatal(err)
	}
}

func (f *updateFixture) write(path, data string) {
	f.t.Helper()
	if err := os.WriteFile(path, []byte(data), 0755); err != nil {
		f.t.Fatal(err)
	}
}

func (f *updateFixture) command(args ...string) *exec.Cmd {
	command := exec.Command(f.destination, args...)
	command.Env = f.env
	return command
}

func (f *updateFixture) installed() string {
	f.t.Helper()
	output, err := f.command("--version").Output()
	if err != nil {
		f.t.Fatal(err)
	}
	return strings.TrimSpace(string(output))
}

func (f *updateFixture) downloads() bool {
	requests, _ := os.ReadFile(filepath.Join(f.assets, "requests"))
	return strings.Contains(string(requests), "releases/assets/")
}

func (f *updateFixture) startServer(directory string) client.Target {
	f.t.Helper()
	f.t.Cleanup(func() { testCommand("--dir", directory, "server", "stop").Run() })
	if output, err := f.command("--dir", directory, "server", "start").CombinedOutput(); err != nil {
		f.t.Fatalf("start: %s %v", output, err)
	}
	return client.Target{Dir: directory}
}

func TestUpdateRestartsConfirmedServer(t *testing.T) {
	argsPath := browserFixture(t)
	f := newUpdateFixture(t)
	directory := filepath.Join(f.root, "instance")
	target := f.startServer(directory)
	before, err := target.Health()
	if err != nil {
		t.Fatal(err)
	}
	// The token is only for release requests. Its synthetic value must not reach the
	// sessions of the new server.
	update := f.command("--dir", directory, "update", "--yes")
	update.Env = append(update.Env, "GITHUB_TOKEN=synthetic_update_token")
	output, err := update.CombinedOutput()
	if err != nil {
		t.Fatalf("update: %s %v", output, err)
	}
	for _, want := range []string{"Update bbflow 0.0.1 to 0.0.2.", "ends all of its running sessions", "Installed bbflow 0.0.2", "Stopped bbflow in", "bbflow is running at", "Opened http://"} {
		if !strings.Contains(string(output), want) {
			t.Fatalf("missing %q in update output:\n%s", want, output)
		}
	}
	// The last line reports the version that the new executable gives.
	if lines := strings.Split(strings.TrimSpace(string(output)), "\n"); lines[len(lines)-1] != "Updated bbflow 0.0.1 to 0.0.2. The server in "+directory+" runs the new version." {
		t.Fatalf("final update line: %q", lines[len(lines)-1])
	}
	// The fake curl must serve the download. A real request would reach GitHub.
	if !f.downloads() || f.installed() != "bbflow 0.0.2" {
		t.Fatal("executable not replaced from the fixture:", f.installed())
	}
	after, err := target.Health()
	if err != nil || after.Instance == before.Instance || after.PID == before.PID {
		t.Fatalf("server not replaced: %+v %v", after, err)
	}
	args, err := os.ReadFile(argsPath)
	if want := fmt.Sprintf("http://127.0.0.1:%d/\n", after.Port); err != nil || string(args) != want {
		t.Fatalf("browser must open the new server: %q %v", args, err)
	}
	log, err := os.ReadFile(filepath.Join(directory, "update.log"))
	if err != nil || !strings.Contains(string(log), "to bbflow 0.0.2") {
		t.Fatalf("update log: %s %v", log, err)
	}
	t.Setenv("BBFLOW_DIR", directory)
	// The fixture wrapper is a script, so the shell has its default prompt. The shell can
	// discard input that comes before its prompt.
	shell := openSessionView(t, shellStartRequest(t, t.TempDir(), "", protocol.Size{Rows: 24, Cols: 80}))
	waitFor(t, func() bool { return strings.Contains(shell.text(), "$ ") })
	if _, err = shell.Write([]byte("printf 'token=[%s]\\n' \"${GITHUB_TOKEN-unset}\"\r")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		return strings.Contains(shell.text(), "token=[unset]") || strings.Contains(shell.text(), "token=[synthetic")
	})
	if !strings.Contains(shell.text(), "token=[unset]") {
		t.Fatalf("the new server passed the download token to a session:\n%s", shell.text())
	}
	shell.Close()
	// A current executable changes nothing and restarts nothing.
	output, err = f.command("--dir", directory, "update", "--yes").CombinedOutput()
	if err != nil || !strings.Contains(string(output), "up to date") {
		t.Fatalf("current update: %s %v", output, err)
	}
	if same, _ := target.Health(); same.Instance != after.Instance {
		t.Fatal("current update restarted the server")
	}
}

func TestUpdateNeedsConfirmationBeforeDownload(t *testing.T) {
	f := newUpdateFixture(t)
	directory := filepath.Join(f.root, "instance")
	target := f.startServer(directory)
	before, err := target.Health()
	if err != nil {
		t.Fatal(err)
	}
	// Standard input is not a terminal. Without --yes, the update must stop here.
	output, err := f.command("--dir", directory, "update").CombinedOutput()
	if err == nil || !strings.Contains(string(output), "use --yes") {
		t.Fatalf("update without confirmation: %s %v", output, err)
	}
	if f.downloads() || f.installed() != "bbflow 0.0.1" {
		t.Fatal("update downloaded or installed without confirmation")
	}
	if same, err := target.Health(); err != nil || same.Instance != before.Instance {
		t.Fatalf("server changed without confirmation: %+v %v", same, err)
	}
}

func TestUpdateWithoutServerOnlyInstalls(t *testing.T) {
	f := newUpdateFixture(t)
	// The hints must name this instance, not the default instance of the environment.
	directory := filepath.Join(f.root, "absent instance")
	f.env = append(f.env, "BBFLOW_DIR="+filepath.Join(f.root, "default"))
	output, err := f.command("--dir", directory, "update").CombinedOutput()
	if err != nil || !strings.Contains(string(output), "Updated bbflow 0.0.1 to 0.0.2.\nNo bbflow server runs") || f.installed() != "bbflow 0.0.2" {
		t.Fatalf("update without server: %s %v", output, err)
	}
	for _, want := range []string{"Start with: bbflow --dir '" + directory + "' server start", "Then open:  bbflow --dir '" + directory + "' ui"} {
		if !strings.Contains(string(output), want) {
			t.Fatalf("missing %q in hints:\n%s", want, output)
		}
	}
	if _, err = os.Stat(directory); !os.IsNotExist(err) {
		t.Fatal("update created the instance directory", err)
	}
}

func TestUpdaterStopsOnlyConfirmedServer(t *testing.T) {
	directory := t.TempDir()
	startTestServer(t, directory)
	before, err := (client.Target{Dir: directory}).Health()
	if err != nil {
		t.Fatal(err)
	}
	command := testCommand("--dir", directory, "update")
	command.Env = append(command.Env, updaterEnv+"=1", updaterInstanceEnv+"=another-instance")
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "was not stopped") || !strings.Contains(string(output), "run bbflow --dir '"+directory+"' server restart") {
		t.Fatalf("updater accepted another server: %s %v", output, err)
	}
	if same, err := (client.Target{Dir: directory}).Health(); err != nil || same.Instance != before.Instance {
		t.Fatalf("updater changed another server: %+v %v", same, err)
	}
}

func TestUpdatePromptCancelChangesNothing(t *testing.T) {
	f := newUpdateFixture(t)
	directory := filepath.Join(f.root, "instance")
	target := f.startServer(directory)
	before, err := target.Health()
	if err != nil {
		t.Fatal(err)
	}
	command := f.command("--dir", directory, "update")
	tty, err := pty.Start(command)
	if err != nil {
		t.Fatal(err)
	}
	defer tty.Close()
	var output lockedBuffer
	read := make(chan struct{})
	go func() { io.Copy(&output, tty); close(read) }()
	waitFor(t, func() bool { return strings.Contains(output.String(), "Continue? [y/N]") })
	if _, err = tty.Write([]byte("n\r")); err != nil {
		t.Fatal(err)
	}
	if err = command.Wait(); err == nil {
		t.Fatal("canceled update succeeded")
	}
	<-read
	if !strings.Contains(output.String(), "update canceled; nothing changed") {
		t.Fatalf("cancel output: %s", output.String())
	}
	if f.downloads() || f.installed() != "bbflow 0.0.1" {
		t.Fatal("canceled update downloaded or installed")
	}
	if same, err := target.Health(); err != nil || same.Instance != before.Instance {
		t.Fatalf("canceled update changed the server: %+v %v", same, err)
	}
}

type lockedBuffer struct {
	mu   sync.Mutex
	data strings.Builder
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.data.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.data.String()
}

// Another update can install a newer version while the question waits. This update must
// keep that version and leave the server unchanged.
func TestUpdateKeepsNewerVersionInstalledDuringPrompt(t *testing.T) {
	f := newUpdateFixture(t)
	directory := filepath.Join(f.root, "instance")
	target := f.startServer(directory)
	before, err := target.Health()
	if err != nil {
		t.Fatal(err)
	}
	command := f.command("--dir", directory, "update")
	tty, err := pty.Start(command)
	if err != nil {
		t.Fatal(err)
	}
	defer tty.Close()
	var output lockedBuffer
	read := make(chan struct{})
	go func() { io.Copy(&output, tty); close(read) }()
	waitFor(t, func() bool { return strings.Contains(output.String(), "Continue? [y/N]") })
	newer := f.destination + ".newer"
	f.write(newer, f.binary("0.0.3"))
	if err = os.Rename(newer, f.destination); err != nil {
		t.Fatal(err)
	}
	if _, err = tty.Write([]byte("y\r")); err != nil {
		t.Fatal(err)
	}
	if err = command.Wait(); err == nil {
		t.Fatal("update replaced a version that another command installed")
	}
	<-read
	if !strings.Contains(output.String(), "changed "+f.destination+" to bbflow 0.0.3") || !strings.Contains(output.String(), "run bbflow --dir '"+directory+"' server restart") {
		t.Fatalf("output: %s", output.String())
	}
	if f.downloads() || f.installed() != "bbflow 0.0.3" {
		t.Fatal("update downloaded or replaced the newer version:", f.installed())
	}
	if same, err := target.Health(); err != nil || same.Instance != before.Instance {
		t.Fatalf("update changed the server: %+v %v", same, err)
	}
}

// Updates that share the executable run one at a time, also for other instances.
func TestUpdateWaitsForAnotherUpdate(t *testing.T) {
	f := newUpdateFixture(t)
	unlock, err := install.Lock(f.destination, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	command := f.command("--dir", filepath.Join(f.root, "absent"), "update")
	var output lockedBuffer
	command.Stdout, command.Stderr = &output, &output
	if err = command.Start(); err != nil {
		unlock()
		t.Fatal(err)
	}
	waitFor(t, func() bool { return strings.Contains(output.String(), "Waiting for another bbflow update") })
	if f.downloads() {
		t.Fatal("update downloaded before the other update finished")
	}
	unlock()
	if err = command.Wait(); err != nil || f.installed() != "bbflow 0.0.2" {
		t.Fatalf("update after the wait: %s %v", output.String(), err)
	}
}
