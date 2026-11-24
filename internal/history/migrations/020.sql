-- The settings select the default width of the web UI sidebar. Normal is the default.
UPDATE settings SET data = json_insert(data, '$.sidebarWidth', 'normal') WHERE id=1;
