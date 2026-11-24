-- Frozen format 18 schema from 68f5c20.
-- Keep independent of the migration scripts. Synthetic data only.
CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace TEXT NOT NULL UNIQUE, created TEXT NOT NULL
);
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, title TEXT NOT NULL,
    workspace TEXT NOT NULL, created TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
    auto_title TEXT NOT NULL DEFAULT '',
    parent_id TEXT REFERENCES sessions(id)
);
CREATE TABLE runs (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    status TEXT NOT NULL, started TEXT NOT NULL, ended TEXT NOT NULL DEFAULT '',
    pid INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, data TEXT NOT NULL);
INSERT INTO settings VALUES(1,0,'{"defaultTool":"","worktree":false,"base":"HEAD","tools":[{"id":"builtin-codex","name":"Codex","command":"codex --no-alt-screen","type":"codex","model":"","effort":"","builtin":true,"enabled":false,"path":""},{"id":"builtin-claude","name":"Claude Code","command":"claude","type":"claude","model":"","effort":"","builtin":true,"enabled":false,"path":""},{"id":"builtin-agy","name":"Antigravity","command":"agy","type":"agy","model":"","effort":"","builtin":true,"enabled":false,"path":""},{"id":"builtin-code-puppy","name":"Code Puppy","command":"code-puppy","type":"code-puppy","model":"","effort":"","builtin":true,"enabled":false,"path":""}],"appearance":"system","titleTool":"none","updateCheck":true,"port":0,"titleCommand":"","remoteHost":"","remoteLogin":"","checkTools":true,"shellOff":false,"titleModel":"","titleEffort":"","remoteOn":false}');
CREATE TABLE preparations (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id), revision INTEGER NOT NULL,
    state TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE worktrees (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id), path TEXT NOT NULL UNIQUE,
    repository TEXT NOT NULL, base TEXT NOT NULL, commit_id TEXT NOT NULL,
    branch TEXT NOT NULL, state TEXT NOT NULL
);
CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL,
    kind TEXT NOT NULL, data BLOB NOT NULL,
    text TEXT NOT NULL DEFAULT '', created TEXT NOT NULL
);
CREATE INDEX sessions_project ON sessions(project_id);
CREATE INDEX sessions_parent ON sessions(parent_id);
CREATE INDEX events_session ON events(session_id,seq);
CREATE INDEX events_run ON events(run_id,seq);
CREATE INDEX events_output_run ON events(run_id,seq) WHERE kind='output' AND text<>'';
CREATE INDEX events_start_run ON events(run_id,seq) WHERE kind='start';
CREATE TABLE server (id INTEGER PRIMARY KEY CHECK(id=1), port INTEGER NOT NULL CHECK(port BETWEEN 0 AND 65535));
INSERT INTO server VALUES(1,0);
PRAGMA user_version=18;
INSERT INTO projects VALUES ('project','Saved project','/missing/workspace','2026-10-01T00:00:00Z');
UPDATE server SET port=43117 WHERE id=1;
UPDATE settings SET revision=9,data='{
  "appearance":"dark","titleTool":"codex","titleCommand":"example-title --fast","titleModel":"gpt-6-luna","titleEffort":"low","updateCheck":false,"port":50000,
  "remoteHost":"my-mac.example.ts.net","remoteLogin":"user@example.com","defaultTool":"example","worktree":true,"base":"main","checkTools":false,"shellOff":false,"remoteOn":true,
  "tools":[
    {"id":"builtin-codex","name":"Codex","command":"codex --no-alt-screen","type":"codex","model":"gpt-6-luna","effort":"high","builtin":true,"enabled":true,"path":""},
    {"id":"builtin-claude","name":"Claude Code","command":"/opt/tools/bin/claude","type":"claude","model":"opus","effort":"","builtin":true,"enabled":true,"path":"/opt/tools/bin/claude"},
    {"id":"builtin-agy","name":"Antigravity","command":"agy","type":"agy","model":"","effort":"","builtin":true,"enabled":false,"path":""},
    {"id":"builtin-code-puppy","name":"Code Puppy","command":"code-puppy","type":"code-puppy","model":"","effort":"","builtin":true,"enabled":false,"path":""},
    {"id":"example","name":"Example","command":"example --interactive","type":"custom","model":"","effort":"","builtin":false,"enabled":true,"path":""}
  ]
}' WHERE id=1;
