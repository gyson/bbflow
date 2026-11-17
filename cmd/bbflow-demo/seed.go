package main

import (
	_ "embed"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"bbflow/internal/history"
	"bbflow/internal/protocol"
)

// The seed uses the WebSocket protocol of docs/PROTOCOL.md, as the web UI does. When a
// change breaks the seed, update it in the same change. TestDemo runs it against a real
// server.

//go:embed demo-agent.sh
var demoAgentScript []byte

// The Demo agent prints this prompt when it waits for a line.
const prompt = "demo> "

// addData adds the simulated projects, tools, and sessions.
func (d *demo) addData() {
	orbit := call[history.Project](d.target, protocol.Request{Operation: "project-add", Workspace: d.orbitProject(), Name: "Orbit API"}).ID
	tide := call[history.Project](d.target, protocol.Request{Operation: "project-add", Workspace: d.tideProject(), Name: "Tide Web"}).ID
	demoAgent, busyAgent := d.addTools()

	// An ended session with sent messages and a file change from the agent.
	t := d.launch(d.draft(orbit, "Add orbit period endpoint", demoAgent, nil))
	d.output(t, prompt, 1)
	d.send(t, "Add an endpoint that returns the orbit period.")
	d.output(t, prompt, 2)
	t.input("/edit\r")
	d.output(t, prompt, 3)
	d.send(t, "Run the tests and report the result.")
	d.output(t, prompt, 4)
	t.input("/exit\r")
	d.output(t, "Goodbye.", 1)
	t.input("exit\r")
	t.wait()
	t.close()

	// A worktree session with two terminals. The first is stopped. The second is live.
	t = d.launch(d.draft(orbit, "Refactor orbit in a worktree", demoAgent, func(config *protocol.PreparationConfig) {
		config.Worktree, config.Branch = true, "demo/refactor-orbit"
	}))
	refactor := t.session
	d.output(t, prompt, 1)
	d.send(t, "Move the period code to its own file.")
	d.output(t, prompt, 2)
	t.input("/edit\r")
	d.output(t, prompt, 3)
	call[json.RawMessage](d.target, protocol.Request{Operation: "session-stop", Session: refactor})
	t.wait()
	t.close()
	stopped := call[protocol.SessionDetail](d.target, protocol.Request{Operation: "session-config", Session: refactor})
	if stopped.Run == nil {
		fail("session %s has no run after stop", refactor)
	}
	t = open(d.target, protocol.Request{Operation: "session-continue", Session: refactor, LatestRun: stopped.Run.ID, Tool: demoAgent})
	d.output(t, prompt, 4)
	t.close()

	// A live session that waits for input, with a message that is not sent.
	t = d.launch(d.draft(orbit, "Review test failures", demoAgent, nil))
	d.output(t, prompt, 1)
	d.send(t, "Why does TestPeriod fail?")
	d.output(t, prompt, 2)
	d.saveDraft(t.session, "Also check the rounding in period.go.")
	t.close()

	// An archived, ended shell session.
	t = d.launch(d.draft(tide, "Old layout spike", "", nil))
	spike := t.session
	d.runShell(t)
	call[json.RawMessage](d.target, protocol.Request{Operation: "session-archive", Session: spike, Archived: true})

	// A draft that did not start.
	plan := d.draft(tide, "Plan release notes", demoAgent, func(config *protocol.PreparationConfig) {
		config.Worktree, config.Base = true, "feature/tide-chart"
	})
	d.saveDraft(plan.ID, "List the changes since the last release.")

	// An ended shell session in the built-in General project.
	d.runShell(d.launch(d.draft("general", "Scratch shell", "", nil)))

	// A live session that prints output continuously. It starts last, so that the
	// sidebar shows it first.
	t = d.launch(d.draft(tide, "Build tide chart", busyAgent, nil))
	d.output(t, "step 1:", 1)
	t.close()
}

func (d *demo) output(t *terminal, text string, count int) {
	output(d.target, t.session, text, count)
}

// addTools saves the tools in Settings and returns the IDs of the simulated tools. The
// Claude and Codex tools run the real CLIs of the user. The seed never starts them.
func (d *demo) addTools() (demoAgent, busyAgent string) {
	check(os.MkdirAll(filepath.Dir(d.agent), 0o755))
	// The copy keeps the tools usable after a checkout of a different commit.
	check(os.WriteFile(d.agent, demoAgentScript, 0o644))
	command := "sh " + shellQuote(d.agent)
	agent := history.Tool{ID: history.ID(), Name: "Demo agent", Command: command, ContinueCommand: command + " --handoff " + history.PromptPlaceholder}
	busy := history.Tool{ID: history.ID(), Name: "Busy agent", Command: command + " --busy"}
	settings := call[history.Settings](d.target, protocol.Request{Operation: "settings-get"})
	claude := history.Tool{ID: history.ID(), Name: "Claude", Command: "claude", ContinueCommand: "claude " + history.PromptPlaceholder}
	codex := history.Tool{ID: history.ID(), Name: "Codex", Command: "codex --no-alt-screen", ContinueCommand: "codex --no-alt-screen " + history.PromptPlaceholder}
	settings.Tools = append(settings.Tools, agent, busy, claude, codex)
	settings.DefaultTool = agent.ID
	// New drafts in Git folders select Use worktree.
	settings.Worktree = true
	call[json.RawMessage](d.target, protocol.Request{Operation: "settings-save", Settings: &settings})
	return agent.ID, busy.ID
}

// draft creates a draft session and saves its launch choices. tool is a tool ID, or
// empty for Shell.
func (d *demo) draft(project, name, tool string, change func(*protocol.PreparationConfig)) protocol.SessionDetail {
	session := call[protocol.SessionDetail](d.target, protocol.Request{Operation: "project-draft", Project: project})
	if session.Preparation == nil {
		fail("draft %s has no preparation", session.ID)
	}
	config := protocol.PreparationConfig{Revision: session.Preparation.Revision, ToolID: tool, Base: session.Preparation.Base}
	if change != nil {
		change(&config)
	}
	return call[protocol.SessionDetail](d.target, protocol.Request{Operation: "session-config", Session: session.ID, Name: name, Preparation: &config})
}

func (d *demo) launch(session protocol.SessionDetail) *terminal {
	return open(d.target, protocol.Request{Operation: "session-start", Session: session.ID, Revision: session.Preparation.Revision})
}

// send sends a message as the message editor does: save the pending draft, write the
// input, then clear the draft. The message then shows in the sent messages of the
// session.
func (d *demo) send(t *terminal, text string) {
	current := d.composer(t.session, nil)
	pending := d.composer(t.session, &protocol.Draft{Revision: current.Draft.Revision, Text: text, Attachments: []int64{}, Pending: true})
	t.input(text + "\r")
	d.composer(t.session, &protocol.Draft{Revision: pending.Draft.Revision, Attachments: []int64{}})
}

func (d *demo) saveDraft(session, text string) {
	current := d.composer(session, nil)
	d.composer(session, &protocol.Draft{Revision: current.Draft.Revision, Text: text, Attachments: []int64{}})
}

// composer reads the draft of a session, or saves draft when it is not nil.
func (d *demo) composer(session string, draft *protocol.Draft) protocol.Composer {
	composer := call[protocol.Composer](d.target, protocol.Request{Operation: "composer-draft", Session: session, Draft: draft})
	if composer.Rejected {
		fail("the server rejected the draft of session %s", session)
	}
	return composer
}

// runShell ends a shell session. It first waits for the output of a command, because
// bbflow does not detect when a shell is ready.
func (d *demo) runShell(t *terminal) {
	t.input("printf 'demo %s\\n' ready; ls\r")
	d.output(t, "demo ready", 1)
	t.input("exit\r")
	t.wait()
	t.close()
}

func shellQuote(text string) string {
	return "'" + strings.ReplaceAll(text, "'", `'\''`) + "'"
}

// --- Simulated repositories ---

func git(folder string, args ...string) {
	command := exec.Command("git", append([]string{"-C", folder}, args...)...)
	// Ignore the Git configuration of the user: signing, hooks, and templates.
	command.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		fail("git %s: %w", strings.Join(args, " "), err)
	}
}

// lines joins lines of a file, with a final newline.
func lines(text ...string) string {
	return strings.Join(text, "\n") + "\n"
}

func write(folder string, files map[string]string) {
	for path, text := range files {
		path = filepath.Join(folder, path)
		check(os.MkdirAll(filepath.Dir(path), 0o755))
		check(os.WriteFile(path, []byte(text), 0o644))
	}
}

func commit(folder, message string, files map[string]string) {
	write(folder, files)
	git(folder, "add", "--all")
	git(folder, "commit", "--quiet", "--message", message)
}

func (d *demo) repository(name string) string {
	folder := filepath.Join(d.projects, name)
	check(os.MkdirAll(folder, 0o755))
	git(folder, "init", "--quiet", "--initial-branch", "main")
	// Local settings let the agent and the user commit in this repository later.
	git(folder, "config", "user.name", "bbflow demo")
	git(folder, "config", "user.email", "demo@example.invalid")
	git(folder, "config", "commit.gpgsign", "false")
	return folder
}

var period = lines(
	"package orbit",
	"",
	`import "math"`,
	"",
	"// Period returns the orbit period in seconds for a semi-major axis in meters.",
	"func Period(axis, mu float64) float64 {",
	"\treturn 2 * math.Pi * math.Sqrt(axis*axis*axis/mu)",
	"}",
)

// orbitProject has three commits and one change of each kind in its working files.
func (d *demo) orbitProject() string {
	folder := d.repository("orbit-api")
	commit(folder, "Add the orbit service skeleton", map[string]string{
		"README.md":                lines("# Orbit API", "", "A simulated service for the bbflow demo instance."),
		"go.mod":                   lines("module example.invalid/orbit", "", "go 1.27"),
		"cmd/server/main.go":       lines("package main", "", `import "fmt"`, "", "func main() {", "\tfmt.Println(\"orbit api\")", "}"),
		"internal/orbit/period.go": period,
	})
	commit(folder, "Add period tests and the design note", map[string]string{
		"internal/orbit/period_test.go": lines("package orbit", "", `import "testing"`, "", "func TestPeriod(t *testing.T) {",
			"\tif Period(7e6, 3.986e14) < 5000 {", "\t\tt.Fatal(\"period is too short\")", "\t}", "}"),
		"docs/design.md": lines("# Design", "", "The service calculates orbit periods from the semi-major axis."),
	})
	commit(folder, "Document the HTTP API", map[string]string{
		"docs/api.md": lines("# HTTP API", "", "`GET /period?axis=METERS` returns the orbit period in seconds."),
		"README.md":   lines("# Orbit API", "", "A simulated service for the bbflow demo instance.", "", "See `docs/api.md` for the HTTP API."),
	})
	write(folder, map[string]string{
		"internal/orbit/period.go": period + lines("", "// Minutes returns the orbit period in minutes.",
			"func Minutes(axis, mu float64) float64 {", "\treturn Period(axis, mu) / 60", "}"),
		"internal/orbit/transfer.go": lines("package orbit", "", "// Transfer is not implemented.",
			"func Transfer(from, to float64) float64 {", "\treturn 0", "}"),
	})
	check(os.Remove(filepath.Join(folder, "docs", "design.md")))
	git(folder, "mv", "docs/api.md", "docs/http-api.md")
	return folder
}

// tideProject has clean working files and a second branch for the base selection.
func (d *demo) tideProject() string {
	folder := d.repository("tide-web")
	app := func(tides string) string {
		return lines("const tides = ["+tides+"];",
			"document.querySelector('#tides').textContent = tides.map(tide => tide.join(' ')).join(', ');")
	}
	commit(folder, "Add the tide table page", map[string]string{
		"index.html": lines("<!doctype html>", "<title>Tide Web</title>", `<link rel="stylesheet" href="src/style.css">`,
			`<main id="tides"></main>`, `<script type="module" src="src/app.js"></script>`),
		"src/app.js":    app("['06:12', 'high'], ['12:31', 'low']"),
		"src/style.css": lines("main {", "  font: 16px system-ui;", "  margin: 2rem;", "}"),
		"package.json":  lines("{", `  "name": "tide-web",`, `  "private": true,`, `  "type": "module"`, "}"),
	})
	git(folder, "switch", "--quiet", "--create", "feature/tide-chart")
	commit(folder, "Add an empty tide chart", map[string]string{
		"src/chart.js": lines("export function chart(tides) {", "  return tides.length;", "}"),
	})
	git(folder, "switch", "--quiet", "main")
	commit(folder, "Show the next high tide", map[string]string{
		"src/app.js": app("['06:12', 'high'], ['12:31', 'low'], ['18:40', 'high']"),
	})
	return folder
}
