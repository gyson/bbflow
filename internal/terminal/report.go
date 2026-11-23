package terminal

import (
	"bytes"
	"strconv"

	xterm "github.com/eugenioenko/xterm-go"
)

// Reports describes how a view makes focus reports and mouse reports from one frame. It
// holds the modes of the application in that frame and the place of the view in the
// terminal. A view makes a report without a typed key, a paste, or a message.
type Reports struct {
	Focus  bool // Focus reporting is on.
	Mouse  bool // Mouse tracking is on.
	Pixels bool // A mouse report gives a position in pixels, not in cells.
	Top    int  // The first terminal row that the view shows. Rows count from 0.
	Rows   int  // The rows of the terminal.
	Cols   int  // The columns of the terminal.
}

func reports(m xterm.DecPrivateModes, rows, cols int) Reports {
	r := Reports{Focus: m.SendFocus, Pixels: m.MouseEncoding == "SGR_PIXELS", Rows: rows, Cols: cols}
	switch m.MouseTrackingMode {
	case "X10", "VT200", "DRAG", "ANY":
		r.Mouse = true
	}
	return r
}

// Translate tells whether data holds only reports of a view with this frame: focus
// reports while focus reporting is on, and mouse reports while mouse tracking is on.
// The same bytes are not a report when the mode is off.
//
// For reports, Translate returns the bytes for the PTY. A view can show other rows than
// the first rows of the terminal, and it can be larger than the terminal. A mouse report
// gets the terminal row of the cell that the view shows. A mouse report outside the
// terminal is absent from the result. So is a pixel report from a view that does not
// show the first terminal row, because the height of a cell is unknown.
func (r Reports) Translate(data []byte) (out []byte, ok bool) {
	if len(data) == 0 {
		return nil, false
	}
	for len(data) > 0 {
		n := 0
		if r.Focus {
			if n = focusReport(data); n > 0 {
				out = append(out, data[:n]...)
			}
		}
		if n == 0 && r.Mouse {
			var report []byte
			if report, n = r.mouseReport(data); n > 0 {
				out = append(out, report...)
			}
		}
		if n == 0 {
			return nil, false
		}
		data = data[n:]
	}
	return out, true
}

// focusReport returns the length of the focus report at the start of data, or 0.
func focusReport(data []byte) int {
	if bytes.HasPrefix(data, []byte("\x1b[I")) || bytes.HasPrefix(data, []byte("\x1b[O")) {
		return 3
	}
	return 0
}

// mouseReport reads the mouse report at the start of data. It returns the report for the
// PTY and the length that it read, or 0 without a mouse report. The report for the PTY is
// empty when the PTY must not get it. mouseReport accepts the default encoding, `CSI M`
// and 3 bytes, and the SGR encodings, `CSI <` with 3 numbers and a final `M` or `m`. A
// view can use another encoding than the application selected.
func (r Reports) mouseReport(data []byte) (report []byte, n int) {
	if bytes.HasPrefix(data, []byte("\x1b[M")) {
		if len(data) < 6 {
			return nil, 0
		}
		// Each value is a byte with an offset of 32. Positions count from 1.
		col, row := int(data[4])-32, int(data[5])-32+r.Top
		if !r.inside(col, row) || row+32 > 255 {
			return nil, 6
		}
		return []byte{0x1b, '[', 'M', data[3], data[4], byte(row + 32)}, 6
	}
	if !bytes.HasPrefix(data, []byte("\x1b[<")) {
		return nil, 0
	}
	var fields [3]int
	i := 3
	for field := range fields {
		start := i
		for i < len(data) && data[i] >= '0' && data[i] <= '9' {
			i++
		}
		// A terminal position has at most 5 digits.
		if i == start || i-start > 5 || i == len(data) {
			return nil, 0
		}
		fields[field], _ = strconv.Atoi(string(data[start:i]))
		if field < 2 {
			if data[i] != ';' {
				return nil, 0
			}
			i++
		}
	}
	if data[i] != 'M' && data[i] != 'm' {
		return nil, 0
	}
	n = i + 1
	if r.Pixels {
		if r.Top > 0 {
			return nil, n
		}
		return data[:n], n
	}
	col, row := fields[1], fields[2]+r.Top
	if !r.inside(col, row) {
		return nil, n
	}
	report = append(report, "\x1b[<"...)
	report = strconv.AppendInt(report, int64(fields[0]), 10)
	report = append(report, ';')
	report = strconv.AppendInt(report, int64(col), 10)
	report = append(report, ';')
	report = strconv.AppendInt(report, int64(row), 10)
	return append(report, data[i]), n
}

// inside tells whether a position that counts from 1 is in the terminal.
func (r Reports) inside(col, row int) bool {
	return col >= 1 && col <= r.Cols && row >= 1 && row <= r.Rows
}
