UPDATE settings SET data = json_insert(data, '$.appearance', 'system') WHERE id=1;
