package usage

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"bbflow/internal/models"
)

// The outputs are synthetic. They have the shape of the output of Codex 0.172.0, Claude
// Code 2.1.332, and agy 1.5.17.

const codexSample = `{"id":0,"result":{"userAgent":"bbflow/0.172.0","codexHome":"/tmp/codex","platformFamily":"unix","platformOs":"macos"}}
{"method":"remoteControl/status/changed","params":{"status":"disabled"}}
{"id":1,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":38,"windowDurationMins":300,"resetsAt":1795617124},"secondary":{"usedPercent":45.25,"windowDurationMins":10080,"resetsAt":1796114125},"credits":{"hasCredits":false,"unlimited":false,"balance":"0"},"planType":"plus","rateLimitReachedType":null}}}
{"method":"account/updated","params":{"authMode":"chatgpt","planType":"plus"}}
`

func TestCodexReadsTheRateLimitReply(t *testing.T) {
	report, err := Parse(models.Codex, []byte(codexSample), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	want := Report{Plan: "plus", Groups: []Group{{Windows: []Window{
		{Label: "5-hour", Used: 38, Resets: "2026-11-25T14:32:04Z"},
		{Label: "Weekly", Used: 45.3, Resets: "2026-12-01T08:35:25Z"},
	}}}}
	if !reflect.DeepEqual(report, want) {
		t.Fatalf("got %+v", report)
	}
	// Only the reply of the request ends the wait. Other messages of the app server do not.
	for i, line := range strings.Split(strings.TrimSpace(codexSample), "\n") {
		if CodexDone([]byte(line)) != (i == 2) {
			t.Fatalf("CodexDone(%q) is wrong", line)
		}
	}
}

func TestCodexReportsErrorsAndMissingLimits(t *testing.T) {
	for output, message := range map[string]string{
		`{"id":1,"error":{"code":-32600,"message":"not logged in"}}`:         "not logged in",
		`{"id":1,"result":{"rateLimits":null}}`:                              "no rate limits",
		`{"id":1,"result":{"rateLimits":{"primary":null,"secondary":null}}}`: "no rate limits",
		`{"id":0,"result":{}}`: "did not answer",
		`{"id":1,"result":{"rateLimits":{"primary":{"usedPercent":"many"}}}}`: "cannot read",
		"": "did not answer",
	} {
		if _, err := Parse(models.Codex, []byte(output), time.Now()); err == nil || !strings.Contains(err.Error(), message) {
			t.Fatalf("%q: got %v, want %q", output, err, message)
		}
	}
	// An unknown plan and another window length.
	report, err := Parse(models.Codex, []byte(`{"id":1,"result":{"rateLimits":{"primary":{"usedPercent":120,"windowDurationMins":480},"planType":"unknown"}}}`), time.Now())
	if err != nil || report.Plan != "" || report.Groups[0].Windows[0] != (Window{Label: "8-hour", Used: 100}) {
		t.Fatalf("got %+v %v", report, err)
	}
}

const claudeSample = `You are currently using your subscription to power your Claude Code usage

Current session: 31% used · resets Nov 25 at 4:49am (America/Los_Angeles)
Current week (all models): 71% used · resets Nov 25 at 5:59pm (America/Los_Angeles)
Current week (Fable): 100% used · resets Nov 25 at 5:59pm (America/Los_Angeles)

What's contributing to your usage?
Last 24h · 1610 requests · 38 sessions
  83%  Start fresh when you switch tasks · run /clear
`

func TestClaudeReadsTheLimitLines(t *testing.T) {
	now := time.Date(2026, 11, 25, 10, 36, 0, 0, time.UTC) // 2:36 AM in Los Angeles.
	report, err := Parse(models.Claude, []byte(claudeSample), now)
	if err != nil {
		t.Fatal(err)
	}
	want := Report{Groups: []Group{{Windows: []Window{
		{Label: "5-hour", Used: 31, Resets: "2026-11-25T12:49:00Z"},
		{Label: "Weekly", Used: 71, Resets: "2026-11-26T01:59:00Z"},
		{Label: "Weekly", Model: "Fable", Used: 100, Resets: "2026-11-26T01:59:00Z"},
	}}}}
	if !reflect.DeepEqual(report, want) {
		t.Fatalf("got %+v", report)
	}
}

func TestClaudeResetTimesGetTheirYear(t *testing.T) {
	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 12, 30, 22, 0, 0, 0, la)
	for text, want := range map[string]time.Time{
		// A reset in January is in the next year.
		"Jan 2 at 9am (America/Los_Angeles)": time.Date(2027, 1, 2, 9, 0, 0, 0, la),
		// A reset some hours ago stays in this year.
		"Dec 30 at 8:15pm (America/Los_Angeles)": time.Date(2026, 12, 30, 20, 15, 0, 0, la),
		"Dec 31 at 12am (America/Los_Angeles)":   time.Date(2026, 12, 31, 0, 0, 0, 0, la),
		// A time without a date is today, or tomorrow when it is past.
		"11pm (America/Los_Angeles)":    time.Date(2026, 12, 30, 23, 0, 0, 0, la),
		"3:30am (America/Los_Angeles)":  time.Date(2026, 12, 31, 3, 30, 0, 0, la),
		"12:05pm (America/Los_Angeles)": time.Date(2026, 12, 31, 12, 5, 0, 0, la),
	} {
		got, err := claudeResetTime(text, now)
		if err != nil || !got.Equal(want) {
			t.Fatalf("%q: got %v %v, want %v", text, got, err, want)
		}
	}
	// On January 1, a reset on December 31 an hour ago stays in the last year.
	newYear := time.Date(2027, 1, 1, 1, 0, 0, 0, la)
	for text, want := range map[string]time.Time{
		"Dec 31 at 11:59pm (America/Los_Angeles)": time.Date(2026, 12, 31, 23, 59, 0, 0, la),
		"Jan 1 at 4am (America/Los_Angeles)":      time.Date(2027, 1, 1, 4, 0, 0, 0, la),
		"Dec 30 at 11pm (America/Los_Angeles)":    time.Date(2027, 12, 30, 23, 0, 0, 0, la),
	} {
		got, err := claudeResetTime(text, newYear)
		if err != nil || !got.Equal(want) {
			t.Fatalf("%q on January 1: got %v %v, want %v", text, got, err, want)
		}
	}
	for _, text := range []string{"tomorrow", "Nov 25 at 13pm (America/Los_Angeles)", "Nov 25 at 4:49am (Mars/Olympus)", "Foo 25 at 4am"} {
		if _, err := claudeResetTime(text, now); err == nil {
			t.Fatalf("accepted %q", text)
		}
	}
}

func TestClaudeRejectsUnknownLimitLines(t *testing.T) {
	for output, message := range map[string]string{
		"Current session: 31% used · resets soon\n":    "reset time",
		"Current session: about a third\n":             "usage line",
		"You are using an API key.\n\nNo limits here.": "printed no usage limits: You are using an API key.",
		"": "printed no usage limits",
	} {
		if _, err := Parse(models.Claude, []byte(output), time.Now()); err == nil || !strings.Contains(err.Error(), message) {
			t.Fatalf("%q: got %v, want %q", output, err, message)
		}
	}
	// A limit line without a reset time is valid.
	report, err := Parse(models.Claude, []byte("Current session: 0% used\n"), time.Now())
	if err != nil || report.Groups[0].Windows[0] != (Window{Label: "5-hour"}) {
		t.Fatalf("got %+v %v", report, err)
	}
}

const agySample = `{"conversation_id":"","status":"SUCCESS","response":"Gemini Models\tWeekly Limit Remaining\t33%\t2026-12-01T07:09:26Z\n","duration_seconds":0,"num_turns":0,"command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit and a 5-hour limit.","groups":[
{"name":"Gemini Models","description":"Models within this group: Gemini 4 Neon","buckets":[
 {"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.32915207743644714,"reset_time":"2026-12-01T07:09:26Z"},
 {"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0.9396414160728455,"reset_time":"2026-11-25T15:30:20Z"}]},
{"name":"Claude and GPT models","buckets":[
 {"id":"3p-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":1,"reset_time":"2026-12-02T10:36:22Z"},
 {"id":"3p-daily","name":"Daily Limit Remaining","window":"daily","remaining_fraction":0.5},
 {"id":"3p-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":1,"reset_time":"2026-11-25T15:36:22Z"}]}]}}}`

func TestAgyReadsEachModelGroup(t *testing.T) {
	report, err := Parse(models.Agy, []byte(agySample), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// The 5-hour limit comes first. An unknown window keeps the name of the CLI.
	want := Report{Groups: []Group{
		{Name: "Gemini Models", Windows: []Window{
			{Label: "5-hour", Used: 6, Resets: "2026-11-25T15:30:20Z"},
			{Label: "Weekly", Used: 67.1, Resets: "2026-12-01T07:09:26Z"},
		}},
		{Name: "Claude and GPT models", Windows: []Window{
			{Label: "5-hour", Used: 0, Resets: "2026-11-25T15:36:22Z"},
			{Label: "Weekly", Used: 0, Resets: "2026-12-02T10:36:22Z"},
			{Label: "Daily Limit Remaining", Used: 50},
		}},
	}}
	if !reflect.DeepEqual(report, want) {
		t.Fatalf("got %+v", report)
	}
}

func TestAgySkipsAGroupWithoutLimits(t *testing.T) {
	report, err := Parse(models.Agy, []byte(`{"status":"SUCCESS","command":{"data":{"groups":[{"name":"Empty","buckets":[]},{"name":"Gemini Models","buckets":[{"name":"Weekly","window":"weekly","remaining_fraction":0.5}]}]}}}`), time.Now())
	if err != nil || len(report.Groups) != 1 || report.Groups[0].Name != "Gemini Models" || report.Groups[0].Windows == nil {
		t.Fatalf("got %+v %v", report, err)
	}
}

func TestAgyReportsFailures(t *testing.T) {
	for output, message := range map[string]string{
		`{"status":"ERROR","response":"Sign in to continue.\nRun agy."}`:                                                                        "Sign in to continue.",
		`{"status":"SUCCESS","command":{"data":{"groups":[{"name":"Gemini Models","buckets":[]}]}}}`:                                            "no usage limits",
		`{"status":"SUCCESS","command":{}}`:                                                                                                     "no usage limits",
		`{"status":"SUCCESS","command":{"data":{"groups":[]}}}`:                                                                                 "no usage limits",
		`{"status":"SUCCESS","command":{"data":{"groups":[{"name":"G","buckets":[{"name":"Weekly"}]}]}}}`:                                       "no remaining part",
		`{"status":"SUCCESS","command":{"data":{"groups":[{"name":"G","buckets":[{"name":"W","remaining_fraction":1,"reset_time":"soon"}]}]}}}`: "reset time",
		`Fetching usage…`: "cannot read",
	} {
		if _, err := Parse(models.Agy, []byte(output), time.Now()); err == nil || !strings.Contains(err.Error(), message) {
			t.Fatalf("%q: got %v, want %q", output, err, message)
		}
	}
}

func TestOnlyCodexClaudeAndAgyHaveAUsageCheck(t *testing.T) {
	if check := Command(models.Codex, "/opt/codex"); check.Command != "/opt/codex app-server" || check.Done == nil || !strings.Contains(check.Input, "account/rateLimits/read") {
		t.Fatalf("got %+v", check)
	}
	if check := Command(models.Claude, "claude"); check.Command != "claude -p /usage --no-session-persistence" || check.Done != nil {
		t.Fatalf("got %+v", check)
	}
	if check := Command(models.Agy, "~/bin/agy"); check.Command != "~/bin/agy -p /usage --output-format json" {
		t.Fatalf("got %+v", check)
	}
	for _, kind := range []string{models.CodePuppy, models.Custom, ""} {
		if Checked(kind) || Command(kind, "x").Command != "" {
			t.Fatalf("%q has a check", kind)
		}
		if _, err := Parse(kind, nil, time.Now()); err == nil {
			t.Fatalf("%q parsed", kind)
		}
	}
}
