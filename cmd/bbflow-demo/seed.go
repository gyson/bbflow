package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"maps"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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
	demoAgent, detailAgent, busyAgent := d.addTools()

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
	if stopped.Run == nil || stopped.Worktree == nil {
		fail("session %s has no run or worktree after stop", refactor)
	}
	refactorCommits(stopped.Worktree.Path)
	t = open(d.target, protocol.Request{Operation: "session-continue", Session: refactor, LatestRun: stopped.Run.ID, Tool: demoAgent})
	d.output(t, prompt, 4)
	t.close()

	// A sub-session draft of the worktree session: a reviewer in a new worktree from the
	// branch of its parent.
	review := d.subDraft(refactor, "Review the refactor", demoAgent, func(config *protocol.PreparationConfig) {
		config.Worktree = true
	})
	d.saveDraft(review.ID, "Review the commits of demo/refactor-orbit.")

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

	// A live session with many sent messages and long replies, for the steps between
	// the messages in the terminal.
	t = d.launch(d.draft(orbit, "Tune the orbit solver", detailAgent, nil))
	d.output(t, prompt, 1)
	for turn, message := range solverMessages {
		d.send(t, message)
		d.output(t, prompt, turn+2)
	}
	t.close()

	// A live session that prints output continuously. It starts last, so that the
	// sidebar shows it first.
	t = d.launch(d.draft(tide, "Build tide chart", busyAgent, nil))
	d.output(t, "step 1:", 1)
	t.close()
}

// The sent messages of the session Tune the orbit solver. One message is longer than a
// terminal row, and two messages have the same text.
var solverMessages = []string{
	"Read the solver in internal/orbit and explain how it picks the next step.",
	"Why does the step get smaller near the periapsis?",
	"Add a tolerance setting. Keep the default at the current value, validate that it is positive, and return an error that names the setting when it is not.",
	"Run the tests.",
	"The test for a circular orbit fails. Find the cause, but do not change the fixture.",
	"Run the tests.",
	"Update the design note with the new setting.",
	"Summarize the changes for the pull request.",
}

func (d *demo) output(t *terminal, text string, count int) {
	output(d.target, t.session, text, count)
}

// addTools saves the tools in Settings and returns the IDs of the simulated tools. The
// built-in Claude Code and Codex tools run the real CLIs of the user. The seed never
// starts them.
func (d *demo) addTools() (demoAgent, detailAgent, busyAgent string) {
	check(os.MkdirAll(filepath.Dir(d.agent), 0o755))
	// The copy keeps the tools usable after a checkout of a different commit.
	check(os.WriteFile(d.agent, demoAgentScript, 0o644))
	command := "sh " + shellQuote(d.agent)
	agent := history.Tool{ID: history.ID(), Name: "Demo agent", Command: command}
	detail := history.Tool{ID: history.ID(), Name: "Detail agent", Command: command + " --detail"}
	busy := history.Tool{ID: history.ID(), Name: "Busy agent", Command: command + " --busy"}
	settings := call[history.Settings](d.target, protocol.Request{Operation: "settings-get"})
	// The built-in Claude Code and Codex tools are on, and Antigravity and Code Puppy are
	// off, whatever CLIs this computer has. The simulated tools follow the built-in tools.
	for i := range settings.Tools {
		tool := &settings.Tools[i]
		tool.Enabled = tool.Type == "claude" || tool.Type == "codex"
	}
	settings.Tools = append(settings.Tools, agent, detail, busy)
	settings.DefaultTool = agent.ID
	// New drafts in Git folders select Use worktree.
	settings.Worktree = true
	call[json.RawMessage](d.target, protocol.Request{Operation: "settings-save", Settings: &settings})
	return agent.ID, detail.ID, busy.ID
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

// subDraft creates a sub-session draft of a session and saves its launch choices. tool
// is a tool ID, or empty for Shell.
func (d *demo) subDraft(parent, name, tool string, change func(*protocol.PreparationConfig)) protocol.SessionDetail {
	session := call[protocol.SessionDetail](d.target, protocol.Request{Operation: "project-draft", Parent: parent})
	if session.Preparation == nil || session.ParentID != parent {
		fail("sub-session draft %s has no preparation or another parent", session.ID)
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
	// Remove inherited Git variables. GIT_DIR and GIT_WORK_TREE select a repository even
	// with -C, and other variables add configuration. Ignore the Git configuration of the
	// user too: signing, hooks, and templates.
	for _, variable := range os.Environ() {
		if !strings.HasPrefix(variable, "GIT_") {
			command.Env = append(command.Env, variable)
		}
	}
	command.Env = append(command.Env, "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
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

// commit writes files and commits only these files. Other changes stay uncommitted.
func commit(folder, message string, files map[string]string) {
	write(folder, files)
	paths := slices.Sorted(maps.Keys(files))
	git(folder, append([]string{"add", "--"}, paths...)...)
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

// controller is a file in a deep folder with a long name. Its path is wider than the
// default file list, for a check of the file list divider.
const controller = "internal/orbit/propagation/numerical/integrators/runge_kutta/adaptive_step_size_controller.go"

var step = lines(
	"package runge_kutta",
	"",
	"// NextStep returns the next step size in seconds for an error estimate.",
	"func NextStep(step, estimate, tolerance float64) float64 {",
	"\tif estimate == 0 {",
	"\t\treturn step * 2",
	"\t}",
	"\treturn step * 0.9 * tolerance / estimate",
	"}",
)

// orbitPNG draws a planet on a circular orbit, with a transparent background. The
// working files change the color of the planet and add a moon.
func orbitPNG(planet color.NRGBA, moon bool) string {
	const size = 96
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	for y := range size {
		for x := range size {
			switch d := math.Hypot(float64(x)-47.5, float64(y)-47.5); {
			case d < 14:
				img.SetNRGBA(x, y, planet)
			case d > 38 && d < 41:
				img.SetNRGBA(x, y, color.NRGBA{0x46, 0x85, 0x65, 0xff})
			}
			if moon && math.Hypot(float64(x)-77.5, float64(y)-25.5) < 7 {
				img.SetNRGBA(x, y, color.NRGBA{0xb0, 0xb0, 0xb8, 0xff})
			}
		}
	}
	var out bytes.Buffer
	check(png.Encode(&out, img))
	return out.String()
}

// largePNG draws a 1400 × 900 color gradient with noise. The noise keeps the PNG file
// above 1 MiB, the text limit of the file views. Its fixed values give the same file
// for each seed.
func largePNG() string {
	img := image.NewRGBA(image.Rect(0, 0, 1400, 900))
	noise := uint32(1)
	for y := range 900 {
		for x := range 1400 {
			noise ^= noise << 13
			noise ^= noise >> 17
			noise ^= noise << 5
			img.SetRGBA(x, y, color.RGBA{uint8(x * 255 / 1400), uint8(noise), uint8(y * 255 / 900), 0xff})
		}
	}
	var out bytes.Buffer
	check(png.Encode(&out, img))
	return out.String()
}

// orbitSVG has only a viewBox, as many icon files do.
func orbitSVG(shapes ...string) string {
	return lines(append(append([]string{`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">`}, shapes...), "</svg>")...)
}

// unsafeSVG tries to change the page title and to load an external image. In the image
// view, it shows only a red rectangle and the placeholder of the external image. The
// .invalid domain never resolves.
var unsafeSVG = lines(
	`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" onload="parent.document.title='onload ran'">`,
	`  <script>parent.document.title = 'script ran'</script>`,
	`  <rect width="200" height="120" fill="#c33"/>`,
	`  <image href="https://example.invalid/tracker.png" width="50" height="50"/>`,
	`</svg>`,
)

// orbitProject has three commits and one change of each kind in its working files. A
// file in a deep folder has a long path. A PNG and an SVG file change too. Two added
// files are a PNG file above 1 MiB and an SVG file with a script. An untracked
// HTML report with a style sheet is for Open in browser. Its script shows that it ran,
// and it shows the page origin.
func (d *demo) orbitProject() string {
	folder := d.repository("orbit-api")
	commit(folder, "Add the orbit service skeleton", map[string]string{
		"README.md":                lines("# Orbit API", "", "A simulated service for the bbflow demo instance."),
		"go.mod":                   lines("module example.invalid/orbit", "", "go 1.27"),
		"cmd/server/main.go":       lines("package main", "", `import "fmt"`, "", "func main() {", "\tfmt.Println(\"orbit api\")", "}"),
		"internal/orbit/period.go": period,
		"docs/orbit.png":           orbitPNG(color.NRGBA{0x4a, 0x64, 0xa8, 0xff}, false),
		"docs/orbit.svg": orbitSVG(`  <circle cx="48" cy="48" r="39" fill="none" stroke="#468565" stroke-width="3"/>`,
			`  <circle cx="48" cy="48" r="14" fill="#4a64a8"/>`),
	})
	commit(folder, "Add period tests and the design note", map[string]string{
		"internal/orbit/period_test.go": lines("package orbit", "", `import "testing"`, "", "func TestPeriod(t *testing.T) {",
			"\tif Period(7e6, 3.986e14) < 5000 {", "\t\tt.Fatal(\"period is too short\")", "\t}", "}"),
		"docs/design.md": lines("# Design", "", "The service calculates orbit periods from the semi-major axis."),
		controller:       step,
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
		controller:       step + lines("", "// MinStep is the smallest step size in seconds.", "const MinStep = 1e-3"),
		"docs/orbit.png": orbitPNG(color.NRGBA{0xd9, 0x82, 0x2b, 0xff}, true),
		"docs/orbit.svg": orbitSVG(`  <ellipse cx="48" cy="48" rx="42" ry="26" fill="none" stroke="#468565" stroke-width="3"/>`,
			`  <circle cx="48" cy="48" r="14" fill="#d9822b"/>`, `  <circle cx="84" cy="36" r="6" fill="#b0b0b8"/>`),
		"docs/large.png":           largePNG(),
		"docs/unsafe.svg":          unsafeSVG,
		"reports/test-report.html": testReport,
		"reports/report.css": lines("body { font: 15px system-ui, sans-serif; margin: 2rem; max-width: 40rem; }",
			"td { padding: 4px 16px 4px 0; }", ".pass { color: #2f7a4f; }", ".fail { color: #a24139; }",
			"#script { color: #65736a; font-size: 13px; }"),
	})
	check(os.Remove(filepath.Join(folder, "docs", "design.md")))
	git(folder, "mv", "docs/api.md", "docs/http-api.md")
	return folder
}

// testReport is a simulated report of an agent. Its style sheet is a relative link.
var testReport = lines(
	"<!doctype html>",
	`<html lang="en">`,
	`<meta charset="utf-8">`,
	"<title>Orbit API test report</title>",
	`<link rel="stylesheet" href="report.css">`,
	"<h1>Orbit API test report</h1>",
	"<p>3 tests passed. 1 test failed.</p>",
	"<table>",
	`  <tr><td>TestPeriod</td><td class="pass">pass</td></tr>`,
	`  <tr><td>TestMinutes</td><td class="pass">pass</td></tr>`,
	`  <tr><td>TestNextStep</td><td class="pass">pass</td></tr>`,
	`  <tr><td>TestTransfer</td><td class="fail">fail: Transfer is not implemented</td></tr>`,
	"</table>",
	`<p id="script">The script of this page did not run.</p>`,
	"<script>",
	"  document.getElementById('script').textContent = 'The script of this page ran. Its origin is ' + self.origin + '.';",
	"</script>",
)

var kepler = lines(
	"package orbit",
	"",
	`import "math"`,
	"",
	"// keplerPeriod applies Kepler's third law.",
	"func keplerPeriod(axis, mu float64) float64 {",
	"\treturn 2 * math.Pi * math.Sqrt(math.Pow(axis, 3)/mu)",
	"}",
)

// refactorCommits adds three commits to the worktree of the refactor session, as an
// agent can do. The file from /edit stays uncommitted. Thus the scope menu offers all
// changes since the worktree base, the uncommitted changes, and each commit.
func refactorCommits(worktree string) {
	periodCall := lines(
		"package orbit",
		"",
		"// Period returns the orbit period in seconds for a semi-major axis in meters.",
		"func Period(axis, mu float64) float64 {",
		"\treturn keplerPeriod(axis, mu)",
		"}",
	)
	commit(worktree, "Move the period math to kepler.go", map[string]string{
		"internal/orbit/kepler.go": kepler,
		"internal/orbit/period.go": periodCall,
	})
	commit(worktree, "Add a Minutes helper", map[string]string{
		"internal/orbit/period.go": periodCall + lines("", "// Minutes returns the orbit period in minutes.",
			"func Minutes(axis, mu float64) float64 {", "\treturn Period(axis, mu) / 60", "}"),
	})
	commit(worktree, "Explain kepler.go in the design note", map[string]string{
		"docs/design.md": lines("# Design", "", "The service calculates orbit periods from the semi-major axis.",
			"", "`kepler.go` holds the math. `period.go` holds the exported functions."),
	})
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
