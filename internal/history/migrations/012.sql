-- The server reads the latest release once a day. The check starts on, also after an
-- upgrade. The upgrade keeps the settings revision.
UPDATE settings SET data = json_insert(data, '$.updateCheck', json('true')) WHERE id=1;
