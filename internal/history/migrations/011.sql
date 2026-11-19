-- The server keeps the port that it last used. A restart listens on that port again
-- when it is free, so open browser tabs can reconnect. Port 0 means no saved port.
CREATE TABLE server (id INTEGER PRIMARY KEY CHECK(id=1), port INTEGER NOT NULL CHECK(port BETWEEN 0 AND 65535));
INSERT INTO server VALUES(1,0);
