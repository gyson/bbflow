package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"bbflow/internal/client"
	"bbflow/internal/install"
	"bbflow/internal/protocol"
	"golang.org/x/term"
)

// The update command starts the new executable as the updater. These variables are an
// interface between two versions. Keep their names and meaning stable.
const (
	updaterEnv         = "BBFLOW_UPDATE_CHILD"
	updaterInstanceEnv = "BBFLOW_UPDATE_INSTANCE"
)

// executablePath finds the executable that an update replaces. Tests replace it.
var executablePath = os.Executable

func update(target client.Target, args []string) error {
	if os.Getenv(updaterEnv) == "1" {
		return runUpdater(target)
	}
	flags := flag.NewFlagSet("update", flag.ContinueOnError)
	flags.Usage = func() {
		fmt.Println(`Usage: bbflow [--dir DIR] update [--yes]

Install the latest bbflow release. When a server runs in the instance directory, the
command asks for confirmation first. Then it downloads and verifies the release and
replaces this executable. Then it stops the server, which ends all of its running
sessions, starts the new version in the same directory, and opens the UI.

  --yes  Continue without the confirmation prompt.`)
	}
	yes := flags.Bool("yes", false, "continue without the confirmation prompt")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("update takes no positional arguments")
	}
	if runtime.GOOS != "darwin" {
		return errors.New("updates are available for macOS only")
	}
	if version == "dev" {
		return errors.New("development builds cannot update; install a release first")
	}
	executable, err := executablePath()
	if err != nil {
		return err
	}
	destination, err := install.Destination(executable)
	if err != nil {
		return err
	}
	release, err := install.Check(destination)
	if err != nil {
		return err
	}
	if !release.Newer() {
		fmt.Printf("bbflow %s is up to date. The latest release is %s.\n", release.Installed, release.Available)
		return nil
	}
	server, err := runningServer(&target)
	if err != nil {
		return err
	}
	if server != nil {
		fmt.Printf("Update bbflow %s to %s.\n", release.Installed, release.Available)
		fmt.Printf("This stops the bbflow server in %s and ends all of its running sessions.\n", target.Dir)
		fmt.Println("Then the new version starts in the same directory.")
		if !*yes {
			if err = confirm(); err != nil {
				return err
			}
		}
	}
	// Another update can change the executable while the question waits. The lock
	// serializes updates that share the executable, also for other instances. Check the
	// version again under the lock. The pinned install does not compare versions.
	lock, err := install.Lock(destination, os.Stderr)
	if err != nil {
		return err
	}
	defer lock.Close()
	if current, err := install.Version(destination); err != nil {
		return err
	} else if current != release.Installed {
		message := fmt.Sprintf("another command changed %s to bbflow %s; this update changed nothing", destination, current)
		if server != nil {
			message += "; to use that version, run " + command(target, "server", "restart")
		}
		return errors.New(message)
	}
	// The current server continues while the release downloads and installs.
	if err = install.Install(destination, release.Available, os.Stdout, os.Stderr); err != nil {
		return err
	}
	// Report the version that the installed executable gives, not the requested one.
	installed, err := install.Version(destination)
	if err != nil {
		return err
	}
	if installed != release.Available {
		return fmt.Errorf("the installed executable reports bbflow %s, not %s", installed, release.Available)
	}
	if server == nil {
		fmt.Printf("Updated bbflow %s to %s.\nNo bbflow server runs in %s.\nStart with: %s\nThen open:  %s\n", release.Installed, installed, target.Dir, command(target, "server", "start"), command(target, "ui"))
		return nil
	}
	if err = startUpdater(target, destination, *server, lock); err != nil {
		return err
	}
	fmt.Printf("Updated bbflow %s to %s. The server in %s runs the new version.\n", release.Installed, installed, target.Dir)
	return nil
}

// command returns a bbflow command line for the instance of target. It always names the
// directory, so that the command does not select the default instance.
func command(target client.Target, args ...string) string {
	return strings.Join(append([]string{"bbflow", "--dir", shellQuote(target.Dir)}, args...), " ")
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func confirm() error {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return errors.New("confirmation needs a terminal; use --yes to continue without it")
	}
	fmt.Print("Continue? [y/N] ")
	answer, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if answer = strings.ToLower(strings.TrimSpace(answer)); answer != "y" && answer != "yes" {
		return errors.New("update canceled; nothing changed")
	}
	return nil
}

// runningServer returns the verified server of the instance, or nil when no server
// runs. It waits for a server that is shutting down. It resolves target.Dir.
func runningServer(target *client.Target) (*protocol.ServerInfo, error) {
	if _, err := os.Stat(target.Dir); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	path, err := filepath.EvalSymlinks(target.Dir)
	if err != nil {
		return nil, err
	}
	target.Dir = path
	check, err := lockServerFile(target.Dir, "server.lock")
	if err == nil {
		check()
		return nil, nil
	}
	if !errors.Is(err, syscall.EWOULDBLOCK) {
		return nil, err
	}
	info, err := target.Identify()
	if shuttingDown(err) {
		return nil, waitServerRelease(*target)
	}
	if err != nil {
		return nil, fmt.Errorf("a server owns %s but cannot be verified: %w", target.Dir, err)
	}
	return &info, nil
}

// startUpdater starts the new executable in a separate session. The updater stops the
// server, so it must not depend on this process or its terminal. This process shows the
// updater log until the updater ends.
// The updater receives lock as file 3 and holds it until it ends. Thus the lock
// continues when this process ends early, for example after Ctrl+C.
func startUpdater(target client.Target, executable string, server protocol.ServerInfo, lock *os.File) error {
	logPath := filepath.Join(target.Dir, "update.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	stat, err := logFile.Stat()
	if err != nil {
		return err
	}
	cmd := exec.Command(executable, "--dir", target.Dir, "update")
	// The updater starts the server, and the server passes its environment to each
	// session. GITHUB_TOKEN is only for release requests, so it must not reach them.
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "GITHUB_TOKEN=") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, updaterEnv+"=1", updaterInstanceEnv+"="+server.Instance)
	cmd.Dir = target.Dir
	cmd.Stdout, cmd.Stderr = logFile, logFile
	cmd.ExtraFiles = []*os.File{lock}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	// Stop following on an interrupt. The updater continues in its own session.
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(interrupt)
	if err = cmd.Start(); err != nil {
		return err
	}
	fmt.Printf("Restarting the server in %s. Log: %s\n", target.Dir, logPath)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	if err = followUpdater(logPath, stat.Size(), done, interrupt); err != nil {
		return err
	}
	// Do not trust the exit status alone. Confirm that a different server now runs. The
	// new server can use a newer protocol than this executable.
	if info, err := target.Identify(); err != nil || info.Instance == server.Instance {
		return fmt.Errorf("the new version is installed, but no new server answers in %s; see %s; then run %s", target.Dir, logPath, command(target, "server", "start"))
	}
	return nil
}

func followUpdater(logPath string, offset int64, done <-chan error, interrupt <-chan os.Signal) error {
	file, err := os.Open(logPath)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err = file.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		io.Copy(os.Stdout, file)
		select {
		case err := <-done:
			io.Copy(os.Stdout, file)
			if err != nil {
				return fmt.Errorf("the new version is installed, but the server restart failed; see %s; then run %s", logPath, command(client.Target{Dir: filepath.Dir(logPath)}, "server", "start"))
			}
			return nil
		case <-interrupt:
			return fmt.Errorf("stopped the log display; the update continues; see %s", logPath)
		case <-ticker.C:
		}
	}
}

// runUpdater runs in the new executable. It stops only the server that the user
// confirmed, then starts this version and opens the UI. Its output goes to update.log.
func runUpdater(target client.Target) error {
	expected := os.Getenv(updaterInstanceEnv)
	for _, name := range []string{updaterEnv, updaterInstanceEnv} {
		os.Unsetenv(name)
	}
	// The terminal that started the update can close when its server stops.
	signal.Ignore(syscall.SIGHUP, syscall.SIGINT)
	// The command passes its installation lock as file 3. Hold it until the restart
	// ends. The server and its sessions must not inherit it, so close it on exec.
	lock := os.NewFile(3, "installation-lock")
	if stat, err := lock.Stat(); err != nil || !stat.IsDir() {
		return errors.New("the updater needs the installation lock of its command as file 3")
	}
	syscall.CloseOnExec(3)
	defer lock.Close()
	fmt.Printf("%s: update the server in %s to bbflow %s.\n", time.Now().Format(time.RFC3339), target.Dir, version)
	if expected == "" {
		return errors.New("the updater needs the instance of the confirmed server")
	}
	var unlock func()
	var err error
	for deadline := time.Now().Add(15 * time.Second); ; {
		if unlock, err = lockServerFile(target.Dir, "server-control.lock"); err == nil || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err != nil {
		return fmt.Errorf("another server lifecycle command is in progress: %w", err)
	}
	defer unlock()
	if err = stopConfirmedServer(target, expected); err != nil {
		return err
	}
	if err = startServer(target); err != nil {
		return err
	}
	if err = ui(target, nil); err != nil {
		fmt.Fprintln(os.Stderr, "bbflow:", err)
	}
	return nil
}

func stopConfirmedServer(target client.Target, expected string) error {
	check, err := lockServerFile(target.Dir, "server.lock")
	if err == nil {
		check()
		fmt.Printf("The server in %s has already stopped.\n", target.Dir)
		return nil
	}
	if !errors.Is(err, syscall.EWOULDBLOCK) {
		return err
	}
	info, err := target.Identify()
	if err == nil && info.Instance != expected {
		return fmt.Errorf("another server now runs in %s and was not stopped; to use the new version, run %s", target.Dir, command(target, "server", "restart"))
	}
	if err != nil && !shuttingDown(err) {
		return fmt.Errorf("a server owns %s but cannot be verified: %w", target.Dir, err)
	}
	// StopInstance checks the identity again on the connection that sends the request.
	if err == nil {
		if err = client.StopInstance(info); err != nil && !shuttingDown(err) {
			return fmt.Errorf("stop server in %s: %w", target.Dir, err)
		}
	}
	if err = waitServerRelease(target); err != nil {
		return err
	}
	fmt.Printf("Stopped bbflow in %s.\n", target.Dir)
	return nil
}
