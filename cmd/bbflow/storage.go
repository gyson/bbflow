package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"bbflow/internal/client"
	"bbflow/internal/history"
	"bbflow/internal/protocol"
)

func storage(target client.Target, args []string) error {
	flags := flag.NewFlagSet("storage", flag.ContinueOnError)
	redact := flags.Bool("redact", false, "Replace project names and session titles with short IDs")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("storage takes no arguments")
	}
	fmt.Fprintln(os.Stderr, "Reading the archive. A large archive can take a minute.")
	// Wait a little longer than the server, so that its timeout error can arrive.
	data, err := target.CallWithin(protocol.Request{Operation: "storage-report"}, history.StorageReportTimeout+30*time.Second)
	if err != nil {
		return err
	}
	var report history.StorageReport
	if err = json.Unmarshal(data, &report); err != nil {
		return err
	}
	if *redact {
		redactStorage(&report)
	}
	output := bufio.NewWriter(os.Stdout)
	writeStorageReport(output, report, time.Now().UTC())
	return output.Flush()
}

func redactStorage(report *history.StorageReport) {
	name := func(id, name string) string {
		if id == "" || id == history.GeneralProjectID {
			return name
		}
		return "project " + shortID(id)
	}
	for i := range report.Projects {
		report.Projects[i].Name = name(report.Projects[i].ID, report.Projects[i].Name)
	}
	for i := range report.Sessions {
		item := &report.Sessions[i]
		item.Project = name(item.ProjectID, item.Project)
		item.Title = "session " + shortID(item.ID)
	}
}

func writeStorageReport(w io.Writer, r history.StorageReport, now time.Time) {
	total := r.Total.Disk
	sessions, archived, idle := 0, 0, 0
	terminals := 0
	for _, item := range r.Sessions {
		sessions++
		terminals += item.Terminals
		if item.Archived {
			archived++
		}
		if item.Events == 0 {
			idle++
		}
	}
	fmt.Fprintln(w, "# bbflow storage report")
	fmt.Fprintln(w)
	fmt.Fprintf(w, "- Generated: %s.\n", now.Format("2006-01-02 15:04 UTC"))
	fmt.Fprintf(w, "- bbflow: %s. Database format: %d. SQLite: %s.\n", version, r.Format, r.SQLite)
	fmt.Fprintln(w, "- Sizes for event kinds, projects, sessions, and days are estimates. See \"Method\" at the end.")
	fmt.Fprintln(w)

	fmt.Fprintln(w, "## Totals")
	fmt.Fprintln(w)
	fmt.Fprintf(w, "- Database: %s. Used space: %s. Free pages: %s. Write-ahead log (WAL) file: %s.\n",
		size(r.Pages*r.PageSize), size(r.Used()), size(r.FreePages*r.PageSize), size(r.WAL))
	fmt.Fprintf(w, "- Events: %s. Data: %s. Text: %s.\n", count(r.Total.Events), size(r.Total.Data), size(r.Total.Text))
	if r.Total.Events > 0 {
		fmt.Fprintf(w, "- Average for each event: %s bytes of data and text, and about %s bytes of overhead.\n",
			average(r.Total.Data+r.Total.Text, r.Total.Events), count(int64(math.Round(r.Overhead))))
	}
	fmt.Fprintf(w, "- Projects with sessions: %d. Sessions: %d (%d archived, %d with no events). Terminals: %d.\n",
		len(r.Projects), sessions, archived, idle, terminals)
	if len(r.Days) > 0 {
		fmt.Fprintf(w, "- First event: %s. Last event: %s. Days with events: %d.\n", r.Days[0].Day, r.Days[len(r.Days)-1].Day, len(r.Days))
	}
	fmt.Fprintln(w)

	fmt.Fprintln(w, "## Used space by events column")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Column sizes are exact. The overhead is the rest of the used space.")
	fmt.Fprintln(w)
	columns := []struct {
		name  string
		bytes int64
	}{
		{"`session_id`", r.Columns.SessionID}, {"`run_id`", r.Columns.RunID}, {"`kind`", r.Columns.Kind},
		{"`created`", r.Columns.Created}, {"`data`", r.Columns.Data}, {"`text`", r.Columns.Text},
	}
	rest := r.Used()
	var rows [][]string
	for _, item := range columns {
		rest -= item.bytes
		rows = append(rows, []string{item.name, size(item.bytes), percent(item.bytes, r.Used())})
	}
	rest = max(rest, 0)
	rows = append(rows, []string{"Overhead: record headers, page space, indexes, and other tables", size(rest), percent(rest, r.Used())})
	table(w, []column{{"Column", false}, {"Size", true}, {"Share of used space", true}}, rows)

	fmt.Fprintln(w, "## Event kinds")
	fmt.Fprintln(w)
	rows = nil
	for _, item := range r.Kinds {
		rows = append(rows, []string{"`" + item.Kind + "`", count(item.Events), size(item.Data), size(item.Text),
			average(item.Data, item.Events), size(item.Disk), percent(item.Disk, total)})
	}
	table(w, []column{{"Kind", false}, {"Events", true}, {"Data", true}, {"Text", true}, {"Average data bytes", true}, {"Est. disk", true}, {"Share", true}}, rows)

	fmt.Fprintln(w, "## Projects")
	fmt.Fprintln(w)
	rows = nil
	for i, item := range r.Projects {
		rows = append(rows, []string{strconv.Itoa(i + 1), projectName(item.ID, item.Name), count(int64(item.Sessions)), count(int64(item.Terminals)),
			count(item.Events), size(item.Data + item.Text), size(item.Disk), percent(item.Disk, total)})
	}
	table(w, []column{{"#", true}, {"Project", false}, {"Sessions", true}, {"Terminals", true}, {"Events", true}, {"Data + text", true}, {"Est. disk", true}, {"Share", true}}, rows)

	recorded := make([]history.StorageSession, 0, len(r.Sessions))
	for _, item := range r.Sessions {
		if item.Events > 0 {
			recorded = append(recorded, item)
		}
	}
	fmt.Fprintln(w, "## Top 10 sessions")
	fmt.Fprintln(w)
	rows = nil
	for i, item := range recorded[:min(10, len(recorded))] {
		rows = append(rows, []string{strconv.Itoa(i + 1), "`" + shortID(item.ID) + "`", cell(item.Title), projectName(item.ProjectID, item.Project),
			tools(item.Tools), dateOf(item.Created), yes(item.Archived), count(int64(item.Terminals)), count(item.Events),
			size(item.Data), size(item.Text), size(item.Disk), percent(item.Disk, total)})
	}
	table(w, []column{{"#", true}, {"ID", false}, {"Title", false}, {"Project", false}, {"Tools", false}, {"Created", false}, {"Archived", false},
		{"Terminals", true}, {"Events", true}, {"Data", true}, {"Text", true}, {"Est. disk", true}, {"Share", true}}, rows)

	fmt.Fprintln(w, "## Top 5 sessions in each of the top 3 projects")
	fmt.Fprintln(w)
	for i, project := range r.Projects[:min(3, len(r.Projects))] {
		fmt.Fprintf(w, "### %d. %s: %s, %s of the total\n\n", i+1, projectName(project.ID, project.Name), size(project.Disk), percent(project.Disk, total))
		rows = nil
		for _, item := range recorded {
			if item.ProjectID != project.ID {
				continue
			}
			rows = append(rows, []string{strconv.Itoa(len(rows) + 1), "`" + shortID(item.ID) + "`", cell(item.Title), tools(item.Tools),
				dateOf(item.Created), count(int64(item.Terminals)), count(item.Events), size(item.Data + item.Text), size(item.Disk), percent(item.Disk, project.Disk)})
			if len(rows) == 5 {
				break
			}
		}
		table(w, []column{{"#", true}, {"ID", false}, {"Title", false}, {"Tools", false}, {"Created", false}, {"Terminals", true},
			{"Events", true}, {"Data + text", true}, {"Est. disk", true}, {"Share of project", true}}, rows)
	}

	fmt.Fprintln(w, "## Event kinds in the top 5 sessions")
	fmt.Fprintln(w)
	for i, item := range recorded[:min(5, len(recorded))] {
		fmt.Fprintf(w, "### %d. %s (`%s`): %s\n\n", i+1, cell(item.Title), shortID(item.ID), size(item.Disk))
		rows = nil
		for _, kind := range item.Kinds {
			rows = append(rows, []string{"`" + kind.Kind + "`", count(kind.Events), size(kind.Data), size(kind.Text),
				average(kind.Data, kind.Events), size(kind.Disk), percent(kind.Disk, item.Disk)})
		}
		table(w, []column{{"Kind", false}, {"Events", true}, {"Data", true}, {"Text", true}, {"Average data bytes", true}, {"Est. disk", true}, {"Share of session", true}}, rows)
	}

	fmt.Fprintln(w, "## Growth by day (UTC)")
	fmt.Fprintln(w)
	rows = nil
	for _, item := range r.Days {
		rows = append(rows, []string{item.Day, count(int64(item.Sessions)), count(item.Events), size(item.Data + item.Text), size(item.Disk)})
	}
	table(w, []column{{"Day", false}, {"Sessions", true}, {"Events", true}, {"Data + text", true}, {"Est. disk", true}}, rows)

	fmt.Fprintln(w, "## Method")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "- The server reads the archive with one read-only transaction. The report has no terminal content or workspace paths.")
	fmt.Fprintln(w, "- Event counts and the bytes in each events column are exact.")
	fmt.Fprintln(w, "- SQLite does not record which pages belong to a session. Thus each estimated disk size is the data and text bytes,")
	fmt.Fprintln(w, "  plus the event count times the average overhead for each event.")
	fmt.Fprintln(w, "- The average overhead is the used space, less all data and text bytes, divided by the number of events.")
	fmt.Fprintln(w, "  It includes the other columns, record headers, page space, indexes, and the small tables.")
	fmt.Fprintln(w, "- A share is a share of all estimates, unless the column says otherwise. The estimates add up to about the used space.")
}

type column struct {
	title string
	right bool
}

// table writes a Markdown table with padded columns, so that the plain text is easy to read.
func table(w io.Writer, columns []column, rows [][]string) {
	if len(rows) == 0 {
		fmt.Fprintln(w, "No events.")
		fmt.Fprintln(w)
		return
	}
	widths := make([]int, len(columns))
	for i, item := range columns {
		widths[i] = max(utf8.RuneCountInString(item.title), 3)
	}
	for _, row := range rows {
		for i, value := range row {
			widths[i] = max(widths[i], utf8.RuneCountInString(value))
		}
	}
	line := func(values []string) {
		for i, value := range values {
			pad := strings.Repeat(" ", widths[i]-utf8.RuneCountInString(value))
			if columns[i].right {
				value = pad + value
			} else {
				value += pad
			}
			fmt.Fprint(w, "| ", value, " ")
		}
		fmt.Fprintln(w, "|")
	}
	titles := make([]string, len(columns))
	rules := make([]string, len(columns))
	for i, item := range columns {
		titles[i] = item.title
		rules[i] = strings.Repeat("-", widths[i])
		if item.right {
			rules[i] = rules[i][1:] + ":"
		}
	}
	line(titles)
	line(rules)
	for _, row := range rows {
		line(row)
	}
	fmt.Fprintln(w)
}

func size(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.2f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}

// count writes an integer with thousands separators.
func count(n int64) string {
	text := strconv.FormatInt(n, 10)
	for i := len(text) - 3; i > 0 && text[i-1] != '-'; i -= 3 {
		text = text[:i] + "," + text[i:]
	}
	return text
}

func percent(part, whole int64) string {
	if whole <= 0 {
		return "0.0%"
	}
	return fmt.Sprintf("%.1f%%", 100*float64(part)/float64(whole))
}

func average(bytes, events int64) string {
	if events == 0 {
		return "0"
	}
	return count(int64(math.Round(float64(bytes) / float64(events))))
}

func shortID(id string) string { return id[:min(8, len(id))] }

func dateOf(timestamp string) string { return timestamp[:min(10, len(timestamp))] }

func yes(value bool) string {
	if value {
		return "yes"
	}
	return ""
}

// cell keeps a title on one table row.
func cell(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	return strings.ReplaceAll(text, "|", "\\|")
}

func projectName(id, name string) string {
	if id == "" {
		return "(no project)"
	}
	return cell(name)
}

func tools(names []string) string {
	labels := make([]string, len(names))
	for i, name := range names {
		labels[i] = cell(name)
		if name == "" {
			labels[i] = "(not recorded)"
		}
	}
	return strings.Join(labels, ", ")
}
