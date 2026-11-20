# bbflow

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/bbflow-dark.svg">
  <img src="docs/images/bbflow-light.svg" width="64" alt="bbflow logo: the letters bb on a 16-pixel grid in rainbow bands">
</picture>

bbflow is a local web workspace for agent command-line interface (CLI) tools. The server
owns interactive shells, terminal screens, and history. The browser handles sessions and
terminal input. The server saves original input, output, and run metadata.

bbflow is in daily use. Upgrades preserve existing history and settings. Commands and
APIs can still change.

## Install on macOS

```sh
curl -fsSL https://github.com/gyson/bbflow/releases/latest/download/install.sh | sh
```

The installer selects the latest build for Apple Silicon or Intel and installs it in
`~/.local/bin`. The installer does not need Go, Node.js, or GitHub CLI. If that
directory is not on your PATH, add `export PATH="$HOME/.local/bin:$PATH"` to your shell
configuration.

## Start bbflow

```sh
bbflow server start
bbflow ui
```

`bbflow server start` starts a background server. The server continues after the
terminal closes. On macOS, it also adds a menu bar icon with **Open UI** and
**Quit bbflow**. Quit bbflow stops the server and its sessions. `bbflow ui` opens the
home page in the default browser.

To use an agent, install its CLI on PATH and sign in normally. Each session uses the
environment of the server. After you change PATH or the environment, restart the server
from a shell that has the new values.

## Update

```sh
bbflow update
```

When a server runs, `bbflow update` asks for confirmation first. It then replaces the
executable and restarts the server with the new version. The restart ends active
sessions. See [Update bbflow](docs/COMMANDS.md#update-bbflow).

The web UI also shows a newer release above **Settings** in the sidebar. Click it to
see which sessions the restart ends. The update starts only after you confirm.

## Use the web UI

1. Click **＋ Project** at the bottom of the sidebar to save an existing folder.
   **General** is always available for work across projects.
2. In **Settings**, give each tool a name and a startup command, for example **Codex**
   with `codex`. **Shell** is always available.
3. Click **＋** beside a project to create a draft. Select a tool. To get independent
   files, select **Use worktree**. Then click **Start session**.
4. Type in the terminal. As an alternative, write a message in the editor below the
   terminal and click **Send**.
5. Close the tab when you want. The session and its recording continue in the server.
   Click **Stop session** to end the session.
6. After a session ends, click **Continue in new terminal**. bbflow writes a read-only
   handoff folder with the earlier terminals and messages. When the new agent is ready,
   send the **Handoff prompt** from the message editor.
7. Click the search icon to search the recorded output of a session, a project, or all
   sessions.

Run agents in the normal screen to keep their full output in the handoff transcript.
For Codex, use `codex --no-alt-screen`. For Claude Code, keep the fullscreen renderer
off.

To share a tool set with a team, write a setup script with `bbflow tool add` and
`bbflow settings set`. See [Manage tools](docs/COMMANDS.md#manage-tools).

## Your data

- The installed release keeps all durable bbflow data in `~/.bbflow/history.sqlite`.
  Workspace files and agent credentials stay outside this database.
- The recording includes all terminal input and output, including secrets that you
  type. bbflow does not redact or encrypt it.
- The server listens only on `127.0.0.1` and uses no authentication token. It does not
  protect the data from other processes that run as you.
- The server asks GitHub for the latest release when it starts and then once a day. The
  request sends no history or settings. Turn it off with **Check for a new version
  every day** in Settings.
- Backup and restore are not available. A copy of `history.sqlite` alone can miss
  committed data while the server runs.
- `bbflow query` reads the history with read-only SQL. An agent can run `bbflow skill`
  to learn these queries.

## Database upgrades

The server upgrades the database automatically when it starts. You do not need a fresh
database or a separate tool. Databases from v0.0.1 and later are supported. bbflow does
not support downgrades. See [database upgrades](docs/SPEC.md#database-upgrades) for the
supported formats and the upgrade behavior.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/COMMANDS.md](docs/COMMANDS.md) | Each `bbflow` command, its options, and its effects. |
| [docs/SPEC.md](docs/SPEC.md) | Implemented behavior of the server and the web UI, with limits. |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | WebSocket messages between the clients and the server. |
| [docs/GOAL.md](docs/GOAL.md) | The intended product. |
| [docs/PLAN.md](docs/PLAN.md) | Planned work. |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Build, check, and release procedures. |
| [docs/releases/](docs/releases/) | Release notes. |
| [AGENTS.md](AGENTS.md) | Rules for contributors and agents. |

## License

bbflow is licensed under the [MIT License](LICENSE).
