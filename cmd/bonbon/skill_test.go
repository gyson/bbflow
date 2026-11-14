package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"bonbon/internal/history"
)

func TestSkillCommandPrintsGuideWithoutInstance(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "absent")
	output, err := testCommand("--dir", directory, "skill").Output()
	if err != nil || string(output) != skillText || !strings.HasPrefix(skillText, "# BonBon skill for agents\n") {
		t.Fatalf("skill: %s %v", output, err)
	}
	for _, tc := range []struct {
		args []string
		want string
		ok   bool
	}{
		{[]string{"skill", "--help"}, "Usage: bonbon skill", true},
		{[]string{"--help"}, "bonbon skill", true},
		{[]string{"skill", "extra"}, "takes no arguments", false},
	} {
		output, err := testCommand(append([]string{"--dir", directory}, tc.args...)...).CombinedOutput()
		if (err == nil) != tc.ok || !strings.Contains(string(output), tc.want) {
			t.Fatalf("%v: %s %v", tc.args, output, err)
		}
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatal("skill accessed the instance", err)
	}
}

// The guide must name every table and column of the current schema, and no others.
// This test fails after a migration until the guide is updated.
func TestSkillTablesMatchSchema(t *testing.T) {
	store := archive(t, t.TempDir())
	tables, err := store.Query(context.Background(), "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
	if err != nil || len(tables.Rows) == 0 {
		t.Fatal(tables, err)
	}
	documented := make(map[string][]string)
	table := ""
	heading := regexp.MustCompile("^### `([a-z_]+)`$")
	row := regexp.MustCompile("^\\| `([a-z_]+)` \\|")
	for _, line := range strings.Split(skillText, "\n") {
		if strings.HasPrefix(line, "#") || strings.HasPrefix(line, "Event kinds") {
			table = ""
			if match := heading.FindStringSubmatch(line); match != nil {
				table = match[1]
				documented[table] = []string{}
			}
		} else if match := row.FindStringSubmatch(line); match != nil && table != "" {
			documented[table] = append(documented[table], match[1])
		}
	}
	for _, values := range tables.Rows {
		name := values[0].(string)
		result, err := store.Query(context.Background(), "SELECT * FROM "+name+" LIMIT 0")
		if err != nil {
			t.Fatal(err)
		}
		if strings.Join(documented[name], ",") != strings.Join(result.Columns, ",") {
			t.Errorf("table %s: guide has %v, schema has %v", name, documented[name], result.Columns)
		}
		delete(documented, name)
	}
	if len(documented) != 0 {
		t.Errorf("guide has tables that the schema does not have: %v", documented)
	}
}

// Each example runs through a shell, the same as an agent runs it.
func TestSkillExamplesRun(t *testing.T) {
	directory := t.TempDir()
	startTestServer(t, directory)
	store := archive(t, directory)
	session, err := store.CreateSession("skill", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	other, _ := store.CreateSession("other", t.TempDir(), "")
	store.Append(session.ID, "run", "start", []byte(`{"tool":"Codex"}`), "")
	store.Append(session.ID, "run", "output", []byte("\x1b[1mfixture\x1b[0m"), "fixture")
	store.Append(session.ID, "", "draft", []byte(`{"text":"not sent","attachments":[],"pending":false}`), "")
	store.Append(session.ID, "", "draft", []byte(`{"text":"sent message","attachments":[],"pending":true}`), "")
	store.Append(other.ID, "", "draft", []byte(`{"text":"other session","attachments":[],"pending":true}`), "")

	bin := t.TempDir()
	executable, _ := os.Executable()
	if err := os.Symlink(executable, filepath.Join(bin, "bonbon")); err != nil {
		t.Fatal(err)
	}
	examples := regexp.MustCompile("(?m)^```sh\n(bonbon query .+)\n```$").FindAllStringSubmatch(skillText, -1)
	if len(examples) < 8 {
		t.Fatalf("found %d examples", len(examples))
	}
	results := make(map[string]history.QueryResult)
	for _, example := range examples {
		command := exec.Command("/bin/sh", "-c", example[1])
		command.Env = append(os.Environ(), "BONBON_TEST_CLI=1", "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"),
			"BONBON_DIR="+directory, "BONBON_SESSION="+session.ID)
		output, err := command.Output()
		var result history.QueryResult
		if err != nil || json.Unmarshal(output, &result) != nil || len(result.Columns) == 0 {
			t.Fatalf("%s: %s %v", example[1], output, err)
		}
		if strings.Contains(example[1], "AS message") {
			results["message"] = result
		}
		if strings.Contains(example[1], "AS start") {
			results["start"] = result
		}
	}
	if rows := results["message"].Rows; len(rows) != 1 || rows[0][2] != "sent message" {
		t.Fatalf("messages: %+v", rows)
	}
	if rows := results["start"].Rows; len(rows) != 1 || rows[0][2] != `{"tool":"Codex"}` {
		t.Fatalf("start: %+v", rows)
	}
}
