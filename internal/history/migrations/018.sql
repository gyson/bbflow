-- Remote access has its own switch. While the switch is off, the settings keep the host
-- name and the login. The switch starts on only where both values are saved, because
-- remote access was on there before. Elsewhere it starts off. The upgrade keeps the
-- settings revision.
UPDATE settings SET data = json_set(data, '$.remoteOn', json(CASE
    WHEN coalesce(json_extract(data, '$.remoteHost'), '') <> '' AND coalesce(json_extract(data, '$.remoteLogin'), '') <> '' THEN 'true'
    ELSE 'false' END)) WHERE id=1;
