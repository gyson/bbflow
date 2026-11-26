-- The saved prompts get groups. The settings get an empty list of prompt groups, and
-- each saved prompt gets an empty group, so it stays at the top level of the ＋ menu.
-- The upgrade keeps the order of the prompts and the settings revision.
UPDATE settings SET data = json_set(data, '$.promptGroups', json('[]'), '$.prompts', json((
  SELECT json_group_array(json(prompt)) FROM (
    SELECT json_set(value, '$.group', '') AS prompt FROM json_each(data, '$.prompts') ORDER BY key)))) WHERE id=1;
