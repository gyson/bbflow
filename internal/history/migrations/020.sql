-- The settings get the list of saved prompts. The ＋ menu of the message editor puts the
-- text of a prompt at the cursor. The upgrade adds an empty list and keeps the settings
-- revision.
UPDATE settings SET data = json_set(data, '$.prompts', json('[]')) WHERE id=1;
