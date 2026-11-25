package history

func (s *Store) Append(sid, rid, kind string, data []byte, text string) (Event, error) {
	return s.append(sid, rid, kind, data, text, false)
}

// AppendQuiet records an event that is not session activity, such as a focus report of a
// view. The order of the session list skips it.
func (s *Store) AppendQuiet(sid, rid, kind string, data []byte, text string) (Event, error) {
	return s.append(sid, rid, kind, data, text, true)
}

func (s *Store) append(sid, rid, kind string, data []byte, text string, quiet bool) (Event, error) {
	if data == nil {
		data = []byte{}
	}
	e := Event{SessionID: sid, RunID: rid, Kind: kind, Data: data, Text: text, Created: Now()}
	result, err := s.db.Exec("INSERT INTO events(session_id,run_id,kind,data,text,created,quiet) VALUES(?,?,?,?,?,?,?)", sid, rid, kind, data, text, e.Created, quiet)
	if err != nil {
		return e, err
	}
	e.Seq, err = result.LastInsertId()
	return e, err
}

// LastEvent returns the sequence of the latest event, or 0 without events.
func (s *Store) LastEvent() (int64, error) {
	var seq int64
	err := s.db.QueryRow("SELECT COALESCE(MAX(seq),0) FROM events").Scan(&seq)
	return seq, err
}

// MarkQuiet records that a recorded event is not session activity. The server decides
// this for output after it records the output, see AppendQuiet.
func (s *Store) MarkQuiet(seq int64) error {
	_, err := s.db.Exec("UPDATE events SET quiet=1 WHERE seq=?", seq)
	return err
}

// LastRunEventData returns the data of the latest event of one kind in one run.
func (s *Store) LastRunEventData(session, run, kind string) ([]byte, error) {
	rows, err := s.db.Query("SELECT data FROM events WHERE session_id=? AND run_id=? AND kind=? ORDER BY seq DESC LIMIT 1", session, run, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var data []byte
	if rows.Next() {
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
	}
	return data, rows.Err()
}
