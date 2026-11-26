package history

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func rawDatabase(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	return db
}

func execSQL(t *testing.T, db *sql.DB, statement string) {
	t.Helper()
	if _, err := db.Exec(statement); err != nil {
		t.Fatal(err)
	}
}

func oldDatabase(t *testing.T, version int) (string, *sql.DB) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "history.sqlite")
	db := rawDatabase(t, path)
	for _, file := range []string{fmt.Sprintf("format-%d.sql", version), "records.sql"} {
		data, err := os.ReadFile(filepath.Join("testdata", file))
		if err != nil {
			t.Fatal(err)
		}
		execSQL(t, db, string(data))
	}
	if version >= 4 {
		execSQL(t, db, "UPDATE sessions SET project_id='project' WHERE id='saved'")
	}
	if version >= 5 {
		execSQL(t, db, `INSERT INTO preparations VALUES('saved',7,'launched','{"toolId":"removed-tool","toolName":"Old tool","command":"old-tool --interactive","base":"main","worktree":true}');
INSERT INTO worktrees VALUES('saved','/missing/worktree','/missing/repo','main','abcdef','saved-branch','ready');`)
	}
	if version >= 6 {
		execSQL(t, db, "UPDATE sessions SET archived=1 WHERE id='saved'")
	}
	if version >= 17 {
		// From format 17, a preparation has a tool type, a model, and an effort.
		execSQL(t, db, "UPDATE preparations SET data=json_set(data,'$.toolType','custom','$.model','','$.effort','')")
	}
	if version >= 22 {
		// From format 22, a preparation has a permission mode.
		execSQL(t, db, "UPDATE preparations SET data=json_set(data,'$.permission','')")
	}
	return path, db
}

func sqlRows(t *testing.T, db *sql.DB, query string) [][]any {
	t.Helper()
	rows, err := db.Query(query)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	var result [][]any
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err = rows.Scan(pointers...); err != nil {
			t.Fatal(err)
		}
		result = append(result, values)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

// Keep the original column list so added columns do not hide changed old values.
func snapshotDatabase(t *testing.T, db *sql.DB) map[string][][]any {
	t.Helper()
	result := map[string][][]any{}
	for _, query := range []string{"PRAGMA user_version", "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name"} {
		result[query] = sqlRows(t, db, query)
	}
	for _, table := range sqlRows(t, db, "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name") {
		name := table[0].(string)
		var columns []string
		for _, column := range sqlRows(t, db, "PRAGMA table_info("+name+")") {
			columns = append(columns, column[1].(string))
		}
		query := "SELECT " + strings.Join(columns, ",") + " FROM " + name + " ORDER BY rowid"
		result[query] = sqlRows(t, db, query)
	}
	return result
}

func assertSnapshot(t *testing.T, db *sql.DB, snapshot map[string][][]any, includeSchema bool) {
	t.Helper()
	for query, want := range snapshot {
		if !includeSchema && (query == "PRAGMA user_version" || strings.Contains(query, "FROM sqlite_schema")) {
			continue
		}
		got := sqlRows(t, db, query)
		if !includeSchema && query == "SELECT id,revision,data FROM settings ORDER BY rowid" {
			var saved map[string]any
			if err := json.Unmarshal([]byte(got[0][2].(string)), &saved); err != nil {
				t.Fatal(err)
			}
			var original map[string]any
			if err := json.Unmarshal([]byte(want[0][2].(string)), &original); err != nil {
				t.Fatal(err)
			}
			if _, exists := original["appearance"]; !exists {
				original["appearance"] = "system"
			}
			if _, exists := original["titleTool"]; !exists {
				original["titleTool"] = "none"
			}
			if _, exists := original["updateCheck"]; !exists {
				original["updateCheck"] = true
			}
			if _, exists := original["port"]; !exists {
				original["port"] = float64(0)
			}
			if _, exists := original["titleCommand"]; !exists {
				original["titleCommand"] = ""
			}
			if _, exists := original["remoteHost"]; !exists {
				original["remoteHost"], original["remoteLogin"] = "", ""
			}
			if _, exists := original["remoteOn"]; !exists {
				original["remoteOn"] = original["remoteHost"] != "" && original["remoteLogin"] != ""
			}
			for _, tool := range original["tools"].([]any) {
				delete(tool.(map[string]any), "continueCommand")
			}
			if _, exists := original["titleModel"]; !exists {
				original["titleModel"], original["titleEffort"] = map[any]string{"claude": "haiku", "codex": "gpt-6-luna", "code-puppy": "codex-gpt-6-luna"}[original["titleTool"]], ""
				if original["titleTool"] == "codex" {
					original["titleEffort"] = "low"
				}
			}
			if _, exists := original["prompts"]; !exists {
				original["prompts"] = []any{}
			}
			if _, exists := original["checkTools"]; !exists {
				original["tools"], original["checkTools"], original["shellOff"] = upgradedTools(original["tools"].([]any)), true, false
			}
			// Migration 22 gives each tool the empty permission mode, the CLI default.
			for _, tool := range original["tools"].([]any) {
				if _, exists := tool.(map[string]any)["permission"]; !exists {
					tool.(map[string]any)["permission"] = ""
				}
			}
			// Migration 23 adds an empty list of prompt groups, and puts each prompt at the
			// top level.
			if _, exists := original["promptGroups"]; !exists {
				original["promptGroups"] = []any{}
				for _, prompt := range original["prompts"].([]any) {
					prompt.(map[string]any)["group"] = ""
				}
			}
			// Migration 24 turns Code Mode off in each tool.
			for _, tool := range original["tools"].([]any) {
				if _, exists := tool.(map[string]any)["codeMode"]; !exists {
					tool.(map[string]any)["codeMode"] = false
				}
			}
			if !reflect.DeepEqual(saved, original) {
				t.Fatal("migration changed existing settings", saved, original)
			}
			got[0][2] = want[0][2]
		}
		if !includeSchema && query == "SELECT session_id,revision,state,data FROM preparations ORDER BY rowid" && len(got) == len(want) {
			for i := range got {
				var saved, original map[string]any
				if err := json.Unmarshal([]byte(got[i][3].(string)), &saved); err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal([]byte(want[i][3].(string)), &original); err != nil {
					t.Fatal(err)
				}
				if _, exists := original["toolType"]; !exists {
					// The fixture preparations name no built-in tool, so their type is custom.
					original["toolType"], original["model"], original["effort"] = "custom", "", ""
					if id, _ := original["toolId"].(string); id == "" {
						original["toolType"] = ""
					}
				}
				if _, exists := original["permission"]; !exists {
					original["permission"] = ""
				}
				if _, exists := original["codeMode"]; !exists {
					original["codeMode"] = false
				}
				if !reflect.DeepEqual(saved, original) {
					t.Fatal("migration changed an existing preparation", saved, original)
				}
				got[i][3] = want[i][3]
			}
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("changed %s:\ngot  %#v\nwant %#v", query, got, want)
		}
	}
}

// presetTools are the built-in tools of a new database, before the tool check.
func presetTools() []Tool {
	return []Tool{
		{ID: "builtin-codex", Name: "Codex", Command: "codex --no-alt-screen", Type: "codex", Builtin: true},
		{ID: "builtin-claude", Name: "Claude Code", Command: "claude", Type: "claude", Builtin: true},
		{ID: "builtin-agy", Name: "Antigravity", Command: "agy", Type: "agy", Builtin: true},
		{ID: "builtin-code-puppy", Name: "Code Puppy", Command: "code-puppy", Type: "code-puppy", Builtin: true},
	}
}

// upgradedTools is the tool list that migration 17 makes. The first tool whose command
// is the command of a built-in tool, with the CLI name or a path of the CLI, becomes that
// tool. Every saved tool stays on. A type without such a tool gets a built-in tool that is
// off. The built-in tools come first: the saved ones, then the new ones. The other saved
// tools follow.
func upgradedTools(tools []any) []any {
	result, others := []any{}, []any{}
	types, names := map[string]bool{}, map[string]bool{}
	args := map[string]string{"codex": "--no-alt-screen"}
	for _, tool := range tools {
		tool := tool.(map[string]any)
		command := strings.TrimLeft(tool["command"].(string), " ")
		kind := inferredType(command)
		word, rest, _ := strings.Cut(command, " ")
		rest = strings.TrimSpace(rest)
		tool["type"], tool["model"], tool["effort"], tool["path"] = kind, "", "", ""
		usable := word == kind || (len(word) <= 500 && (strings.HasPrefix(word, "/") || strings.HasPrefix(word, "~/")))
		builtin := kind != "custom" && rest == args[kind] && usable && !types[kind]
		tool["builtin"], tool["enabled"] = builtin, true
		names[tool["name"].(string)] = true
		if builtin {
			types[kind] = true
			if word != kind {
				tool["path"] = word
			}
			tool["command"] = strings.TrimSpace(word + " " + rest)
			result = append(result, tool)
		} else {
			tool["type"] = "custom"
			others = append(others, tool)
		}
	}
	for _, preset := range [][3]string{{"codex", "Codex", "codex --no-alt-screen"}, {"claude", "Claude Code", "claude"}, {"agy", "Antigravity", "agy"}, {"code-puppy", "Code Puppy", "code-puppy"}} {
		if types[preset[0]] {
			continue
		}
		name := preset[1]
		if names[name] {
			name += " (built-in)"
		}
		result = append(result, map[string]any{"id": "builtin-" + preset[0], "name": name, "command": preset[2], "type": preset[0],
			"model": "", "effort": "", "builtin": true, "enabled": false, "path": ""})
	}
	return append(result, others...)
}

// inferredType is the tool type that migration 17 gives a command. The test keeps its own
// rule, so that a change of models.Infer cannot hide a change of the migration.
func inferredType(command string) string {
	word, _, _ := strings.Cut(strings.TrimLeft(command, " "), " ")
	// A word that the shell interprets is no program name. The folder does not count.
	if word == "" || strings.Trim(word, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./~+@-") != "" {
		return "custom"
	}
	word = word[strings.LastIndex(word, "/")+1:]
	switch word {
	case "codex", "claude", "agy", "code-puppy":
		return word
	}
	return "custom"
}

func TestMigrationsPreserveReleasedArchives(t *testing.T) {
	for _, version := range []int{3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			path, db := oldDatabase(t, version)
			before := snapshotDatabase(t, db)
			db.Close()
			store, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			assertSnapshot(t, store.db, before, version == schemaVersion)
			if got := sqlRows(t, store.db, "PRAGMA user_version"); got[0][0] != int64(schemaVersion) {
				t.Fatal("wrong version", got)
			}
			settings, err := store.Settings()
			appearance := "system"
			if version >= 8 {
				appearance = "dark"
			}
			// The fixtures from format 12 turned the release check off. Earlier upgrades turn
			// it on. Upgrades before format 14 select the automatic port. The fixtures from
			// format 14 saved a port and the Codex title tool, and the upgrade keeps them. The
			// format 15 fixture saved a custom title command, and the upgrade keeps it. No
			// upgrade saves a custom title command. The format 17 fixture saved both values
			// of remote access, so the upgrade turns the switch of remote access on. No
			// other upgrade turns remote access on.
			titleTool, titleCommand, port := "none", "", 0
			remoteHost, remoteLogin := "", ""
			if version >= 14 {
				titleTool, port = "codex", 50000
			}
			if version >= 15 {
				titleCommand = "example-title --fast"
			}
			if version >= 17 {
				remoteHost, remoteLogin = "my-mac.example.ts.net", "user@example.com"
			}
			if err != nil || settings.Appearance != appearance || settings.TitleTool != titleTool || settings.TitleCommand != titleCommand || settings.UpdateCheck != (version < 12) || settings.Port != port || settings.RemoteHost != remoteHost || settings.RemoteLogin != remoteLogin || settings.RemoteOn != (version >= 17) || (version < 5 && !reflect.DeepEqual(settings, Settings{Appearance: "system", Base: "HEAD", Tools: presetTools(), TitleTool: "none", CheckTools: true, UpdateCheck: true, Prompts: []Prompt{}, PromptGroups: []PromptGroup{}})) {
				t.Fatal("invalid migrated settings", settings, err)
			}
			session, err := store.Session("saved")
			if err != nil || session.Workspace != "/missing/workspace" || session.Run.Status != "exited" {
				t.Fatal("cannot read old session", session, err)
			}
			if session.Title != "Saved café" || session.AutoTitle != "" {
				t.Fatal("changed the title of an old session", session)
			}
			if version == 3 && session.ProjectID != "" {
				t.Fatal("assigned an invented project", session)
			}
			if version >= 4 && session.ProjectID != "project" {
				t.Fatal("lost project membership", session)
			}
			if session.Archived != (version >= 6) {
				t.Fatal("changed archive state", session)
			}
			if session.ParentID != "" {
				t.Fatal("assigned an invented parent", session)
			}
			if session.Pinned || sqlRows(t, store.db, "SELECT count(*) FROM sessions WHERE pinned_at IS NOT NULL")[0][0] != int64(0) {
				t.Fatal("pinned an old session", session)
			}
			if got := sqlRows(t, store.db, "SELECT count(*) FROM events WHERE quiet<>0"); got[0][0] != int64(0) {
				t.Fatal("marked an old event quiet", got)
			}
			if version == 5 && (session.Preparation.Command != "old-tool --interactive" || session.Worktree.Commit != "abcdef") {
				t.Fatal("lost launch metadata", session)
			}
			if version >= 5 && (session.Preparation.ToolType != "custom" || session.Preparation.Model != "" || session.Preparation.Effort != "" || session.Preparation.Permission != "" || session.Preparation.CodeMode) {
				t.Fatal("wrong tool type of an old preparation", session.Preparation)
			}
			if version == 16 {
				// The saved Codex, Code Puppy, and Antigravity tools have the commands of
				// the built-in tools, so they become those tools and stay on. The folder of
				// the Antigravity command becomes its CLI path. Tools with other options
				// stay tools of the user, which are custom. The saved Claude Code tool has another option, so
				// a new built-in tool that is off gets another name. The built-in tools
				// come first.
				presets := presetTools()
				claude := presets[1]
				claude.Name = "Claude Code (built-in)"
				want := []Tool{
					{ID: "codex", Name: "Codex", Command: "codex --no-alt-screen", Type: "codex", Builtin: true, Enabled: true},
					{ID: "puppy", Name: "Code Puppy", Command: "code-puppy", Type: "code-puppy", Builtin: true, Enabled: true},
					{ID: "agy", Name: "Antigravity", Command: "/opt/tools/bin/agy", Type: "agy", Builtin: true, Enabled: true, Path: "/opt/tools/bin/agy"},
					claude,
					{ID: "example", Name: "Example", Command: "example --interactive", Type: "custom", Enabled: true},
					{ID: "plain", Name: "Plain", Command: "plain", Type: "custom", Enabled: true},
					{ID: "path", Name: "Path", Command: "/opt/tools/bin/other codex", Type: "custom", Enabled: true},
					{ID: "search", Name: "Codex search", Command: "codex --no-alt-screen --search", Type: "custom", Enabled: true},
					{ID: "claude", Name: "Claude Code", Command: "claude --model opus", Type: "custom", Enabled: true},
					{ID: "quoted", Name: "Quoted", Command: "'/opt/my tools/claude'", Type: "custom", Enabled: true},
				}
				if !reflect.DeepEqual(settings.Tools, want) || settings.Revision != 9 || !settings.CheckTools {
					t.Fatal("wrong tool types after the upgrade", settings.Tools, settings.Revision)
				}
			}
			result, err := store.Query(context.Background(), "SELECT seq FROM events WHERE text LIKE '%café%'")
			if err != nil || len(result.Rows) != 1 || result.Rows[0][0] != int64(43) {
				t.Fatal("old evidence is not searchable", result, err)
			}
			// The deleted highest sequence must never be reused after migration.
			event, err := store.Append("saved", "finished", "output", []byte("new"), "new")
			if err != nil || event.Seq != 901 {
				t.Fatal("lost event sequence high-water mark", event, err)
			}
			after := snapshotDatabase(t, store.db)
			store.Close()
			reopened, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			assertSnapshot(t, reopened.db, after, true)
		})
	}
}

func TestMigrationFailureRollsBackEntireUpgrade(t *testing.T) {
	for _, test := range []struct {
		name, damage, message string
	}{
		{"later-script", "CREATE TABLE worktrees (original TEXT); INSERT INTO worktrees VALUES('keep')", "apply history migration 5"},
		{"archive-script", "ALTER TABLE sessions ADD COLUMN archived INTEGER", "apply history migration 6"},
		{"run-index-script", "CREATE TABLE events_start_run (original TEXT); INSERT INTO events_start_run VALUES('keep')", "apply history migration 7"},
		{"server-script", "CREATE TABLE server (original TEXT); INSERT INTO server VALUES('keep')", "apply history migration 11"},
		{"parent-script", "CREATE INDEX sessions_parent ON sessions(title)", "apply history migration 13"},
		{"pin-script", "ALTER TABLE sessions ADD COLUMN pinned_at TEXT", "apply history migration 19"},
		{"quiet-script", "ALTER TABLE events ADD COLUMN quiet INTEGER", "apply history migration 21"},
		{"schema-validation", "ALTER TABLE events RENAME COLUMN data TO evidence", "validate history schema"},
		{"foreign-keys", "PRAGMA foreign_keys=OFF; UPDATE runs SET session_id='missing' WHERE id='finished'", "invalid foreign keys"},
	} {
		t.Run(test.name, func(t *testing.T) {
			path, db := oldDatabase(t, 3)
			execSQL(t, db, test.damage)
			before := snapshotDatabase(t, db)
			db.Close()
			for range 2 {
				store, err := Open(path)
				if err == nil {
					store.Close()
					t.Fatal("accepted invalid archive")
				}
				if !strings.Contains(err.Error(), test.message) {
					t.Fatal(err)
				}
				db = rawDatabase(t, path)
				assertSnapshot(t, db, before, true)
				db.Close()
			}
		})
	}
}

func TestAppearanceUpgradeRollsBack(t *testing.T) {
	path, db := oldDatabase(t, 6)
	execSQL(t, db, "CREATE TRIGGER reject_settings_update BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'fixture'); END")
	before := snapshotDatabase(t, db)
	db.Close()
	if store, err := Open(path); err == nil {
		store.Close()
		t.Fatal("accepted blocked appearance update")
	} else if !strings.Contains(err.Error(), "apply history migration 8") {
		t.Fatal(err)
	}
	assertSnapshot(t, rawDatabase(t, path), before, true)
}

func TestToolSettingsUpgradeRollsBack(t *testing.T) {
	path, db := oldDatabase(t, 8)
	execSQL(t, db, "CREATE TRIGGER reject_settings_update BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'fixture'); END")
	before := snapshotDatabase(t, db)
	db.Close()
	if store, err := Open(path); err == nil {
		store.Close()
		t.Fatal("accepted blocked tool settings update")
	} else if !strings.Contains(err.Error(), "apply history migration 9") {
		t.Fatal(err)
	}
	assertSnapshot(t, rawDatabase(t, path), before, true)
}

// Migration 10 adds a column and changes the settings. A failed settings update must
// also remove the column and keep format 9.
func TestTitleUpgradeRollsBack(t *testing.T) {
	path, db := oldDatabase(t, 9)
	execSQL(t, db, "CREATE TRIGGER reject_settings_update BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'fixture'); END")
	before := snapshotDatabase(t, db)
	db.Close()
	if store, err := Open(path); err == nil {
		store.Close()
		t.Fatal("accepted blocked title settings update")
	} else if !strings.Contains(err.Error(), "apply history migration 10") {
		t.Fatal(err)
	}
	db = rawDatabase(t, path)
	assertSnapshot(t, db, before, true)
	if got := sqlRows(t, db, "SELECT count(*) FROM pragma_table_info('sessions') WHERE name='auto_title'"); got[0][0] != int64(0) {
		t.Fatal("the auto_title column survived the rollback")
	}
}

func TestUpdateCheckUpgradeRollsBack(t *testing.T) {
	path, db := oldDatabase(t, 11)
	execSQL(t, db, "CREATE TRIGGER reject_settings_update BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'fixture'); END")
	before := snapshotDatabase(t, db)
	db.Close()
	if store, err := Open(path); err == nil {
		store.Close()
		t.Fatal("accepted blocked update check settings update")
	} else if !strings.Contains(err.Error(), "apply history migration 12") {
		t.Fatal(err)
	}
	assertSnapshot(t, rawDatabase(t, path), before, true)
}

func TestPortSettingUpgradeRollsBack(t *testing.T) {
	path, db := oldDatabase(t, 13)
	execSQL(t, db, "CREATE TRIGGER reject_settings_update BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'fixture'); END")
	before := snapshotDatabase(t, db)
	db.Close()
	if store, err := Open(path); err == nil {
		store.Close()
		t.Fatal("accepted blocked port settings update")
	} else if !strings.Contains(err.Error(), "apply history migration 14") {
		t.Fatal(err)
	}
	assertSnapshot(t, rawDatabase(t, path), before, true)
}

func TestTitleCommandUpgradeRollsBack(t *testing.T) {
	path, db := oldDatabase(t, 14)
	execSQL(t, db, "CREATE TRIGGER reject_settings_update BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'fixture'); END")
	before := snapshotDatabase(t, db)
	db.Close()
	if store, err := Open(path); err == nil {
		store.Close()
		t.Fatal("accepted blocked title command settings update")
	} else if !strings.Contains(err.Error(), "apply history migration 15") {
		t.Fatal(err)
	}
	assertSnapshot(t, rawDatabase(t, path), before, true)
}

func TestRemoteAccessUpgradeRollsBack(t *testing.T) {
	path, db := oldDatabase(t, 15)
	execSQL(t, db, "CREATE TRIGGER reject_settings_update BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'fixture'); END")
	before := snapshotDatabase(t, db)
	db.Close()
	if store, err := Open(path); err == nil {
		store.Close()
		t.Fatal("accepted blocked remote access settings update")
	} else if !strings.Contains(err.Error(), "apply history migration 16") {
		t.Fatal(err)
	}
	assertSnapshot(t, rawDatabase(t, path), before, true)
}

func TestToolTypeUpgradeRollsBack(t *testing.T) {
	path, db := oldDatabase(t, 16)
	execSQL(t, db, "CREATE TRIGGER reject_preparation_update BEFORE UPDATE ON preparations BEGIN SELECT RAISE(ABORT, 'fixture'); END")
	before := snapshotDatabase(t, db)
	db.Close()
	if store, err := Open(path); err == nil {
		store.Close()
		t.Fatal("accepted blocked tool type update")
	} else if !strings.Contains(err.Error(), "apply history migration 17") {
		t.Fatal(err)
	}
	assertSnapshot(t, rawDatabase(t, path), before, true)
}

func TestRemoteSwitchUpgradeRollsBack(t *testing.T) {
	path, db := oldDatabase(t, 17)
	execSQL(t, db, "CREATE TRIGGER reject_settings_update BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'fixture'); END")
	before := snapshotDatabase(t, db)
	db.Close()
	if store, err := Open(path); err == nil {
		store.Close()
		t.Fatal("accepted blocked remote switch update")
	} else if !strings.Contains(err.Error(), "apply history migration 18") {
		t.Fatal(err)
	}
	assertSnapshot(t, rawDatabase(t, path), before, true)
}

func TestPromptsUpgradeRollsBack(t *testing.T) {
	path, db := oldDatabase(t, 19)
	execSQL(t, db, "CREATE TRIGGER reject_settings_update BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'fixture'); END")
	before := snapshotDatabase(t, db)
	db.Close()
	if store, err := Open(path); err == nil {
		store.Close()
		t.Fatal("accepted blocked prompts update")
	} else if !strings.Contains(err.Error(), "apply history migration 20") {
		t.Fatal(err)
	}
	assertSnapshot(t, rawDatabase(t, path), before, true)
}

// Migration 20 adds an empty prompt list. It keeps the other settings and the revision.
func TestPromptsUpgrade(t *testing.T) {
	path, db := oldDatabase(t, 19)
	db.Close()
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	settings, err := store.Settings()
	if err != nil || settings.Prompts == nil || len(settings.Prompts) != 0 || settings.Revision != 9 || settings.DefaultTool != "example" {
		t.Fatal("wrong prompts after the upgrade", settings, err)
	}
	if got := sqlRows(t, store.db, "SELECT json_type(data, '$.prompts') FROM settings"); got[0][0] != "array" {
		t.Fatal("the upgrade saved no prompt list", got)
	}
	settings.Prompts = []Prompt{{ID: "review", Name: "Review PR", Text: "Review PR #"}}
	if saved, err := store.SaveSettings(settings); err != nil || saved.Revision != 10 || len(saved.Prompts) != 1 {
		t.Fatal("cannot save a prompt after the upgrade", saved, err)
	}
}

// A blocked settings or preparation update rolls back migration 22 and keeps format 21.
func TestPermissionUpgradeRollsBack(t *testing.T) {
	for _, table := range []string{"settings", "preparations"} {
		t.Run(table, func(t *testing.T) {
			path, db := oldDatabase(t, 21)
			execSQL(t, db, "CREATE TRIGGER reject_update BEFORE UPDATE ON "+table+" BEGIN SELECT RAISE(ABORT, 'fixture'); END")
			before := snapshotDatabase(t, db)
			db.Close()
			if store, err := Open(path); err == nil {
				store.Close()
				t.Fatal("accepted a blocked permission update")
			} else if !strings.Contains(err.Error(), "apply history migration 22") {
				t.Fatal(err)
			}
			assertSnapshot(t, rawDatabase(t, path), before, true)
		})
	}
}

// Migration 22 gives each tool and each preparation the empty permission mode, the CLI
// default. It keeps the order of the tools, the other values, and the revisions. A tool
// can then save a permission mode.
func TestPermissionUpgrade(t *testing.T) {
	path, db := oldDatabase(t, 21)
	db.Close()
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	settings, err := store.Settings()
	if err != nil || settings.Revision != 9 || len(settings.Tools) != 5 || settings.Tools[0].Model != "gpt-6-luna" || settings.Tools[4].ID != "example" {
		t.Fatal("wrong tools after the upgrade", settings, err)
	}
	if got := sqlRows(t, store.db, "SELECT json_extract(t.value, '$.id'), json_type(t.value, '$.permission') FROM settings, json_each(settings.data, '$.tools') AS t ORDER BY t.key"); len(got) != 5 || got[0][0] != "builtin-codex" || got[4][0] != "example" {
		t.Fatal("the upgrade changed the tool list", got)
	} else {
		for _, row := range got {
			if row[1] != "text" {
				t.Fatal("a tool has no permission mode", got)
			}
		}
	}
	if got := sqlRows(t, store.db, "SELECT revision, json_extract(data, '$.permission') FROM preparations"); len(got) != 1 || got[0][0] != int64(7) || got[0][1] != "" {
		t.Fatal("wrong preparation after the upgrade", got)
	}
	settings.Tools[0].Permission = "approve-for-me"
	if saved, err := store.SaveSettings(settings); err != nil || saved.Revision != 10 || saved.Tools[0].Permission != "approve-for-me" {
		t.Fatal("cannot save a permission mode after the upgrade", saved, err)
	}
}

// A blocked settings update rolls back migration 23 and keeps format 22.
func TestPromptGroupsUpgradeRollsBack(t *testing.T) {
	path, db := oldDatabase(t, 22)
	execSQL(t, db, "CREATE TRIGGER reject_settings_update BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'fixture'); END")
	before := snapshotDatabase(t, db)
	db.Close()
	if store, err := Open(path); err == nil {
		store.Close()
		t.Fatal("accepted a blocked prompt group update")
	} else if !strings.Contains(err.Error(), "apply history migration 23") {
		t.Fatal(err)
	}
	assertSnapshot(t, rawDatabase(t, path), before, true)
}

// Migration 23 adds an empty list of prompt groups and puts each saved prompt at the top
// level. It keeps the order and the text of the prompts, the other values, and the
// revision. A prompt can then save a group.
func TestPromptGroupsUpgrade(t *testing.T) {
	path, db := oldDatabase(t, 22)
	db.Close()
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	settings, err := store.Settings()
	want := []Prompt{{ID: "review", Name: "Review PR", Text: "Review PR #"}, {ID: "checks", Name: "Run checks", Text: "Run make check."}}
	if err != nil || !slices.Equal(settings.Prompts, want) || settings.PromptGroups == nil || len(settings.PromptGroups) != 0 || settings.Revision != 9 || settings.Tools[0].Permission != "approve-for-me" {
		t.Fatal("wrong prompts after the upgrade", settings, err)
	}
	if got := sqlRows(t, store.db, "SELECT json_type(data, '$.promptGroups'), json_type(data, '$.prompts[0].group'), json_type(data, '$.prompts[1].group') FROM settings"); got[0][0] != "array" || got[0][1] != "text" || got[0][2] != "text" {
		t.Fatal("the upgrade saved no prompt groups", got)
	}
	settings.PromptGroups = []PromptGroup{{ID: "git", Name: "Git"}}
	settings.Prompts[1].Group = "git"
	if saved, err := store.SaveSettings(settings); err != nil || saved.Revision != 10 || saved.Prompts[1].Group != "git" || saved.PromptGroups[0].Name != "Git" {
		t.Fatal("cannot save a prompt group after the upgrade", saved, err)
	}
}

// A blocked settings or preparation update rolls back migration 24 and keeps format 23.
func TestCodeModeUpgradeRollsBack(t *testing.T) {
	for _, table := range []string{"settings", "preparations"} {
		t.Run(table, func(t *testing.T) {
			path, db := oldDatabase(t, 23)
			execSQL(t, db, "CREATE TRIGGER reject_update BEFORE UPDATE ON "+table+" BEGIN SELECT RAISE(ABORT, 'fixture'); END")
			before := snapshotDatabase(t, db)
			db.Close()
			if store, err := Open(path); err == nil {
				store.Close()
				t.Fatal("accepted a blocked Code Mode update")
			} else if !strings.Contains(err.Error(), "apply history migration 24") {
				t.Fatal(err)
			}
			assertSnapshot(t, rawDatabase(t, path), before, true)
		})
	}
}

// Migration 24 turns Code Mode off in each tool and each preparation, so that the
// commands stay the same. It keeps the order of the tools, the other values, and the
// revisions. The Claude Code tool can then save Code Mode.
func TestCodeModeUpgrade(t *testing.T) {
	path, db := oldDatabase(t, 23)
	db.Close()
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	settings, err := store.Settings()
	if err != nil || settings.Revision != 9 || len(settings.Tools) != 5 || settings.Tools[1].Permission != "auto" || settings.Tools[1].Model != "opus" || settings.Tools[4].ID != "example" || len(settings.PromptGroups) != 1 || settings.Prompts[1].Group != "git" {
		t.Fatal("wrong settings after the upgrade", settings, err)
	}
	if got := sqlRows(t, store.db, "SELECT json_extract(t.value, '$.id'), json_type(t.value, '$.codeMode') FROM settings, json_each(settings.data, '$.tools') AS t ORDER BY t.key"); len(got) != 5 || got[0][0] != "builtin-codex" || got[4][0] != "example" {
		t.Fatal("the upgrade changed the tool list", got)
	} else {
		for _, row := range got {
			if row[1] != "false" {
				t.Fatal("a tool has no Code Mode value", got)
			}
		}
	}
	if got := sqlRows(t, store.db, "SELECT revision, json_type(data, '$.codeMode') FROM preparations"); len(got) != 1 || got[0][0] != int64(7) || got[0][1] != "false" {
		t.Fatal("wrong preparation after the upgrade", got)
	}
	settings.Tools[1].CodeMode = true
	if saved, err := store.SaveSettings(settings); err != nil || saved.Revision != 10 || !saved.Tools[1].CodeMode {
		t.Fatal("cannot save Code Mode after the upgrade", saved, err)
	}
	settings.Tools[0].CodeMode = true
	if _, err := store.SaveSettings(settings); err == nil {
		t.Fatal("saved Code Mode for Codex")
	}
}

// Migration 18 turns the switch of remote access on only where both values are saved,
// because only there remote access was on. It keeps the values and the revision.
func TestRemoteSwitchUpgrade(t *testing.T) {
	for _, test := range []struct {
		host, login string
		on          bool
	}{
		{"my-mac.example.ts.net", "user@example.com", true},
		{"my-mac.example.ts.net", "", false},
		{"", "user@example.com", false},
		{"", "", false},
	} {
		t.Run(fmt.Sprintf("%q %q", test.host, test.login), func(t *testing.T) {
			path, db := oldDatabase(t, 17)
			if _, err := db.Exec("UPDATE settings SET data=json_set(data,'$.remoteHost',?,'$.remoteLogin',?) WHERE id=1", test.host, test.login); err != nil {
				t.Fatal(err)
			}
			db.Close()
			store, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			settings, err := store.Settings()
			if err != nil || settings.RemoteOn != test.on || settings.RemoteAccess() != test.on || settings.RemoteHost != test.host || settings.RemoteLogin != test.login || settings.Revision != 9 {
				t.Fatal("wrong remote access after the upgrade", settings, err)
			}
		})
	}
}

func TestUnsupportedDatabasesRemainUnchanged(t *testing.T) {
	for _, test := range []struct {
		name, schema, message string
	}{
		{"prototype", "CREATE TABLE evidence (data BLOB); INSERT INTO evidence VALUES(X'0001FF'); PRAGMA user_version=2", "unsupported history format 2"},
		{"future", fmt.Sprintf("CREATE TABLE evidence (data BLOB); INSERT INTO evidence VALUES(X'0001FF'); PRAGMA user_version=%d", schemaVersion+1), "use a newer bbflow executable"},
		{"unversioned", "CREATE TABLE evidence (data BLOB); INSERT INTO evidence VALUES(X'0001FF')", "unrecognized unversioned"},
		{"view-only", "CREATE VIEW evidence AS SELECT 1", "unrecognized unversioned"},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "history.sqlite")
			db := rawDatabase(t, path)
			execSQL(t, db, test.schema)
			before := snapshotDatabase(t, db)
			db.Close()
			store, err := Open(path)
			if err == nil {
				store.Close()
				t.Fatal("accepted unsupported database")
			}
			if !strings.Contains(err.Error(), test.message) {
				t.Fatal(err)
			}
			assertSnapshot(t, rawDatabase(t, path), before, true)
		})
	}
}

func TestConcurrentUpgrade(t *testing.T) {
	for _, version := range []int{3, 6, 7, 8, 9, 11, 12, 17, 18, 19, 20, 21, 23} {
		t.Run(fmt.Sprint(version), func(t *testing.T) { concurrentUpgrade(t, version) })
	}
}

func concurrentUpgrade(t *testing.T, version int) {
	path, db := oldDatabase(t, version)
	before := snapshotDatabase(t, db)
	db.Close()
	start := make(chan struct{})
	results := make(chan error, 4)
	for range cap(results) {
		go func() {
			<-start
			store, err := Open(path)
			if err == nil {
				err = store.Close()
			}
			results <- err
		}()
	}
	close(start)
	for range cap(results) {
		if err := <-results; err != nil {
			t.Error(err)
		}
	}
	db = rawDatabase(t, path)
	assertSnapshot(t, db, before, false)
	if got := sqlRows(t, db, "PRAGMA user_version"); got[0][0] != int64(schemaVersion) {
		t.Fatal("upgrade was not committed", got)
	}
}

func TestFormat6IndexUpgradeRollsBackAllIndexes(t *testing.T) {
	path, db := oldDatabase(t, 6)
	execSQL(t, db, "CREATE TABLE events_start_run (evidence TEXT); INSERT INTO events_start_run VALUES('keep')")
	before := snapshotDatabase(t, db)
	db.Close()
	if store, err := Open(path); err == nil {
		store.Close()
		t.Fatal("accepted conflicting index name")
	}
	db = rawDatabase(t, path)
	assertSnapshot(t, db, before, true)
	if got := sqlRows(t, db, "SELECT name FROM sqlite_schema WHERE type='index' AND name IN ('events_run','events_output_run')"); len(got) != 0 {
		t.Fatal("partial index migration survived", got)
	}
}

func TestCurrentFormatRequiresRunIndexesWithoutChangingData(t *testing.T) {
	path, db := oldDatabase(t, 6)
	db.Close()
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	execSQL(t, store.db, "DROP INDEX events_output_run")
	before := snapshotDatabase(t, store.db)
	store.Close()
	if store, err = Open(path); err == nil {
		store.Close()
		t.Fatal("accepted current format without the required index")
	}
	assertSnapshot(t, rawDatabase(t, path), before, true)
}

// upgradeTools upgrades a format 16 archive with the tools and returns the store.
func upgradeTools(t *testing.T, tools []map[string]string) *Store {
	t.Helper()
	path, db := oldDatabase(t, 16)
	data, err := json.Marshal(map[string]any{"appearance": "system", "titleTool": "none", "titleCommand": "", "updateCheck": true, "port": 0,
		"remoteHost": "", "remoteLogin": "", "defaultTool": "", "worktree": false, "base": "HEAD", "tools": tools})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("UPDATE settings SET data=? WHERE id=1", string(data)); err != nil {
		t.Fatal(err)
	}
	db.Close()
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

func TestUpgradeKeepsAFullToolListSavable(t *testing.T) {
	var tools []map[string]string
	for i := range 100 {
		tools = append(tools, map[string]string{"id": fmt.Sprintf("tool-%d", i), "name": fmt.Sprintf("Tool %d", i), "command": "./run.sh"})
	}
	store := upgradeTools(t, tools)
	settings, err := store.Settings()
	if err != nil || len(settings.Tools) != 104 {
		t.Fatal(len(settings.Tools), err)
	}
	// The four new built-in tools do not count against the limit of custom tools.
	settings.Appearance = "dark"
	if _, err = store.SaveSettings(settings); err != nil {
		t.Fatal("a full tool list no longer saves after the upgrade:", err)
	}
	settings, _ = store.Settings()
	settings.Tools = append(settings.Tools, Tool{ID: "one-more", Name: "One more", Command: "./run.sh"})
	if _, err = store.SaveSettings(settings); err == nil || !strings.Contains(err.Error(), "at most 100 custom tools") {
		t.Fatal("accepted a 101st custom tool", err)
	}
}

func TestUpgradeGivesNewBuiltinToolsFreeIDsAndNames(t *testing.T) {
	long := "/" + strings.Repeat("a", 540) + "/claude"
	store := upgradeTools(t, []map[string]string{
		{"id": "builtin-codex", "name": "Codex", "command": "codex --search"},
		{"id": "taken", "name": "Codex (built-in)", "command": "./other.sh"},
		{"id": "relative", "name": "Relative", "command": "./bin/claude"},
		{"id": "long", "name": "Long", "command": long},
	})
	settings, err := store.Settings()
	if err != nil {
		t.Fatal(err)
	}
	ids, names := map[string]bool{}, map[string]bool{}
	for _, tool := range settings.Tools {
		if ids[tool.ID] || names[tool.Name] {
			t.Fatalf("two tools share %q or %q: %+v", tool.ID, tool.Name, settings.Tools)
		}
		ids[tool.ID], names[tool.Name] = true, true
		// A relative path or a path over 500 bytes is no CLI path. Such a tool stays a
		// custom tool, and its command stays.
		if (tool.ID == "relative" || tool.ID == "long") && (tool.Builtin || tool.Type != "custom") {
			t.Fatalf("adopted %q as a built-in tool: %+v", tool.ID, tool)
		}
		if tool.ID == "long" && tool.Command != long {
			t.Fatal("changed the command of a custom tool")
		}
	}
	codex := settings.Tools[0]
	if !codex.Builtin || codex.Type != "codex" || codex.ID == "builtin-codex" || !strings.HasPrefix(codex.Name, "Codex (built-in ") {
		t.Fatalf("the new Codex tool did not get a free ID and name: %+v", codex)
	}
	// The upgraded settings save again.
	settings.Appearance = "dark"
	if _, err = store.SaveSettings(settings); err != nil {
		t.Fatal("the upgraded settings do not save:", err)
	}
}
