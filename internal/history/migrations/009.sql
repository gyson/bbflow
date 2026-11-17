UPDATE settings
SET data = json_set(data, '$.tools', (
    SELECT json_group_array(json_remove(tool.value, '$.continueCommand') ORDER BY tool.key)
    FROM json_each(settings.data, '$.tools') AS tool
))
WHERE id = 1 AND EXISTS (
    SELECT 1 FROM json_each(settings.data, '$.tools') AS tool
    WHERE json_type(tool.value, '$.continueCommand') IS NOT NULL
);
