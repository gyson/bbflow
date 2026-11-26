-- A tool and a draft have Code Mode, which only Claude Code has. Code Mode off adds
-- nothing to the command, so Claude Code keeps its own setting, as before. The upgrade
-- keeps the order of the tools, the settings revision, and the preparation revisions.
UPDATE settings SET data = json_set(data, '$.tools', json((
  SELECT json_group_array(json(tool)) FROM (
    SELECT json_set(value, '$.codeMode', json('false')) AS tool FROM json_each(data, '$.tools') ORDER BY key)))) WHERE id=1;

UPDATE preparations SET data = json_set(data, '$.codeMode', json('false'));
