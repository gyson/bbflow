# bbflow development

This guide gives the procedures to build, check, and release bbflow. See
[AGENTS.md](../AGENTS.md) for the contributor rules. See
[SPEC.md](SPEC.md#architecture-and-build) for the architecture and
[COMMANDS.md](COMMANDS.md) for the `bbflow` commands.

## Build and run

Builds require Go 1.27.3+, Node.js 22+, and npm. The binary includes the web UI. It
does not need Go or Node.js to run.

```sh
npm --prefix web ci --ignore-scripts
make build
./bin/bbflow server start
./bin/bbflow ui
```

Run the `npm` command after you clone the repository and after each lockfile change.

| Command | Result |
| --- | --- |
| `make build` | The development binary `bin/bbflow`. It uses `~/.bbflow-dev`. It also builds the [demo tool](#demo-instance) `bin/bbflow-demo`. |
| `make release` | The production binary `bin/release/bbflow`. It uses `~/.bbflow`. |
| `make web-build` | The frontend only, in `internal/webui/dist/`. |
| `npm --prefix web run typecheck` | A TypeScript check that generates no files. |

`make build` and `make release` build the frontend before Go. Plain `go build` and
`go run` also use `~/.bbflow-dev`. In a fresh checkout, run `make web-build` before
direct `go build`, `go run`, `go test`, or `go vet` commands.

A running server keeps its code and embedded UI. After a change, do these steps:

1. Run `make build`.
2. Run `./bin/bbflow server restart`. Restart ends active sessions.
3. Wait for the open page to reload. The server keeps its port. If another program
   holds that port, use the newly printed URL or `bbflow ui`.

Use global `--dir` with a temporary directory for checks that must not touch your data.
See [instance directory](COMMANDS.md#instance-directory).

## Demo instance

A demo instance is an instance with simulated projects, tools, and sessions. Use it to
try a code change in the web UI without your own data. It keeps all its files in
`.bbflow-demo/` in the checkout, which Git ignores.

```sh
make build
DISABLE_AUTO_UPDATE=true ./bin/bbflow --dir .bbflow-demo server start
./bin/bbflow-demo seed
./bin/bbflow-demo clean
```

The regular `server` commands start, restart, and stop the demo server. `seed` adds the
data one time and prints the URL. `clean` stops the server and removes the folder. The
[demo-instance skill](../.agents/skills/demo-instance/SKILL.md) gives the full
procedure, the simulated data, and the limits. Agents load it as a project skill.
`bbflow-demo` is a developer tool in `cmd/bbflow-demo`. Releases do not include it.

## Checks

```sh
make test
make check
make web-check
make skill-check
go test -race ./...
```

| Command | Check |
| --- | --- |
| `make test` | Go tests with `CGO_ENABLED=0`. `TestDemo` builds both executables, then seeds and cleans real servers. `go test -short` skips it. |
| `make check` | `go vet` and a syntax check of the shell scripts. |
| `make web-check` | Frontend fixtures. It compiles modules into the ignored `web/dist/`. |
| `make skill-check` | Fixture checks of the project skill scripts. It needs `jq` and no network access. |
| `go test -race ./...` | Go tests with the race detector, for concurrent runtime changes. |

- `make test` and `make check` build the frontend first.
- The race detector needs CGO for tests. Deployment builds do not need CGO.
- Pseudo-terminal (PTY) tests launch interactive shells and synthetic commands. They
  need permission to create local processes and terminal devices.
- See [validation](SPEC.md#validation) for the record of fixtures and manual checks.

## Logo

The logo source is `web/src/bbflow.svg`. It draws the letters "bb" on a 16-unit pixel
grid in six rainbow bands. Each band is two grid rows. The frontend build renders the
menu bar PNG from this source at 2 pixels per grid unit.

GitHub selects README images from its own theme, so the README uses fixed-color light
and dark copies in `docs/images/`. `web/logo.test.mjs` checks that the copies keep the
shape and colors of the source.

## Screenshots

The README and `GUIDE.md` show screenshots of the web UI from `docs/images/`. The
screenshots use only the dark appearance.

| File | View | Viewport |
| --- | --- | --- |
| `session.png` | A Claude Code session in the demo project **Orbit API** | 1200 x 836 |
| `draft.png` | The demo draft **Plan release notes**, with the tool **Claude Code** | 1200 x 820 |

To capture the screenshots again, do these steps:

1. Start a [demo instance](#demo-instance) in `/Users/Shared/bbflow-demo`, then add the
   demo data. Use a shell that is not inside an agent session.

   ```sh
   make build
   DISABLE_AUTO_UPDATE=true ./bin/bbflow --dir /Users/Shared/bbflow-demo server start
   ./bin/bbflow-demo --dir /Users/Shared/bbflow-demo seed
   ```

   The UI shows the instance path, so the path must not contain a user name. Each
   session inherits the environment of the server.
2. Open the UI in the browser view that captures the pages, with the viewport of
   `session.png`. Do steps 3 to 7 in this view. A second view with a different
   terminal width makes Claude Code draw its output again. An earlier copy of the
   message then stays in the terminal.
3. In **Orbit API**, create a draft with the tool **Claude Code** and without **Use
   worktree**. Name it **Explain the period formula**. Start the session.
4. Accept the trust question of Claude Code. Claude Code saves this answer in
   `~/.claude.json`.
5. Send one short question about `internal/orbit/period.go` from the message editor.
   Ask for no file changes. Wait for the answer and the status **Idle**.
6. Write a second message in the message editor. Do not send it.
7. Click **Earlier message** above the terminal. The question is then at the top of
   the terminal. Wait two seconds, until the highlight of the row is gone.
8. Open the draft **Plan release notes**. Select the tool **Claude Code**. The seed selects
   **Demo agent** for this draft.
9. Capture each view with the viewport of the table. Use the dark color scheme and a
   device scale factor of 2.
10. Remove the demo instance.

   ```sh
   ./bin/bbflow-demo --dir /Users/Shared/bbflow-demo clean
   ```

Before you commit a screenshot, make sure that it shows no account name, no home
folder, and no real session. The agent session uses the account of the person who
captures it, and it calls the model one time.

## Database migrations

When you change the schema or a durable data format, including stored JSON, do these
steps:

1. Add the next numbered SQL file under `internal/history/migrations/`, for example
   `009.sql`. Do not change a released migration file.
2. Increase `schemaVersion`.
3. Add a frozen schema for the previous format under `internal/history/testdata/`. Keep
   frozen schemas independent of migration code.
4. Test record preservation, skipped versions, rollback, repeated opens, and concurrent
   upgrades.
5. Update the format numbers in [SPEC.md](SPEC.md#database-upgrades). Update
   `cmd/bbflow/skill.md` when the tables change.

Scripts run inside the transaction of the migration runner. Do not include transaction
control, `VACUUM`, or version PRAGMAs. Fresh databases run the same chain from the
format 3 baseline.

## Publish a release

A release has three parts: build and check the archives, publish them for a tag, and
check the installer. Publish with the Release workflow. Publish manually only when
hosted Actions is unavailable.

### Build and check the archives

Install the locked frontend dependencies. Then run the checks and create the archives.
Replace `X.Y.Z` with the release version:

```sh
npm --prefix web ci --ignore-scripts
make test
make check
make web-check
make skill-check
make release VERSION=X.Y.Z
sh scripts/smoke-release.sh "$PWD/bin/release/bbflow" X.Y.Z
make release-assets VERSION=X.Y.Z
```

- `make release` without `VERSION` reports `dev`.
- `make release-assets` requires a full version and builds macOS `arm64` and `amd64`
  with `CGO_ENABLED=0`.
- It writes two archives, `install.sh`, and SHA-256 `checksums.txt` to
  `bin/releases/vX.Y.Z/`. The output directory must not already exist. Git ignores it.
- Each archive includes the executable, `LICENSE`, and `THIRD_PARTY_NOTICES.txt`.
- Use the patched Go version that `go.mod` requires.

The smoke check uses a temporary instance. Its server adds a menu bar icon until the
check stops it. It verifies the embedded UI and a read-only query. It stops the server
before it removes temporary files.

### Publish with the Release workflow

To publish with the Release workflow, do these steps:

1. Write the release notes in `docs/releases/X.Y.Z.md`.
2. Commit the source.
3. Push an annotated `vX.Y.Z` tag at that commit.

The workflow runs the checks and a native smoke check on Apple Silicon and Intel macOS
runners. Only after both pass does it package and publish the release with those notes.
The workflow uses the GitHub token of the repository. It does not change repository
visibility.

### Publish manually

If hosted Actions is unavailable, publish manually:

1. Run the same checks locally.
2. Verify the intended remote tag.
3. Create a release for that tag in GitHub with the release notes of the version.
4. Attach the four generated files from `bin/releases/vX.Y.Z/`.

Use either the workflow or manual publishing for a tag, not both. Never replace
published release assets or retag a published version. Publish a new version for fixes.

### Check the installer

Installer fixtures run under `make test` with synthetic binaries and GitHub API
responses. For a live installation check, use the installer `--dir` option with a
temporary directory. Then run the smoke check against that installed executable. Do not
test against production history.
