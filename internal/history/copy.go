package history

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// CopyReport describes a verified history copy.
type CopyReport struct {
	Format int              // The format of the source database.
	Rows   map[string]int64 // The number of rows in each source table.
}

// CopyFrom writes a verified copy of the history database at source to target, then
// upgrades the copy to the current format. The target must not exist. The caller must
// make sure that no server uses either database. CopyFrom opens the source read-only
// and does not change it.
func CopyFrom(source, target string) (CopyReport, error) {
	var report CopyReport
	for _, path := range []string{target, target + "-wal", target + "-shm"} {
		if _, err := os.Lstat(path); err == nil {
			return report, fmt.Errorf("%s already exists; nothing was copied", path)
		} else if !errors.Is(err, os.ErrNotExist) {
			return report, err
		}
	}
	if info, err := os.Stat(source); err != nil {
		return report, err
	} else if !info.Mode().IsRegular() {
		return report, fmt.Errorf("%s is not a database file", source)
	}
	// A read-only connection to a WAL database creates empty -wal and -shm files. Without a
	// WAL file there is no WAL content to read, so open the file as immutable. Then SQLite
	// adds no files beside the source.
	_, err := os.Lstat(source + "-wal")
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return report, err
	}
	src, err := openReadOnly(source, err != nil)
	if err != nil {
		return report, err
	}
	defer src.Close()
	if report.Format, err = format(src); err != nil {
		return report, err
	}
	if report.Format < oldestSchemaVersion || report.Format > schemaVersion {
		return report, fmt.Errorf("history format %d in %s is not supported; supported formats are %d through %d; nothing was copied",
			report.Format, source, oldestSchemaVersion, schemaVersion)
	}
	if report.Rows, err = countRows(src); err != nil {
		return report, err
	}

	// SQLite writes VACUUM INTO only to an empty or absent file. Create a private empty
	// file in the target directory, so that the final link stays on one filesystem.
	if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return report, err
	}
	file, err := os.CreateTemp(filepath.Dir(target), ".history-copy-*.sqlite")
	if err != nil {
		return report, err
	}
	temporary := file.Name()
	defer removeDatabase(temporary)
	if err = file.Close(); err != nil {
		return report, err
	}
	// VACUUM INTO reads one consistent snapshot, including committed WAL content.
	if _, err = src.Exec("VACUUM INTO ?", temporary); err != nil {
		return report, fmt.Errorf("copy %s: %w", source, err)
	}
	if err = verifyCopy(temporary, report); err != nil {
		return report, err
	}
	// A link never replaces an existing file. Remove the temporary name after it.
	if err = os.Link(temporary, target); err != nil {
		return report, fmt.Errorf("place the copy at %s: %w", target, err)
	}
	store, err := Open(target)
	if err != nil {
		removeDatabase(target)
		return report, fmt.Errorf("upgrade the copy (the copy was removed): %w", err)
	}
	return report, store.Close()
}

func openReadOnly(path string, immutable bool) (*sql.DB, error) {
	uri := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	query := url.Values{"mode": {"ro"}, "_pragma": {"trusted_schema(0)", "busy_timeout(1000)"}}
	if immutable {
		query.Set("immutable", "1")
	}
	uri.RawQuery = query.Encode()
	db, err := sql.Open("sqlite3", uri.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

func format(db *sql.DB) (int, error) {
	var version int
	err := db.QueryRow("PRAGMA user_version").Scan(&version)
	return version, err
}

func countRows(db *sql.DB) (map[string]int64, error) {
	rows, err := db.Query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
	if err != nil {
		return nil, err
	}
	var names []string
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			rows.Close()
			return nil, err
		}
		names = append(names, name)
	}
	if err = rows.Close(); err != nil {
		return nil, err
	}
	counts := make(map[string]int64, len(names))
	for _, name := range names {
		var count int64
		quoted := `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
		if err = db.QueryRow("SELECT count(*) FROM " + quoted).Scan(&count); err != nil {
			return nil, err
		}
		counts[name] = count
	}
	return counts, nil
}

func verifyCopy(path string, source CopyReport) error {
	db, err := openReadOnly(path, false)
	if err != nil {
		return err
	}
	defer db.Close()
	var result string
	if err = db.QueryRow("PRAGMA integrity_check").Scan(&result); err != nil {
		return err
	}
	if result != "ok" {
		return fmt.Errorf("the copy failed the integrity check: %s", result)
	}
	version, err := format(db)
	if err != nil {
		return err
	}
	if version != source.Format {
		return fmt.Errorf("the copy has format %d, but the source has format %d", version, source.Format)
	}
	counts, err := countRows(db)
	if err != nil {
		return err
	}
	if len(counts) != len(source.Rows) {
		return fmt.Errorf("the copy has %d tables, but the source has %d", len(counts), len(source.Rows))
	}
	for name, count := range source.Rows {
		if copied, ok := counts[name]; !ok || copied != count {
			return fmt.Errorf("table %s has %d rows in the copy, but %d in the source", name, copied, count)
		}
	}
	return nil
}

// FoldersInside lists session workspace and worktree paths inside directory. The server
// moves the General project to its own directory, so project paths are not listed.
func (s *Store) FoldersInside(directory string) ([]string, error) {
	prefix := folderPrefix(directory)
	rows, err := s.db.QueryContext(context.Background(), `SELECT workspace FROM sessions
 UNION SELECT path FROM worktrees WHERE state<>'removed' ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	folders := []string{}
	for rows.Next() {
		var path string
		if err = rows.Scan(&path); err != nil {
			return nil, err
		}
		if strings.HasPrefix(path, prefix) {
			folders = append(folders, path)
		}
	}
	return folders, rows.Err()
}

// ReadyWorktreesIn lists the ready managed worktrees whose folder is directly inside
// directory.
func (s *Store) ReadyWorktreesIn(directory string) ([]Worktree, error) {
	rows, err := s.db.QueryContext(context.Background(), `SELECT path,repository,base,commit_id,branch,state
 FROM worktrees WHERE state='ready' ORDER BY path`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	worktrees := []Worktree{}
	for rows.Next() {
		var w Worktree
		if err = rows.Scan(&w.Path, &w.Repository, &w.Base, &w.Commit, &w.Branch, &w.State); err != nil {
			return nil, err
		}
		if filepath.Dir(w.Path) == filepath.Clean(directory) {
			worktrees = append(worktrees, w)
		}
	}
	return worktrees, rows.Err()
}

// MoveWorktree records that the worktree at from is now at to. It changes the worktree
// path and each session or project workspace at from or inside it. Event data keeps the
// original paths.
func (s *Store) MoveWorktree(from, to string) error {
	from, to = filepath.Clean(from), filepath.Clean(to)
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.Exec("UPDATE worktrees SET path=? WHERE path=? AND state='ready'", to, from)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil {
		return err
	} else if count != 1 {
		return fmt.Errorf("no ready worktree at %s", from)
	}
	for _, table := range []string{"sessions", "projects"} {
		if _, err = tx.Exec(`UPDATE `+table+` SET workspace=?2 || substr(workspace, length(?1)+1)
 WHERE workspace=?1 OR substr(workspace, 1, length(?3))=?3`, from, to, folderPrefix(from)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func folderPrefix(directory string) string {
	return strings.TrimSuffix(filepath.Clean(directory), string(filepath.Separator)) + string(filepath.Separator)
}

func removeDatabase(path string) {
	for _, name := range []string{path, path + "-wal", path + "-shm", path + "-journal"} {
		os.Remove(name)
	}
}
