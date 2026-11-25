-- quiet is 1 for a terminal event that is not session activity: a focus report or a
-- mouse report of a view, and output that changed nothing on the screen or that came
-- just after a view action. The server derives it when it records the event. The order
-- of the session list skips quiet events. Existing events stay 0. The column has no
-- CHECK constraint, because SQLite would read each existing event to test it.
ALTER TABLE events ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0;
