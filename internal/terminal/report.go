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
	Focus    bool   // Focus reporting is on.
	Tracking string // The mouse tracking mode. It is empty while mouse tracking is off.
	Pixels   bool   // A mouse report gives a position in pixels, not in cells.
	Top      int    // The first terminal row that the view shows. Rows count from 0.
	Rows     int    // The rows of the terminal.
	Cols     int    // The columns of the terminal.
}

func reports(m xterm.DecPrivateModes, rows, cols int) Reports {
	r := Reports{Focus: m.SendFocus, Pixels: m.MouseEncoding == "SGR_PIXELS", Rows: rows, Cols: cols}
	switch m.MouseTrackingMode {
	case "X10", "VT200", "DRAG", "ANY":
		r.Tracking = m.MouseTrackingMode
	}
	return r
}

// Buttons holds the mouse buttons that a view pressed on a terminal cell and did not
// release yet. Bit 0 is the first button.
type Buttons uint8

// Translate tells whether data holds only reports of a view with this frame: focus
// reports while focus reporting is on, and mouse reports while mouse tracking is on.
// The same bytes are not a report when the mode is off.
//
// For reports, Translate returns the bytes for the PTY. A view can show other rows than
// the first rows of the terminal, and it can be larger than the terminal. A mouse report
// gets the terminal row of the cell that the view shows. A mouse report outside the
// terminal is absent from the result, with one exception. While a button from a press
// on a terminal cell is down, a motion or a release outside the terminal gets the
// nearest terminal cell, so that the application sees the end of the gesture. held
// keeps these buttons between calls. A pixel report from a view that does not show the
// first terminal row is also absent, because the height of a cell is unknown.
func (r Reports) Translate(data []byte, held *Buttons) (out []byte, ok bool) {
	if len(data) == 0 {
		return nil, false
	}
	// Change held only when all of data is reports.
	buttons := *held
	for len(data) > 0 {
		n := 0
		if r.Focus {
			if n = focusReport(data); n > 0 {
				out = append(out, data[:n]...)
			}
		}
		if n == 0 && r.Tracking != "" {
			var report []byte
			if report, n = r.mouseReport(data, &buttons); n > 0 {
				out = append(out, report...)
			}
		}
		if n == 0 {
			return nil, false
		}
		data = data[n:]
	}
	*held = buttons
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
func (r Reports) mouseReport(data []byte, held *Buttons) (report []byte, n int) {
	if bytes.HasPrefix(data, []byte("\x1b[M")) {
		if len(data) < 6 {
			return nil, 0
		}
		// Each value is a byte with an offset of 32. Positions count from 1. A release
		// has the button value 3 and does not name its button.
		code := int(data[3]) - 32
		release := code&(motionBit|wheelBit) == 0 && code&3 == 3
		col, row, ok := r.cell(code, release, int(data[4])-32, int(data[5])-32, held, true)
		if !ok || col+32 > 255 || row+32 > 255 {
			return nil, 6
		}
		return []byte{0x1b, '[', 'M', data[3], byte(col + 32), byte(row + 32)}, 6
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
	col, row, ok := r.cell(fields[0], data[i] == 'm', fields[1], fields[2], held, false)
	if !ok {
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

// A mouse report has these bits in its button code.
const (
	motionBit = 32
	wheelBit  = 64
)

// cell returns the terminal cell of a mouse report from the cell of the view. Positions
// count from 1. It is not ok when the PTY must not get the report. code is the button
// code of the report. anyButton is true when a release does not name its button.
func (r Reports) cell(code int, release bool, col, row int, held *Buttons, anyButton bool) (int, int, bool) {
	row += r.Top
	inside := col >= 1 && col <= r.Cols && row >= 1 && row <= r.Rows
	button := Buttons(1) << (code & 3)
	gesture := false
	switch {
	case code&wheelBit != 0:
	case release:
		if anyButton {
			button = *held
		}
		gesture = *held&button != 0
		*held &^= button
	case code&motionBit != 0:
		// A motion with the button value 3 has no button down. The view did not report
		// the release of an earlier press.
		if code&3 == 3 {
			*held = 0
		}
		gesture = *held != 0
	case inside:
		*held |= button
	default:
		*held &^= button
	}
	if !inside && !gesture {
		return 0, 0, false
	}
	return min(max(col, 1), r.Cols), min(max(row, 1), r.Rows), true
}
