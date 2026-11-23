# bbflow user guide

This guide tells you how to use the bbflow web UI, from the first start to a handoff
between agents. See [README.md](../README.md) for installation. See
[COMMANDS.md](COMMANDS.md) for each `bbflow` command. See [SPEC.md](SPEC.md) for the
exact rules and the limits.

## Start the server

```sh
bbflow server start
bbflow ui
```

- `bbflow server start` starts a background server. The server continues after the
  terminal closes.
- On macOS, the server adds a menu bar icon with **Open UI** and **Quit bbflow**. Quit
  bbflow stops the server and its sessions.
- `bbflow ui` opens the home page in the default browser.

Each session uses the environment of the server. After you change PATH or the
environment, restart the server from a shell that has the new values.

## Add your tools

A tool is an agent command-line interface (CLI) that bbflow can start, such as Codex or
Claude Code.

1. Install the CLI of the agent on PATH.
2. Sign in to the agent in a terminal, as you do without bbflow.
3. In bbflow, click **Settings** at the bottom of the sidebar.
4. Enter a name and a startup command for the tool, for example **Codex** with `codex`.
5. Click **Add tool**. bbflow does not save the tool before this step.

**Shell** is always available. It starts the shell without a command.

## Add a project

A project is a folder that you save in the sidebar. A new session of a project starts
in that folder. If you select **Use worktree**, the session starts in a new worktree of
that folder.

1. Click **＋ Project** at the bottom of the sidebar.
2. Enter the path of an existing folder in **Folder**. The project name is optional.
3. Click **Add project**.

**General** is always available for work across projects.

## Start a session

<img src="images/draft.png" alt="The Prepare a session form of a draft, with the session name, the tool, Use worktree, the starting branch, and the Start session button. The message editor is below the form.">

1. Click **＋** beside a project to create a draft.
2. Select a tool.
3. To give the session independent files, select **Use worktree**.
4. Click **Start session**.

You can write the first message in the editor below the form before you start. bbflow
saves the message as a draft. Click **Send** after the agent is ready.

## Work in a session

- Type in the terminal. As an alternative, write a message in the editor below the
  terminal and click **Send**.
- Close the tab when you want. The session and its recording continue in the server.
- Click **Stop session** to end the session.

### Go to a sent message

bbflow finds the messages that **Send** sent in the terminal output. The bar above the
terminal names the message that you read.

- Click **Earlier message** or **Later message** in the bar to go from message to
  message. In the terminal, press Command+Up or Command+Down. On other systems, press
  Ctrl+Shift+Up or Ctrl+Shift+Down.
- Click **Show messages** in the toolbar, or **Messages** in a narrow window, to see
  the list of the messages. Click **Show in terminal** on a message to scroll the
  terminal to it. The response follows the message.
- The marks in the scroll bar of the terminal show where each message is.
- Click **Latest output** in the bar to go back to the end of the terminal.

Text that you type directly in the terminal is not in the list. See
[Sent messages in the terminal](SPEC.md#sent-messages-in-the-terminal) for the rules
and limits.

## Continue with a different agent

Use this procedure after a session ends, for example when an agent reaches a quota
limit.

1. Click **Continue in new terminal**.
2. Select the tool for the new terminal.
3. Click **Start new terminal**. bbflow writes a read-only handoff folder with the
   earlier terminals and messages. Then it starts the tool.
4. Wait until the new agent is ready.
5. Click **Handoff prompt** in the message editor.
6. Click **Put in message editor**.
7. Click **Send**.

**Put in message editor** works only while the message editor is empty. If the editor
has a draft, click **Copy prompt** in the same dialog. Then paste the prompt where you
want it.

The prompt gives the new agent a record of the earlier work. It does not restore the
internal state of the earlier agent.

## Search the history

Click the search icon to search the recorded output of a session, a project, or all
sessions.

`bbflow query` reads the history with read-only SQL. An agent can run `bbflow skill` to
learn these queries. See [COMMANDS.md](COMMANDS.md).

## Use bbflow from another device

Remote access from another device, such as a phone, is off by default. It works through
Tailscale Serve. See [Remote access with Tailscale Serve](REMOTE.md) for the setup.

## Tips

- **Keep more output for the handoff.** Run agents in the normal screen. A program that
  uses the alternate screen leaves only its last screen in the handoff transcript. For
  Codex, use `codex --no-alt-screen`. For Claude Code, keep the fullscreen renderer off.
  A long session can still exceed the scrollback of its terminal. The handoff transcript
  then omits the oldest rows. The original recording keeps them. See the limits of
  [Continue in a new terminal](SPEC.md#continue-in-a-new-terminal).
- **Share a tool set.** To share a tool set with a team, write a setup script with
  `bbflow tool add` and `bbflow settings set`. See
  [Manage tools](COMMANDS.md#manage-tools).

## Your data

See [Privacy](../README.md#privacy) in the README for what bbflow records and sends.

- The installed release keeps all durable bbflow data in `~/.bbflow/history.sqlite`.
  Workspace files and agent credentials stay outside this database.
- The server listens only on loopback, `127.0.0.1` and `::1`, and uses no
  authentication token. It does not protect the data from other processes that run as
  you.
- Backup and restore are not available. A copy of `history.sqlite` alone can miss
  committed data while the server runs.
- The server upgrades the database automatically when it starts. See
  [database upgrades](SPEC.md#database-upgrades).

See [Data handling](SPEC.md#data-handling) for the exact rules.
