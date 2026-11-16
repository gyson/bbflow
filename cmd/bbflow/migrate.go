package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

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
		fmt.Printf("Usage: bbflow [--dir DIR] migrate [--from DIR]\n\n"+
			"Copy the history of a stopped BonBon instance into a new bbflow instance. Then move\n"+
			"the BonBon worktrees of the copied sessions into bbflow. The BonBon database is not\n"+
			"changed. If bbflow history exists, only move the worktrees. Default --from: %s\n",
			defaultBonBonDir())
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
	if path, err := filepath.EvalSymlinks(target.Dir); err == nil && path == source {
		return errors.New("the BonBon and bbflow directories are the same; use another --dir")
	}
	// A first migrate needs BonBon history. Check it before the bbflow directory changes.
	if _, err = os.Lstat(filepath.Join(target.Dir, "history.sqlite")); errors.Is(err, os.ErrNotExist) {
		if _, err = os.Stat(filepath.Join(source, "history.sqlite")); err != nil {
			return fmt.Errorf("no BonBon history in %s: %w", source, err)
		}
	}

	// Hold the BonBon archive lock, so that no BonBon server writes during the copy or
	// uses a worktree during a move. Do not create a lock file in the BonBon directory.
	unlockSource, err := lockExistingFile(filepath.Join(source, "server.lock"))
	if err != nil {
		return err
	}
	defer unlockSource()
	// Hold the bbflow locks, so that no bbflow server starts on a partial copy or uses a
	// worktree during a move.
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

	// After an earlier migrate, only move the worktrees. Earlier releases copied the
	// history but left the worktrees in the BonBon directory.
	database := filepath.Join(target.Dir, "history.sqlite")
	if _, err = os.Lstat(database); err == nil {
		fmt.Printf("bbflow history already exists in %s. The BonBon history was not copied again.\n", target.Dir)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	} else if err = copyBonBonHistory(source, database); err != nil {
		return err
	}

	store, err := history.Open(database)
	if err != nil {
		return err
	}
	defer store.Close()
	if err = moveWorktrees(store, source, target.Dir); err != nil {
		return err
	}
	folders, err := store.FoldersInside(source)
	if err != nil {
		return err
	}
	if len(folders) != 0 {
		fmt.Println("\nCopied sessions still use these folders in the BonBon directory. Keep them until you finish with those sessions:")
		for _, folder := range folders {
			fmt.Println("  " + folder)
		}
	}
	fmt.Println("\nStart bbflow with: bbflow server start")
	return nil
}

func copyBonBonHistory(source, database string) error {
	path := filepath.Join(source, "history.sqlite")
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("no BonBon history in %s: %w", source, err)
	}
	report, err := history.CopyFrom(path, database)
	if err != nil {
		return err
	}
	fmt.Printf("Copied BonBon history from %s to %s.\n", source, filepath.Dir(database))
	fmt.Printf("Source format %d: %d sessions, %d terminals, %d events.\n",
		report.Format, report.Rows["sessions"], report.Rows["runs"], report.Rows["events"])
	fmt.Println("The BonBon database was not changed.")
	return nil
}

// moveWorktrees moves the ready managed worktrees of the BonBon instance into the bbflow
// worktree directory with git worktree move, and records the new paths in the copy. Git
// updates its own worktree records. A worktree that Git does not move stays in place.
func moveWorktrees(store *history.Store, source, target string) error {
	worktrees, err := store.ReadyWorktreesIn(filepath.Join(source, "worktrees"))
	if err != nil {
		return err
	}
	if len(worktrees) == 0 {
		fmt.Println("\nNo BonBon worktrees to move.")
		return nil
	}
	directory := filepath.Join(target, "worktrees")
	if err = os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	var moved, kept []string
	for _, w := range worktrees {
		to := filepath.Join(directory, filepath.Base(w.Path))
		if err := gitWorktreeMove(w.Repository, w.Path, to); err != nil {
			kept = append(kept, fmt.Sprintf("  %s: %v", w.Path, err))
			continue
		}
		if err := store.MoveWorktree(w.Path, to); err != nil {
			if undo := gitWorktreeMove(w.Repository, to, w.Path); undo != nil {
				return fmt.Errorf("moved %s to %s, but could not record it (%v) or move it back (%v)", w.Path, to, err, undo)
			}
			kept = append(kept, fmt.Sprintf("  %s: %v", w.Path, err))
			continue
		}
		moved = append(moved, fmt.Sprintf("  %s -> %s", w.Path, to))
	}
	if len(moved) != 0 {
		fmt.Println("\nMoved these worktrees into bbflow:")
		fmt.Println(strings.Join(moved, "\n"))
	}
	if len(kept) != 0 {
		fmt.Println("\nDid not move these worktrees:")
		fmt.Println(strings.Join(kept, "\n"))
	}
	return nil
}

func gitWorktreeMove(repository, from, to string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", repository, "worktree", "move", from, to)
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "GIT_") {
			cmd.Env = append(cmd.Env, item)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_TERMINAL_PROMPT=0")
	if output, err := cmd.CombinedOutput(); err != nil {
		if message := strings.TrimSpace(string(output)); message != "" {
			return errors.New(message)
		}
		return err
	}
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
