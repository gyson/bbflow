-- Remote access accepts the requests that a reverse proxy on this computer forwards for
-- one host name and one Tailscale login. Both values start empty, so remote access
-- starts off, also after an upgrade. The upgrade keeps the settings revision.
UPDATE settings SET data = json_insert(data, '$.remoteHost', '', '$.remoteLogin', '') WHERE id=1;
