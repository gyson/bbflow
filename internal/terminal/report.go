package terminal

import "bytes"

// IsReport tells whether data holds only reports that the application turned on: focus
// reports and mouse reports. A view sends such a report without a typed key, a paste,
// or a message. The answer uses the modes that the application set. Thus the same
// bytes are not a report when the application did not ask for them.
func (s *State) IsReport(data []byte) bool {
	m := s.term.DecPrivateModes()
	mouse := false
	switch m.MouseTrackingMode {
	case "X10", "VT200", "DRAG", "ANY":
		mouse = true
	}
	if len(data) == 0 {
		return false
	}
	for len(data) > 0 {
		n := 0
		if m.SendFocus {
			n = focusReport(data)
		}
		if n == 0 && mouse {
			n = mouseReport(data)
		}
		if n == 0 {
			return false
		}
		data = data[n:]
	}
	return true
}

// focusReport returns the length of the focus report at the start of data, or 0.
func focusReport(data []byte) int {
	if bytes.HasPrefix(data, []byte("\x1b[I")) || bytes.HasPrefix(data, []byte("\x1b[O")) {
		return 3
	}
	return 0
}

// mouseReport returns the length of the mouse report at the start of data, or 0. It
// accepts the default encoding, `CSI M` and 3 bytes, and the SGR encodings, `CSI <`
// with 3 numbers and a final `M` or `m`.
func mouseReport(data []byte) int {
	if bytes.HasPrefix(data, []byte("\x1b[M")) {
		if len(data) < 6 {
			return 0
		}
		return 6
	}
	if !bytes.HasPrefix(data, []byte("\x1b[<")) {
		return 0
	}
	i := 3
	for field := 0; field < 3; field++ {
		start := i
		for i < len(data) && data[i] >= '0' && data[i] <= '9' {
			i++
		}
		if i == start || i == len(data) {
			return 0
		}
		if field < 2 {
			if data[i] != ';' {
				return 0
			}
			i++
		}
	}
	if data[i] != 'M' && data[i] != 'm' {
		return 0
	}
	return i + 1
}
