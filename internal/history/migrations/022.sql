-- A tool and a draft have a permission mode. The empty mode adds no option to the
-- command, so each CLI keeps its own setting, as before. The upgrade keeps the order of
-- the tools, the settings revision, and the preparation revisions.
UPDATE settings SET data = json_set(data, '$.tools', json((
  SELECT json_group_array(json(tool)) FROM (
    SELECT json_set(value, '$.permission', '') AS tool FROM json_each(data, '$.tools') ORDER BY key)))) WHERE id=1;

UPDATE preparations SET data = json_set(data, '$.permission', '');
