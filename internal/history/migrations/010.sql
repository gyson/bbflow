-- The title column keeps the title that the user set, or an empty string. The new
-- auto_title column keeps the derived title. Existing titles stay user titles.
ALTER TABLE sessions ADD COLUMN auto_title TEXT NOT NULL DEFAULT '';
-- Automatic titles start off. The upgrade keeps the settings revision.
UPDATE settings SET data = json_insert(data, '$.titleTool', 'none') WHERE id=1;
