package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"bbflow/internal/client"
	"bbflow/internal/history"
)

// bbflow was named BonBon before. Release builds used ~/.bonbon and local builds used
// ~/.bonbon-dev.
func defaultBonBonDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, strings.Replace(instanceDirName, ".bbflow", ".bonbon", 1))
}

func migrateCommand(target client.Target, args []string) error {
	flags := flag.NewFlagSet("migrate", flag.ContinueOnError)
	from := flags.String("from", defaultBonBonDir(), "BonBon instance directory to copy")
	flags.Usage = func() {
		fmt.Printf("Usage: bbflow [--dir DIR] migrate [--from DIR]\n\n" +
			"Copy the history of a stopped BonBon instance into a new bbflow instance.\n" +
			"The BonBon data is not changed. Default --from: %s\n", defaultBonBonDir())
	}
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("migrate takes no positional arguments")
	}
	source, err := filepath.Abs(*from)
	if err != nil {
		return err
	}
	if source, err = filepath.EvalSymlinks(source); err != nil {
		return fmt.Errorf("no BonBon instance at %s: %w", *from, err)
	}
	database := filepath.Join(source, "history.sqlite")
	if _, err = os.Stat(database); err != nil {
		return fmt.Errorf("no BonBon history in %s: %w", source, err)
	}
	if path, err := filepath.EvalSymlinks(target.Dir); err == nil && path == source {
		return errors.New("the BonBon and bbflow directories are the same; use another --dir")
	}

	// Hold the BonBon archive lock, so that no BonBon server writes during the copy.
	// Do not create a lock file in the BonBon directory.
	unlockSource, err := lockExistingFile(filepath.Join(source, "server.lock"))
	if err != nil {
		return err
	}
	defer unlockSource()
	// Hold the bbflow locks, so that no bbflow server starts on a partial copy.
	if err = os.MkdirAll(target.Dir, 0700); err != nil {
		return err
	}
	if target.Dir, err = filepath.EvalSymlinks(target.Dir); err != nil {
		return err
	}
	unlockControl, err := lockServerFile(target.Dir, "server-control.lock")
	if err != nil {
		return fmt.Errorf("another server lifecycle command is in progress: %w", err)
	}
	defer unlockControl()
	unlockTarget, err := lockServerFile(target.Dir, "server.lock")
	if err != nil {
		return fmt.Errorf("a bbflow server is running in %s; run bbflow server stop first", target.Dir)
	}
	defer unlockTarget()

	report, err := history.CopyFrom(database, filepath.Join(target.Dir, "history.sqlite"))
	if err != nil {
		return err
	}
	fmt.Printf("Copied BonBon history from %s to %s.\n", source, target.Dir)
	fmt.Printf("Source format %d: %d sessions, %d terminals, %d events.\n",
		report.Format, report.Rows["sessions"], report.Rows["runs"], report.Rows["events"])
	fmt.Println("The BonBon data was not changed.")
	if len(report.Folders) != 0 {
		fmt.Println("\nCopied sessions use these folders in the BonBon directory. Keep them until you finish with those sessions:")
		for _, folder := range report.Folders {
			fmt.Println("  " + folder)
		}
	}
	fmt.Println("\nStart bbflow with: bbflow server start")
	return nil
}

func lockExistingFile(path string) (func(), error) {
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if errors.Is(err, os.ErrNotExist) {
		return func() {}, nil
	}
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, fmt.Errorf("BonBon is running in %s; run bonbon server stop first", filepath.Dir(path))
		}
		return nil, err
	}
	return func() { file.Close() }, nil
}

// checkBonBonHistory stops a first server start in the default instance when BonBon
// history exists. Without this check, a later migrate cannot copy into the new instance.
func checkBonBonHistory(target client.Target) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	defaultDir, err := filepath.EvalSymlinks(filepath.Join(home, instanceDirName))
	if err != nil || defaultDir != target.Dir {
		return nil
	}
	if _, err = os.Lstat(filepath.Join(target.Dir, "history.sqlite")); !errors.Is(err, os.ErrNotExist) {
		return nil
	}
	source := defaultBonBonDir()
	if _, err = os.Stat(filepath.Join(source, "history.sqlite")); err != nil {
		return nil
	}
	return fmt.Errorf("found BonBon history in %s, and %s has no history yet.\n"+
		"Run bbflow migrate to copy the BonBon history, then start the server.\n"+
		"To start without it, use --dir with another directory", source, target.Dir)
}
