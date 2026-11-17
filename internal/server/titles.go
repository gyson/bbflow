package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
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
// Each command reads the request on standard input. The commands select small models.
// Codex uses low reasoning effort, because a Codex config can select a slow default.
// Tests replace the commands.
var titleTools = []protocol.TitleTool{
	{ID: "claude", Name: "Claude", Command: "claude -p --model haiku"},
	{ID: "codex", Name: "Codex", Command: "codex exec --skip-git-repo-check --model gpt-6-luna -c model_reasoning_effort=low -"},
	// Code Puppy takes the prompt only as an argument. "$(cat)" reads standard input, and
	// the shell does not parse the text again.
	{ID: "code-puppy", Name: "Code Puppy", Command: `code-puppy --no-tools --model codex-gpt-6-luna -p "$(cat)"`},
}

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
// at a rune boundary. It breaks each marker in the message, so that the message cannot
// supply the answer line.
func titleRequest(message string) string {
	message = strings.TrimSpace(message)
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

// parseTitle reads the title from the command output. It uses the text after the
// marker on the last line that has one. Output without a marker is accepted only when
// it has one line with text. Other output is rejected, because it can be an error
// message or a status line.
func parseTitle(output string) (string, error) {
	var lines []string
	for _, line := range strings.Split(output, "\n") {
		line = strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return ' '
			}
			return r
		}, line)
		if line = strings.Join(strings.Fields(line), " "); line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 {
		return "", errors.New("the command printed no title")
	}
	answer := ""
	for i := len(lines) - 1; i >= 0 && answer == ""; i-- {
		if at := markerIndex(lines[i]); at >= 0 {
			answer = lines[i][at+len(titleMarker):]
			if answer = cleanTitle(answer); answer == "" {
				return "", errors.New("the command printed an empty title")
			}
		}
	}
	if answer == "" {
		if len(lines) > 1 {
			return "", fmt.Errorf("the command printed %d lines, but no line starts with %s. First line: %s", len(lines), titleMarker, cleanTitle(lines[0]))
		}
		if answer = cleanTitle(lines[0]); answer == "" {
			return "", errors.New("the command printed no title")
		}
	}
	return answer, nil
}

// cleanTitle removes common labels, quotes, and Markdown marks from one line. It keeps
// at most titleRunes characters.
func cleanTitle(line string) string {
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
		detail := strings.TrimSpace(stderr.String())
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

// generateTitle replaces the derived title of a session after its first message from
// the message editor. It runs only when a title tool is selected and the session has no
// user title. A failure keeps the current title.
func (s *Server) generateTitle(sid string, revision int64, message string) {
	if strings.TrimSpace(message) == "" {
		return
	}
	settings, err := s.store.Settings()
	if err != nil || settings.TitleTool == "none" {
		return
	}
	command, err := titleCommand(settings.TitleTool)
	if err != nil {
		return
	}
	session, err := s.store.Session(sid)
	if err != nil || session.Title != "" {
		return
	}
	earlier, _, err := s.store.SentDrafts(sid, revision, 1)
	if err != nil || len(earlier) > 0 {
		return
	}
	s.jobs.Add(1)
	go func() {
		defer s.jobs.Done()
		title, err := runTitleCommand(s.ctx, command, message)
		if err == nil {
			err = s.store.SetAutoTitle(sid, title)
		}
		if err != nil {
			if s.ctx.Err() == nil {
				log.Printf("session %s: title tool %s: %v", sid, settings.TitleTool, err)
			}
			return
		}
		s.titles.Add(1)
	}()
}
