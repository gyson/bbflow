-- A pinned session shows in the Pinned group at the top of the sidebar. pinned_at keeps
-- the time of the pin, and NULL means that the session is not pinned. Only a top-level
-- session that is not archived can have a pin. The upgrade pins no session.
ALTER TABLE sessions ADD COLUMN pinned_at TEXT
    CHECK(pinned_at IS NULL OR (parent_id IS NULL AND archived=0));
