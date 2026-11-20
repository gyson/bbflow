-- A sub-session belongs to a parent session. A parent is a top-level session with no
-- parent. Existing sessions stay top-level sessions.
ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id);
CREATE INDEX sessions_parent ON sessions(parent_id);
