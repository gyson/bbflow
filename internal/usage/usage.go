// Package usage reads the usage limits of the agent CLIs: how much of each limit of the
// plan the account used, and when the limit resets. Each CLI has its own command and its
// own output format. The commands start no model turn.
package usage

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"bbflow/internal/models"
)

// Window is one usage limit of a plan, such as the 5-hour limit.
type Window struct {
	// Label names the length of the limit: "5-hour", "Weekly", or another length, such
	// as "8-hour".
	Label string `json:"label"`
	// Model names the model of a limit for one model. It is empty for a limit of all
	// models.
	Model string `json:"model,omitempty"`
	// Used is the used part of the limit in percent, from 0 to 100.
	Used float64 `json:"used"`
	// Resets is the reset time in RFC 3339 format. It is empty when the CLI does not
	// tell it.
	Resets string `json:"resets,omitempty"`
}

// Group is a set of models that share their limits. Only Antigravity has more than one
// group. A group without a name applies to all models of the CLI.
type Group struct {
	Name    string   `json:"name,omitempty"`
	Windows []Window `json:"windows"`
}

// Report is the usage of the account of one CLI. Plan is the plan of the account when
// the CLI tells it, such as "plus".
type Report struct {
	Plan   string  `json:"plan,omitempty"`
	Groups []Group `json:"groups"`
}

// Check is the command that prints the usage of a type. Input goes to its standard
// input. With Done, standard input stays open until Done accepts a line of the output,
// and that line is the answer. Codex answers on a JSON-RPC connection, so it needs Done.
type Check struct {
	Command string
	Input   string
	Done    func(line []byte) bool
}

// Checked tells if bbflow can read the usage of the type.
func Checked(kind string) bool {
	return kind == models.Codex || kind == models.Claude || kind == models.Agy
}

// codexRequests opens a JSON-RPC connection with the Codex app server and asks for the
// rate limits of the account.
const codexRequests = `{"method":"initialize","id":0,"params":{"clientInfo":{"name":"bbflow","version":"1"}}}
{"method":"initialized"}
{"method":"account/rateLimits/read","id":1}
`

// Command returns the check of a type. program is the CLI path of the built-in tool of
// the type, or the plain CLI name. A type without a check returns an empty command.
func Command(kind, program string) Check {
	switch kind {
	case models.Codex:
		return Check{Command: program + " app-server", Input: codexRequests, Done: CodexDone}
	case models.Claude:
		return Check{Command: program + " -p /usage --no-session-persistence"}
	case models.Agy:
		return Check{Command: program + " -p /usage --output-format json"}
	}
	return Check{}
}

// CodexDone accepts the reply of the rate limit request of codexRequests.
func CodexDone(line []byte) bool {
	var reply struct {
		ID json.RawMessage `json:"id"`
	}
	return json.Unmarshal(line, &reply) == nil && string(reply.ID) == "1"
}

// Parse reads the output of the check of a type. now is the time of the check. Claude
// Code prints its reset times without a year, so it needs the time.
func Parse(kind string, output []byte, now time.Time) (Report, error) {
	switch kind {
	case models.Codex:
		return parseCodex(output)
	case models.Claude:
		return parseClaude(output, now)
	case models.Agy:
		return parseAgy(output)
	}
	return Report{}, fmt.Errorf("%s has no usage check", models.Name(kind))
}

// percent rounds a used part to one decimal and keeps it from 0 to 100.
func percent(used float64) float64 {
	return math.Round(min(max(used, 0), 100)*10) / 10
}

// lengthLabel names a limit by its length in minutes.
func lengthLabel(minutes int) string {
	switch {
	case minutes == 7*24*60:
		return "Weekly"
	case minutes > 0 && minutes%(24*60) == 0:
		return fmt.Sprintf("%d-day", minutes/(24*60))
	case minutes > 0 && minutes%60 == 0:
		return fmt.Sprintf("%d-hour", minutes/60)
	case minutes > 0:
		return fmt.Sprintf("%d-minute", minutes)
	}
	return "Limit"
}

// firstLine returns the first line of an output with text, for an error message.
func firstLine(output []byte) string {
	for line := range strings.Lines(string(output)) {
		if line = strings.TrimSpace(line); line != "" {
			if len(line) > 200 {
				line = line[:200] + "…"
			}
			return line
		}
	}
	return ""
}

// The reply of account/rateLimits/read. The windows can be null.
type codexWindow struct {
	UsedPercent        float64 `json:"usedPercent"`
	WindowDurationMins int     `json:"windowDurationMins"`
	ResetsAt           int64   `json:"resetsAt"`
}

type codexReply struct {
	Result *struct {
		RateLimits *struct {
			Primary   *codexWindow `json:"primary"`
			Secondary *codexWindow `json:"secondary"`
			PlanType  string       `json:"planType"`
		} `json:"rateLimits"`
	} `json:"result"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// parseCodex reads the reply of the rate limit request. The output can hold other
// messages of the app server, so it reads only the line that CodexDone accepts.
func parseCodex(output []byte) (Report, error) {
	for line := range bytes.Lines(output) {
		if !CodexDone(bytes.TrimSpace(line)) {
			continue
		}
		var reply codexReply
		if err := json.Unmarshal(line, &reply); err != nil {
			return Report{}, fmt.Errorf("cannot read the rate limits of Codex: %w", err)
		}
		if reply.Error != nil {
			return Report{}, fmt.Errorf("Codex did not read its rate limits: %s", reply.Error.Message)
		}
		if reply.Result == nil || reply.Result.RateLimits == nil {
			return Report{}, errors.New("Codex reports no rate limits for this account")
		}
		limits := reply.Result.RateLimits
		var windows []Window
		for _, w := range []*codexWindow{limits.Primary, limits.Secondary} {
			if w == nil {
				continue
			}
			window := Window{Label: lengthLabel(w.WindowDurationMins), Used: percent(w.UsedPercent)}
			if w.ResetsAt > 0 {
				window.Resets = time.Unix(w.ResetsAt, 0).UTC().Format(time.RFC3339)
			}
			windows = append(windows, window)
		}
		if len(windows) == 0 {
			return Report{}, errors.New("Codex reports no rate limits for this account")
		}
		plan := limits.PlanType
		if plan == "unknown" {
			plan = ""
		}
		return Report{Plan: plan, Groups: []Group{{Windows: windows}}}, nil
	}
	return Report{}, errors.New("Codex did not answer the rate limit request")
}

// claudeLine is a limit line of claude -p /usage, for example
//
//	Current week (all models): 71% used · resets Nov 25 at 5:59pm (America/Los_Angeles)
var (
	claudeLine  = regexp.MustCompile(`^Current (session|week)(?: \(([^)]*)\))?: ([0-9]+(?:\.[0-9]+)?)% used(?: · resets (.+))?$`)
	claudeReset = regexp.MustCompile(`^(?:([A-Z][a-z]{2}) ([0-9]{1,2}) at )?([0-9]{1,2})(?::([0-9]{2}))?(am|pm)(?: \(([^)]+)\))?$`)
)

// parseClaude reads the limit lines of claude -p /usage. The command prints text for
// people, so the parser accepts only the known line format. A line that starts with
// "Current " in another format is an error, so that a format change cannot hide a limit.
func parseClaude(output []byte, now time.Time) (Report, error) {
	var windows []Window
	for line := range strings.Lines(string(output)) {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "Current ") {
			continue
		}
		match := claudeLine.FindStringSubmatch(line)
		if match == nil {
			return Report{}, fmt.Errorf("cannot read the usage line %q of Claude Code", line)
		}
		window := Window{Label: "5-hour"}
		if match[1] == "week" {
			window.Label = "Weekly"
		}
		if match[2] != "" && match[2] != "all models" {
			window.Model = match[2]
		}
		used, err := strconv.ParseFloat(match[3], 64)
		if err != nil {
			return Report{}, fmt.Errorf("cannot read the usage line %q of Claude Code", line)
		}
		window.Used = percent(used)
		if match[4] != "" {
			resets, err := claudeResetTime(match[4], now)
			if err != nil {
				return Report{}, fmt.Errorf("cannot read the reset time %q of Claude Code: %w", match[4], err)
			}
			window.Resets = resets.UTC().Format(time.RFC3339)
		}
		windows = append(windows, window)
	}
	if len(windows) == 0 {
		if line := firstLine(output); line != "" {
			return Report{}, fmt.Errorf("Claude Code printed no usage limits: %s", line)
		}
		return Report{}, errors.New("Claude Code printed no usage limits")
	}
	return Report{Groups: []Group{{Windows: windows}}}, nil
}

// claudeResetTime reads a reset time such as "Nov 25 at 4:49am (America/Los_Angeles)"
// or "4pm". The text has no year. A reset is in the future, so the time is the first one
// after a day ago. A time without a date is today, or tomorrow when it is more than an
// hour ago. Without a time zone, the time is local.
func claudeResetTime(text string, now time.Time) (time.Time, error) {
	match := claudeReset.FindStringSubmatch(text)
	if match == nil {
		return time.Time{}, errors.New("unknown format")
	}
	location := time.Local
	if match[6] != "" {
		var err error
		if location, err = time.LoadLocation(match[6]); err != nil {
			return time.Time{}, err
		}
	}
	hour, _ := strconv.Atoi(match[3])
	minute, _ := strconv.Atoi(cmp.Or(match[4], "0"))
	if hour < 1 || hour > 12 || minute > 59 {
		return time.Time{}, errors.New("invalid time")
	}
	hour %= 12
	if match[5] == "pm" {
		hour += 12
	}
	now = now.In(location)
	if match[1] == "" {
		reset := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, location)
		if reset.Before(now.Add(-time.Hour)) {
			reset = reset.AddDate(0, 0, 1)
		}
		return reset, nil
	}
	day, err := time.Parse("Jan 2", match[1]+" "+match[2])
	if err != nil {
		return time.Time{}, err
	}
	reset := time.Date(now.Year(), day.Month(), day.Day(), hour, minute, 0, 0, location)
	if reset.Before(now.AddDate(0, 0, -1)) {
		reset = reset.AddDate(1, 0, 0)
	}
	return reset, nil
}

// The JSON output of agy -p /usage --output-format json.
type agyBucket struct {
	Name      string   `json:"name"`
	Window    string   `json:"window"`
	Remaining *float64 `json:"remaining_fraction"`
	ResetTime string   `json:"reset_time"`
}

type agyOutput struct {
	Status   string `json:"status"`
	Response string `json:"response"`
	Command  *struct {
		Data *struct {
			Groups []struct {
				Name    string      `json:"name"`
				Buckets []agyBucket `json:"buckets"`
			} `json:"groups"`
		} `json:"data"`
	} `json:"command"`
}

// agyWindows names the windows of Antigravity and sets their order: 5-hour first.
var agyWindows = map[string]struct {
	label string
	order int
}{"5h": {"5-hour", 0}, "weekly": {"Weekly", 1}}

// parseAgy reads the usage of each model group of Antigravity.
func parseAgy(output []byte) (Report, error) {
	var out agyOutput
	if err := json.Unmarshal(bytes.TrimSpace(output), &out); err != nil {
		return Report{}, fmt.Errorf("cannot read the usage of Antigravity: %w", err)
	}
	if out.Status != "SUCCESS" {
		return Report{}, fmt.Errorf("Antigravity did not read its usage: %s", cmp.Or(firstLine([]byte(out.Response)), out.Status))
	}
	if out.Command == nil || out.Command.Data == nil || len(out.Command.Data.Groups) == 0 {
		return Report{}, errors.New("Antigravity printed no usage limits")
	}
	var groups []Group
	for _, g := range out.Command.Data.Groups {
		group := Group{Name: g.Name}
		for _, b := range g.Buckets {
			if b.Remaining == nil {
				return Report{}, fmt.Errorf("the limit %q of Antigravity has no remaining part", b.Name)
			}
			window := Window{Label: b.Name, Used: percent((1 - *b.Remaining) * 100)}
			if known, ok := agyWindows[b.Window]; ok {
				window.Label = known.label
			}
			if b.ResetTime != "" {
				resets, err := time.Parse(time.RFC3339, b.ResetTime)
				if err != nil {
					return Report{}, fmt.Errorf("cannot read the reset time %q of Antigravity", b.ResetTime)
				}
				window.Resets = resets.UTC().Format(time.RFC3339)
			}
			group.Windows = append(group.Windows, window)
		}
		order := func(w Window) int {
			for _, known := range agyWindows {
				if known.label == w.Label {
					return known.order
				}
			}
			return len(agyWindows)
		}
		slices.SortStableFunc(group.Windows, func(a, b Window) int { return order(a) - order(b) })
		groups = append(groups, group)
	}
	return Report{Groups: groups}, nil
}
