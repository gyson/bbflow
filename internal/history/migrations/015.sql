-- The custom title tool runs a command that the user saves. The upgrade saves no
-- command and keeps the selected title tool and the settings revision.
UPDATE settings SET data = json_insert(data, '$.titleCommand', '') WHERE id=1;
