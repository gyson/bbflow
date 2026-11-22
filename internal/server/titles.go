package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"bbflow/internal/protocol"
)

const (
	// titleTimeout limits one title command. Agent CLIs can need several seconds to start.
	titleTimeout = 90 * time.Second
	// titleInput limits the message text that the title command receives.
	titleInput = 2000
	// titleOutput limits the output that the server reads from the title command.
	titleOutput = 64 << 10
	// titleRunes is the maximum length of a session name.
	titleRunes = 200
)

// titleTools holds the command of each title tool in history.TitleTools, except none.
// Each command reads the request on standard input and selects a small model. The Claude
// and Codex commands turn off the agent tools, hooks, plugins, and MCP servers of their
// CLI, so that the model gets only the request text. Code Puppy turns off its tools and
// MCP servers, but it always loads the user plugins. Apple runs the on-device model of
// macOS, which has no tools in this command. The empty temporary folder is not a file
// access limit. Tests replace the commands.
var titleTools = []protocol.TitleTool{
	// --restricted ignores the settings files, with their hooks and plugins. It also
	// limits @ file references to the working folder. --tools "" turns off all
	// built-in tools.
	{ID: "claude", Name: "Claude", Command: `claude -p --model haiku --restricted --tools "" --strict-mcp-config`},
	// --ignore-user-config skips config.toml, with its hooks, MCP servers, and slow
	// reasoning effort, but keeps the sign-in. The read-only sandbox and the disabled
	// features remove the tools that read files or run code. --ephemeral saves no
	// session.
	{ID: "codex", Name: "Codex", Command: "codex exec --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules " +
		"--sandbox read-only --disable shell_tool --disable unified_exec --disable view_image --disable code_mode_host " +
		"--disable apps --disable plugins --disable hooks --disable multi_agent --disable browser_use --disable computer_use " +
		"--disable image_generation --disable mentions_v2 -c web_search=disabled --model gpt-6-luna -c model_reasoning_effort=low -"},
	// Code Puppy takes the prompt only as an argument. "$(cat)" reads standard input, and
	// the shell does not parse the text again. --no-tools turns off its tools and MCP
	// servers. It always attaches existing files whose paths are in the prompt, so
	// titleRequest masks paths.
	{ID: "code-puppy", Name: "Code Puppy", Command: `code-puppy --no-tools --model codex-gpt-6-luna -p "$(cat)"`},
	// fm is the Apple Foundation Models CLI of macOS 27. Without a prompt argument, it
	// reads the prompt from standard input. --model system keeps the request on the
	// on-device model. The permissive guardrail level is for transformations of the
	// supplied text, such as a summary. --greedy gives the same title for the same
	// message. --no-stream prints the answer once.
	{ID: "apple", Name: "Apple", Command: "fm respond --model system --guardrails permissive-content-transformations --greedy --no-stream"},
}

// pathMask replaces the characters that start or separate a local path in the message.
// The look-alike characters keep the text readable for the model. No path, home
// reference, or link in the masked text names a file. cleanTitle changes them back.
var pathMask = strings.NewReplacer("/", "\u2215", "~", "\u223c")
var pathUnmask = strings.NewReplacer("\u2215", "/", "\u223c", "~")

// titleCommand returns the command of a title tool.
func titleCommand(tool string) (string, error) {
	for _, candidate := range titleTools {
		if candidate.ID == tool {
			return candidate.Command, nil
		}
	}
	if tool == "" || tool == "none" {
		return "", errors.New("choose a title tool")
	}
	return "", fmt.Errorf("unknown title tool %q", tool)
}

// titleMarker starts the answer line. Agent CLIs can print status lines, the request,
// and errors on standard output, also with exit status 0. The marker separates the
// answer from that output. The instruction describes the marker but does not contain
// it, so that a CLI that prints the request back does not print a marker.
const titleMarker = "bbflow-title:"

// Keep plain text at the start of the request. Some CLIs treat a prompt that starts
// with "!" or "/" as a command.
const titleInstruction = `Write a short title for a work session. The session starts with the user message below.
Use at most 8 words. Use the language of the message. Do not use quotes, Markdown, or a period at the end.
Reply with one line only. Start the line with the word bbflow-title and a colon, then write the title.

<message>
%s
</message>
`

// titleRequest returns the standard input for the title command. It cuts the message
// at a rune boundary and masks local paths. It breaks each marker in the message, so
// that the message cannot supply the answer line.
func titleRequest(message string) string {
	message = pathMask.Replace(strings.TrimSpace(message))
	if len(message) > titleInput {
		cut := titleInput
		for cut > 0 && !utf8.RuneStart(message[cut]) {
			cut--
		}
		message = message[:cut] + "…"
	}
	for i := markerIndex(message); i >= 0; i = markerIndex(message) {
		message = message[:i+len(titleMarker)-1] + " :" + message[i+len(titleMarker):]
	}
	return fmt.Sprintf(titleInstruction, message)
}

// markerIndex returns the byte index of the first title marker in text, in any letter
// case, or -1.
func markerIndex(text string) int {
	for i := 0; i+len(titleMarker) <= len(text); i++ {
		if strings.EqualFold(text[i:i+len(titleMarker)], titleMarker) {
			return i
		}
	}
	return -1
}

// terminalEscapes matches the escape sequences for colors, cursor control, and links. A
// CLI can print them also when its output is not a terminal. For example, fm prints
// its license error in color.
var terminalEscapes = regexp.MustCompile(`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]*[0-~])`)

// parseTitle reads the title from the command output. It uses the last line that
// starts with the marker, after Markdown marks and spaces. Other output is rejected,
// because it can be an error message or a status line.
func parseTitle(output string) (string, error) {
	output = terminalEscapes.ReplaceAllString(output, "")
	lines := 0
	for _, line := range slices.Backward(strings.Split(output, "\n")) {
		line = strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return ' '
			}
			return r
		}, line)
		if line = strings.Join(strings.Fields(line), " "); line == "" {
			continue
		}
		lines++
		answer := strings.TrimLeft(line, "#>*-•`_ ")
		if len(answer) < len(titleMarker) || !strings.EqualFold(answer[:len(titleMarker)], titleMarker) {
			continue
		}
		if answer = cleanTitle(answer[len(titleMarker):]); answer == "" {
			return "", errors.New("the command printed an empty title")
		}
		return answer, nil
	}
	if lines == 0 {
		return "", errors.New("the command printed no title")
	}
	first := ""
	for _, line := range strings.Split(output, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			first = cleanTitle(line)
			break
		}
	}
	return "", fmt.Errorf("the command printed %d lines, but no line starts with %s. First line: %s", lines, titleMarker, first)
}

// cleanTitle removes common labels, quotes, and Markdown marks from one line. It changes
// masked path characters back. It keeps at most titleRunes characters.
func cleanTitle(line string) string {
	line = pathUnmask.Replace(line)
	for {
		before := line
		line = strings.TrimLeft(line, "#>*-• ")
		if len(line) >= 6 && strings.EqualFold(line[:6], "title:") {
			line = line[6:]
		}
		line = strings.TrimSpace(line)
		line = strings.Trim(line, "\"'`*_“”‘’「」")
		line = strings.TrimRight(line, ".。 ")
		if line == before {
			break
		}
	}
	if runes := []rune(line); len(runes) > titleRunes {
		line = strings.TrimSpace(string(runes[:titleRunes]))
	}
	return line
}

// limitedBuffer keeps the first limit bytes and discards the rest.
type limitedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := b.limit - b.Len(); room > 0 {
		b.Buffer.Write(p[:min(room, len(p))])
	}
	return len(p), nil
}

// runTitleCommand runs the title command once through the server shell. The command is
// not an interactive shell, and it is not a session terminal. It runs in an empty
// temporary folder, so that agent CLIs do not read project files. The request goes to
// standard input. The server never puts message text in the command line.
func runTitleCommand(ctx context.Context, command, message string) (string, error) {
	if strings.TrimSpace(command) == "" {
		return "", errors.New("the title command is empty")
	}
	if strings.TrimSpace(message) == "" {
		return "", errors.New("message is empty")
	}
	shell, env, err := serverShell()
	if err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp("", "bbflow-title-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithTimeout(ctx, titleTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, shell, "-c", command)
	cmd.Dir, cmd.Env = dir, env
	cmd.Stdin = strings.NewReader(titleRequest(message))
	stdout := &limitedBuffer{limit: titleOutput}
	stderr := &limitedBuffer{limit: 4 << 10}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	// Stop the whole process group. An agent CLI can start child processes.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	err = cmd.Run()
	if ctx.Err() != nil {
		return "", fmt.Errorf("the command did not finish in %s", titleTimeout)
	}
	if err != nil {
		detail := strings.TrimSpace(terminalEscapes.ReplaceAllString(stderr.String(), ""))
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 127 {
			return "", fmt.Errorf("the CLI is not installed or not on the PATH of the server: %s", detail)
		}
		if detail == "" {
			return "", fmt.Errorf("the command ended with %w", err)
		}
		return "", fmt.Errorf("the command ended with %w: %s", err, detail)
	}
	return parseTitle(stdout.String())
}

// receiptPrefix starts the input ID of a send from the message editor. The rest is the
// pending draft revision of the send.
const receiptPrefix = "draft-"

// titleAfterReceipt runs on the PTY goroutine after the PTY accepts an input with an
// ID. For a send from the message editor, the ID names its pending draft revision, and
// data holds the accepted bytes. The first such send with text claims the title of the
// session, in the order that the PTY accepts input. Only the command runs later in a job.
func (s *Server) titleAfterReceipt(sid, inputID string, data []byte) {
	revision, err := strconv.ParseInt(strings.TrimPrefix(inputID, receiptPrefix), 10, 64)
	if !strings.HasPrefix(inputID, receiptPrefix) || err != nil || revision <= 0 {
		return
	}
	text, command, ok := s.claimTitle(sid, revision, data)
	if !ok {
		return
	}
	s.jobs.Add(1)
	go func() {
		defer s.jobs.Done()
		s.generateTitle(sid, command, text)
	}()
}

// editorBytes returns the two inputs that the message editor can write for a send:
// with bracketed paste, and without it. It follows composeInput in web/src/composer.ts.
// Attachment paths follow the text in single quotes, one on each line. Line breaks
// become carriage returns, and a carriage return ends the input.
func editorBytes(text string, paths []string) (bracketed, plain string) {
	quoted := make([]string, len(paths))
	for i, path := range paths {
		quoted[i] = "'" + strings.ReplaceAll(path, "'", `'\''`) + "'"
	}
	message := text
	if text != "" && len(quoted) > 0 {
		message += "\n\n"
	}
	message += strings.Join(quoted, "\n")
	message = strings.ReplaceAll(strings.ReplaceAll(message, "\r\n", "\n"), "\r", "\n")
	paste := strings.ReplaceAll(message, "\n", "\r")
	return "\x1b[200~" + paste + "\x1b[201~\r", paste + "\r"
}

// claimTitle checks a receipt and records the first verified send with text. The input
// ID comes from the browser, so the accepted bytes must be exactly the input that the
// editor writes for the named revision. The title event records the send also when it
// starts no request. Thus a later send never becomes the first message, also after the
// user selects a title tool or removes a user title. ok reports a request to start.
func (s *Server) claimTitle(sid string, revision int64, data []byte) (text, command string, ok bool) {
	send, pending, err := s.store.PendingSend(sid, revision)
	if err != nil || !pending || strings.TrimSpace(send.Text) == "" {
		return "", "", false
	}
	paths := make([]string, 0, len(send.Attachments))
	for _, id := range send.Attachments {
		attachment, err := s.attachment(sid, id, false)
		if err != nil {
			return "", "", false
		}
		paths = append(paths, attachment.Path)
	}
	if bracketed, plain := editorBytes(send.Text, paths); string(data) != bracketed && string(data) != plain {
		return "", "", false
	}
	settings, err := s.store.Settings()
	if err != nil {
		return "", "", false
	}
	session, err := s.store.Session(sid)
	// A session from before the upgrade has no derived title. The archive cannot show
	// that this send is its first, so it gets no automatic title.
	if err != nil || session.AutoTitle == "" {
		return "", "", false
	}
	command, err = titleCommand(settings.TitleTool)
	requested := err == nil && session.Title == ""
	if claimed, err := s.store.ClaimTitle(sid, revision, settings.TitleTool, requested); err != nil || !claimed || !requested {
		return "", "", false
	}
	return send.Text, command, true
}

// generateTitle replaces the derived title of a session with a summary of its first
// send. The title event already claims the request, so it runs at most once for each
// session, also after a restart or a lost receipt in the browser. A failure keeps the
// current title and does not run again.
func (s *Server) generateTitle(sid, command, text string) {
	title, err := runTitleCommand(s.ctx, command, text)
	if err == nil {
		err = s.store.SetAutoTitle(sid, title)
	}
	if err != nil {
		if s.ctx.Err() == nil {
			log.Printf("session %s: title command: %v", sid, err)
		}
		return
	}
	s.titles.Add(1)
}
