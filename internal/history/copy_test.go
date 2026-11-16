package history

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// bonbonDatabase returns a BonBon history in the given format. The returned connection
// keeps one committed event only in the WAL, as after a server crash.
func bonbonDatabase(t *testing.T, version int) string {
	t.Helper()
	path, db := oldDatabase(t, min(version, schemaVersion-1))
	if version == schemaVersion {
		store, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		store.Close()
	}
	dir := filepath.Dir(path)
	execSQL(t, db, fmt.Sprintf("UPDATE sessions SET workspace='%s' WHERE id='active'", filepath.Join(dir, "workspaces", "general")))
	if version >= 5 {
		execSQL(t, db, fmt.Sprintf("UPDATE worktrees SET path='%s'", filepath.Join(dir, "worktrees", "saved")))
	}
	execSQL(t, db, "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
	execSQL(t, db, `INSERT INTO events(seq,session_id,run_id,kind,data,text,created)
 VALUES(46,'saved','finished','output',X'41','A','2026-10-01T01:00:07Z')`)
	if info, err := os.Stat(path + "-wal"); err != nil || info.Size() == 0 {
		t.Fatal("the fixture has no WAL content", err)
	}
	return path
}

func fileHashes(t *testing.T, path string) map[string][32]byte {
	t.Helper()
	hashes := map[string][32]byte{}
	for _, name := range []string{path, path + "-wal"} {
		data, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		hashes[name] = sha256.Sum256(data)
	}
	return hashes
}

func TestCopyFromEveryReleasedFormat(t *testing.T) {
	for version := oldestSchemaVersion; version <= schemaVersion; version++ {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			source := bonbonDatabase(t, version)
			before := fileHashes(t, source)
			beforeRows := snapshotDatabase(t, rawDatabase(t, source))
			target := filepath.Join(t.TempDir(), "bbflow", "history.sqlite")
			report, err := CopyFrom(source, target)
			if err != nil {
				t.Fatal(err)
			}
			if report.Format != version || report.Rows["events"] != 6 || report.Rows["sessions"] != 2 {
				t.Fatalf("report: %+v", report)
			}
			if after := fileHashes(t, source); !reflect.DeepEqual(before, after) {
				t.Fatal("the source database or WAL changed")
			}
			assertSnapshot(t, rawDatabase(t, source), beforeRows, true)

			store, err := Open(target)
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			want := []string{filepath.Join(filepath.Dir(source), "workspaces", "general")}
			if version >= 5 {
				want = []string{want[0], filepath.Join(filepath.Dir(source), "worktrees", "saved")}
			}
			if folders, err := store.FoldersInside(filepath.Dir(source)); err != nil || !reflect.DeepEqual(folders, want) {
				t.Fatalf("folders: %q, want %q %v", folders, want, err)
			}
			var events, current int
			if err = store.db.QueryRow("SELECT count(*), (SELECT user_version FROM pragma_user_version) FROM events").Scan(&events, &current); err != nil {
				t.Fatal(err)
			}
			if events != 6 || current != schemaVersion {
				t.Fatalf("copy has %d events in format %d", events, current)
			}
			var text string
			if err = store.db.QueryRow("SELECT text FROM events WHERE seq=46").Scan(&text); err != nil || text != "A" {
				t.Fatal("the copy lost committed WAL content", text, err)
			}
			entries, err := os.ReadDir(filepath.Dir(target))
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".history-copy-") {
					t.Fatal("a temporary copy remains:", entry.Name())
				}
			}
		})
	}
}

func TestCopyFromRefusesWithoutChanges(t *testing.T) {
	t.Run("existing target", func(t *testing.T) {
		source := bonbonDatabase(t, schemaVersion)
		target := filepath.Join(t.TempDir(), "history.sqlite")
		if err := os.WriteFile(target, []byte("bbflow data"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := CopyFrom(source, target); err == nil || !strings.Contains(err.Error(), "already exists") {
			t.Fatal("copied over an existing database", err)
		}
		if data, _ := os.ReadFile(target); string(data) != "bbflow data" {
			t.Fatal("changed the existing target")
		}
	})
	t.Run("newer format", func(t *testing.T) {
		source := filepath.Join(t.TempDir(), "history.sqlite")
		execSQL(t, rawDatabase(t, source), fmt.Sprintf("CREATE TABLE evidence (data BLOB); PRAGMA user_version=%d", schemaVersion+1))
		before := sha256.Sum256(must(os.ReadFile(source)))
		dir := filepath.Join(t.TempDir(), "bbflow")
		if _, err := CopyFrom(source, filepath.Join(dir, "history.sqlite")); err == nil || !strings.Contains(err.Error(), "not supported") {
			t.Fatal("copied a newer format", err)
		}
		if sha256.Sum256(must(os.ReadFile(source))) != before {
			t.Fatal("changed the source")
		}
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Fatal("created the target directory", err)
		}
	})
	t.Run("missing source", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(dir, "bbflow", "history.sqlite")
		if _, err := CopyFrom(filepath.Join(dir, "missing.sqlite"), target); err == nil {
			t.Fatal("copied a missing source")
		}
		if _, err := os.Stat(target); !os.IsNotExist(err) {
			t.Fatal("created a target", err)
		}
	})
}

func must[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}

func TestCopyFromAddsNoFilesBesideSource(t *testing.T) {
	path, _ := oldDatabase(t, schemaVersion-1)
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = CopyFrom(path, filepath.Join(t.TempDir(), "history.sqlite")); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != len(after) {
		t.Fatalf("source directory changed from %v to %v", before, after)
	}
}

func TestMoveWorktreeRecordsTheNewPath(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	old, moved := "/data/bonbon/worktrees/a", "/data/bbflow/worktrees/a"
	sessions := map[string]string{}
	for name, workspace := range map[string]string{
		"root": old, "subfolder": old + "/web", "sibling": old + "b", "other": "/data/bonbon/workspaces/general",
	} {
		session, err := store.CreateSession(name, workspace, "")
		if err != nil {
			t.Fatal(err)
		}
		sessions[name] = session.ID
	}
	ready := Worktree{Path: old, Repository: "/repo", Base: "main", Commit: "c", Branch: "bbflow/a", State: "ready"}
	removed := Worktree{Path: "/data/bonbon/worktrees/gone", Repository: "/repo", Base: "main", Commit: "c", Branch: "bbflow/b", State: "removed"}
	must(0, store.SaveWorktree(sessions["root"], ready))
	must(0, store.SaveWorktree(sessions["other"], removed))

	worktrees, err := store.ReadyWorktreesIn("/data/bonbon/worktrees")
	if err != nil || len(worktrees) != 1 || worktrees[0].Path != old {
		t.Fatalf("ready worktrees: %+v %v", worktrees, err)
	}
	if err = store.MoveWorktree(old, moved); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"root": moved, "subfolder": moved + "/web", "sibling": old + "b", "other": "/data/bonbon/workspaces/general"}
	for name, id := range sessions {
		session, err := store.Session(id)
		if err != nil {
			t.Fatal(err)
		}
		if session.Workspace != want[name] {
			t.Errorf("%s workspace is %s, want %s", name, session.Workspace, want[name])
		}
	}
	if session, _ := store.Session(sessions["root"]); session.Worktree == nil || session.Worktree.Path != moved {
		t.Fatalf("worktree: %+v", session.Worktree)
	}
	if err = store.MoveWorktree(old, moved); err == nil {
		t.Fatal("moved a worktree that is not recorded")
	}
	if worktrees, _ = store.ReadyWorktreesIn("/data/bonbon/worktrees"); len(worktrees) != 0 {
		t.Fatalf("still listed: %+v", worktrees)
	}
}
