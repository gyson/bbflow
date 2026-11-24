-- A tool has a type, a default model, and a default thinking effort. The type comes from
-- the first word of the command, without its folder: codex, claude, agy, and code-puppy
-- keep that name. A first word that the shell interprets, such as a quoted word, and
-- other commands give custom. In each CASE below, substr gives the first word, GLOB finds
-- a character that the shell interprets, and replace with rtrim removes the text up to
-- the last slash. The model and the effort start empty, which adds no option to a
-- command. The upgrade keeps the order of the tools and the settings revision.
UPDATE settings SET data = json_set(data, '$.tools', (
  SELECT json_group_array(json(tool)) FROM (
    SELECT json_set(value,
      '$.type', CASE WHEN substr(ltrim(json_extract(value, '$.command')), 1, instr(ltrim(json_extract(value, '$.command')) || ' ', ' ') - 1) = '' OR substr(ltrim(json_extract(value, '$.command')), 1, instr(ltrim(json_extract(value, '$.command')) || ' ', ' ') - 1) GLOB '*[^A-Za-z0-9_./~+@-]*' THEN 'custom' ELSE CASE replace(substr(ltrim(json_extract(value, '$.command')), 1, instr(ltrim(json_extract(value, '$.command')) || ' ', ' ') - 1), rtrim(substr(ltrim(json_extract(value, '$.command')), 1, instr(ltrim(json_extract(value, '$.command')) || ' ', ' ') - 1), replace(substr(ltrim(json_extract(value, '$.command')), 1, instr(ltrim(json_extract(value, '$.command')) || ' ', ' ') - 1), '/', '')), '')
        WHEN 'codex' THEN 'codex' WHEN 'claude' THEN 'claude' WHEN 'agy' THEN 'agy' WHEN 'code-puppy' THEN 'code-puppy'
        ELSE 'custom' END END,
      '$.model', '', '$.effort', '') AS tool
    FROM json_each(data, '$.tools') ORDER BY key))) WHERE id=1;

-- Each agent type has one built-in tool. bbflow owns its name, type, and command. The user
-- sets only its CLI path, its default model and effort, and whether it is on. A saved
-- tool becomes the built-in tool of its type when its command is the command of the
-- built-in tool, with the CLI name or a path of the CLI as the first word. Then the path
-- becomes its CLI path, and it keeps its ID and name. Only the first such tool of a type
-- does. Other saved tools stay tools of the user, which are custom. Every saved tool
-- stays on, and its launches submit the same words as before.
--
-- A type without such a tool gets a new built-in tool that is off. The server turns it on
-- at its next start when its CLI is on PATH and no tool of the user of its type is on. A
-- new name that another tool has gets the suffix " (built-in)", because the CLI selects a
-- tool by its name. The built-in tools come first in the list: the saved ones in their
-- order, then the new ones. The other saved tools follow in their order. Shell, the
-- built-in tool without a command, stays on.
WITH presets(position, type, name, args) AS (
  SELECT 1, 'codex', 'Codex', '--no-alt-screen'
  UNION ALL SELECT 2, 'claude', 'Claude Code', ''
  UNION ALL SELECT 3, 'agy', 'Antigravity', ''
  UNION ALL SELECT 4, 'code-puppy', 'Code Puppy', ''
), words AS (
  SELECT t.key AS position, t.value AS value, json_extract(t.value, '$.type') AS type,
    ltrim(json_extract(t.value, '$.command')) AS command
  FROM json_each((SELECT data FROM settings WHERE id=1), '$.tools') AS t
), parts AS (
  SELECT position, value, type, substr(command, 1, instr(command || ' ', ' ') - 1) AS word,
    trim(substr(command, length(substr(command, 1, instr(command || ' ', ' ') - 1)) + 1)) AS rest
  FROM words
), matches AS (
  SELECT parts.*, presets.args FROM parts JOIN presets ON presets.type = parts.type AND presets.args = parts.rest
), saved AS (
  SELECT parts.*, parts.position = (SELECT min(m.position) FROM matches AS m WHERE m.type = parts.type) AS builtin
  FROM parts
)
UPDATE settings SET data = json_set(data,
  '$.tools', (
    SELECT json_group_array(json(tool)) FROM (
      SELECT CASE WHEN s.builtin
          THEN json_set(s.value, '$.builtin', json('true'), '$.enabled', json('true'),
            '$.path', CASE WHEN s.word = s.type THEN '' ELSE s.word END,
            '$.command', CASE WHEN s.rest = '' THEN s.word ELSE s.word || ' ' || s.rest END)
          ELSE json_set(s.value, '$.type', 'custom', '$.builtin', json('false'), '$.enabled', json('true'), '$.path', '') END AS tool,
        CASE WHEN s.builtin THEN 0 ELSE 2 END AS tier, s.position
      FROM saved AS s
      UNION ALL
      SELECT json_object('id', 'builtin-' || p.type,
          'name', CASE WHEN EXISTS (SELECT 1 FROM saved WHERE json_extract(saved.value, '$.name') = p.name)
            THEN p.name || ' (built-in)' ELSE p.name END,
          'command', CASE WHEN p.args = '' THEN p.type ELSE p.type || ' ' || p.args END,
          'type', p.type, 'model', '', 'effort', '', 'builtin', json('true'), 'enabled', json('false'), 'path', '') AS tool,
        1 AS tier, p.position
      FROM presets AS p
      WHERE NOT EXISTS (SELECT 1 FROM saved WHERE saved.builtin AND saved.type = p.type)
      ORDER BY tier, position)),
  '$.checkTools', json('true'), '$.shellOff', json('false')) WHERE id=1;

-- A title tool of an agent CLI has a model and a thinking effort. The upgrade saves the
-- model and the effort that its command had before, so the command stays the same.
UPDATE settings SET data = json_set(data,
  '$.titleModel', CASE json_extract(data, '$.titleTool')
    WHEN 'claude' THEN 'haiku' WHEN 'codex' THEN 'gpt-6-luna' WHEN 'code-puppy' THEN 'codex-gpt-6-luna' ELSE '' END,
  '$.titleEffort', CASE json_extract(data, '$.titleTool') WHEN 'codex' THEN 'low' ELSE '' END) WHERE id=1;

-- A draft and a launched session keep a snapshot of the tool type and of the chosen model
-- and effort. The type is the type of its tool when that tool is a built-in tool. Other
-- tools, also a removed tool, are custom. Shell has no type. The upgrade keeps the
-- preparation revisions.
UPDATE preparations SET data = json_set(data,
  '$.toolType', CASE
    WHEN coalesce(json_extract(data, '$.toolId'), '') = '' THEN ''
    ELSE coalesce((SELECT json_extract(t.value, '$.type')
      FROM settings, json_each(settings.data, '$.tools') AS t
      WHERE settings.id = 1 AND json_extract(t.value, '$.id') = json_extract(preparations.data, '$.toolId')
        AND json_extract(t.value, '$.builtin')), 'custom')
    END,
  '$.model', '', '$.effort', '');
