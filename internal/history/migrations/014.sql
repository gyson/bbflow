-- Settings can name the port of the server. Port 0 selects the automatic port, which is
-- the earlier behavior. The upgrade keeps the settings revision.
UPDATE settings SET data = json_insert(data, '$.port', 0) WHERE id=1;
