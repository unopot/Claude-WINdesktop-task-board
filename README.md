# task-board

A board above the prompt in the Claude desktop app's **Code** tab that shows every Claude Code session you have going, side by side: what is running, what is waiting for you, what has finished, and how much prompt cache each finished session has left.

![The board: running sessions on the left, finished sessions on the right](docs/board.png)

Expand a running card to see its task list by stage, how long each step took, which model the session runs on, and which subagents each step sent out:

![Details of one session: stages, steps, subagents and the main model](docs/details.png)

## What it shows

**Running** (left column), one card per live session:

| Color | Status | Meaning |
| --- | --- | --- |
| blue | `43%` / `running` | working; the percentage is the task list's progress |
| yellow | `needs input` | waiting for you: a permission dialog, a question, or an MCP form |
| light blue | `waiting` | stopped on a long tool call that does not need you |

Each card also shows the elapsed time, how many subagents are running and the tokens used. The ring at the top right is your account's five-hour usage limit (the *Current session* figure on the Usage page), with the time until it resets.

**Done** (right column): finished sessions with a countdown of their prompt cache. When the cache expires, the next message rewrites the whole context, so this tells you which conversations are still cheap to continue. The session you are in gets a toast a few minutes before its cache runs out.

Interactions:

- Click a card to switch to that session.
- The arrow on a running card opens its details above the board: a stage strip, one row per step with its time, subagents under the step that started them (type, model, effort, current tool, task, tool calls, time), and a **Main** row with the session's own model and effort ("no subagents this turn" when there are none).
- The eye icon on a finished card hides it; it comes back by itself when that session gets a new request. **Details** (or `/task-board`) opens a pane listing every recent session, hidden ones included, with **Unhide**.
- **Next step** (on until you switch it off; one switch for all sessions): after each answer, fork the session once to propose three next prompts; clicking one fills the prompt box and never sends it. It costs one extra request per turn, so switch it off on the board if you do not want that.

## See sessions from your other computers

The board can also show the Claude Code sessions running on your other computers (any mix of Windows PCs and Macs), each card tagged with a short label such as **Win**, **Mac**, **Office** or **Laptop**.

Nothing talks over the network. Each computer writes one small file into a folder inside a drive you already sync (iCloud Drive, OneDrive, Google Drive, Dropbox, Syncthing, …) and reads the files the others wrote. If you are reading this with Claude, let it do the steps below; it only needs to know which synced drive you use and what you want each computer to be called.

### Set-up, step by step

Do this on **every** computer that should take part.

1. **Install the plugin for that computer's operating system.** Windows is this repository; for a Mac use [Claude-MACdesktop-task-board](https://github.com/unopot/Claude-MACdesktop-task-board). Follow its *Install* section (marketplace add, plugin install, full restart of the desktop app).
2. **Pick one folder in a synced drive** and use the same folder on every computer. The default is iCloud Drive:

   | | Shared folder setting |
   | --- | --- |
   | Windows | `~/iCloudDrive/Claude Code/task-board-shared` |
   | macOS | `~/Library/Mobile Documents/com~apple~CloudDocs/Claude Code/task-board-shared` |

   For another drive, point the setting at a sub-folder of that drive on each computer, in that computer's own path form, for example `~/OneDrive/Claude Code/task-board-shared`, `~/Google Drive/My Drive/Claude Code/task-board-shared` or `~/Sync/task-board-shared` (Syncthing). `~` means the home folder; the folder is created if missing. If the drive offers "online-only" / "files on demand", mark this folder as always kept on the device.
3. **Give the computer a label.** Run `/plugin configure task-board@unopot-mods` and set **This computer's label**: the default is **Win** here and **Mac** on a Mac. With two computers of the same kind, change one of them (Office, Laptop, Studio, …). Labels must be different on every computer: the label is also the file name in the shared folder, and two computers with the same label overwrite each other's file.
4. **Set the Shared folder** in the same settings screen if you are not using the iCloud default.
5. **Quit the desktop app completely and open it again**, then send one message in any session. Within about 10 seconds the shared folder contains `<label>.json` for this computer.
6. **Repeat on the next computer.** Once two computers have written their files, each board shows the other's sessions after the drive has synced (usually a few seconds to a minute).

### What you will see

- Cards from another computer carry a grey tag with that computer's label in front of the title. Clicking one opens that session through **Remote Control**: the desktop app opens it as a Remote Control session. This needs Remote Control on for that session on its own computer (desktop app setting **Connect new sessions to Remote Control**). A card written by a version before 2.2.0 carries no Remote Control id and cannot be clicked. Expanding a running card's details works as usual.
- The Details pane lists them too, tagged and clickable the same way.
- **Hide** and the **Next step** switch stay per computer.
- Delay = the 10-second snapshot cycle plus the drive's sync time: iCloud Drive and OneDrive usually a few seconds to a minute, Syncthing a second or two on a LAN.
- A computer whose file is more than 10 minutes old is treated as offline and disappears from the board.

### If the other computer does not show up

- Look in the shared folder: there must be one `<label>.json` per computer, updated every 10 seconds while a session is open. A missing file means that computer has not written yet (plugin not installed, app not restarted, or no session open); a file older than 10 minutes means its last session closed or the drive stopped syncing.
- Both computers must point at the **same folder of the same drive**. The paths differ per operating system, the folder does not.
- Two computers with the same label show up as one. Change one label.
- The drive must actually download the files (no "online-only" placeholders).
- Clicking a card from another computer opens a session that does not connect: Remote Control is off for that session on its own computer, or the session was closed there. Turn on **Connect new sessions to Remote Control** in that computer's desktop app settings; it applies to sessions started after that.
- Sync-conflict copies such as `Office 2.json` or `Office (1).json` are harmless: the newest copy of a session wins and the rest is ignored, and each computer deletes the copies the drive made of its own file.
- To turn sharing off on a computer, clear its Shared folder setting.

### What is shared

Only what the board shows: session titles, project folder names, task step titles, progress, token counts, model names and subagent descriptions, plus each session's Remote Control id so the other computer can open it (Remote Control itself still needs your Claude sign-in). Nothing from the conversations themselves, and nothing leaves your computers except through the synced drive you chose.

## Requirements

- **Windows 10 or 11.** The background scanner is a Windows PowerShell 5.1 script, which every Windows install has.
- **The Claude desktop app, Code tab.** The board is drawn for the desktop. In a terminal session it shows a compact one-line summary instead.
- A Claude Code build that loads hooks-module plugins ("mods"). Developed and tested on Claude Code 2.1.289.
- The usage ring needs a Claude subscription; without one it stays hidden.

## Install

```bash
claude plugin marketplace add unopot/Claude-WINdesktop-task-board
```

```bash
claude plugin install task-board@unopot-mods
```

Then quit the Claude desktop app completely (including the tray icon) and open it again. The board appears above the prompt a few seconds after your first message.

Update later with:

```bash
claude plugin marketplace update unopot-mods
```

```bash
claude plugin update task-board@unopot-mods
```

## Optional: group steps into stages

The board reads the task list Claude keeps for multi-step work. To get the stage strip, turn on the task tools and ask Claude to prefix task titles with a stage name:

1. In `~/.claude/settings.json`:

   ```json
   { "env": { "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" } }
   ```

2. In `~/.claude/CLAUDE.md`:

   ```markdown
   For tasks with three or more steps, create a task list with TaskCreate. Title each task
   `Stage: step` (short stage names, e.g. `Survey: Read files`) and create a stage's steps
   together. Mark a step in_progress when you start it and completed as soon as it is done.
   ```

Without these the board still works; the details simply list the steps without stages.

## Settings

Run `/plugin configure task-board@unopot-mods` in Claude Code:

| Setting | Default | |
| --- | --- | --- |
| Prompt cache lifetime | 60 min | 60 on a subscription; usually 5 on pay-as-you-go API |
| Warn before cache expires | 5 min | 0 turns the toast off |
| Skip suggestions after short answers | 80 characters | no suggestion, and no extra request, after shorter answers |
| Let suggestions use skills and slash commands | on | a suggestion may be `/skill-name` |
| Shared folder for other computers | `~/iCloudDrive/Claude Code/task-board-shared` | a folder in a synced drive, same on every computer (see above); empty = this computer only |
| This computer's label | Win | the grey tag shown on this computer's cards elsewhere, and its file name in the shared folder; unique per computer |

## How it works and what it touches

- Each session starts one small PowerShell process that reads the transcripts under `~/.claude/projects` incrementally every 3 seconds, plus the desktop app's session list for titles, links and Remote Control ids. Nothing leaves your machine; the plugin makes no network requests of its own.
- A session marks itself as *needs input* when it raises a permission dialog, `AskUserQuestion` or an MCP form, and clears the mark when the call finishes or the turn ends.
- It writes four small things under `~/.claude`: `task-board-prefs.json` (switch and hidden sessions), `task-board-usage.json` (latest usage reading, shared between sessions), `task-board-snapshot.json` (the latest scan, so a new session shows the board at once) and the folder `task-board-input/` (the needs-input marks). With sharing on it also writes `<label>.json` into the shared folder. Delete them after uninstalling if you like.
- Clicking a card opens a `claude://` link, which brings the desktop app to that session: `claude://claude.ai/epitaxy/local_…` for a session on this computer, `claude://claude.ai/code/session_…` (Remote Control) for one on another computer.

## Known limitations

- Windows only; for a Mac use [Claude-MACdesktop-task-board](https://github.com/unopot/Claude-MACdesktop-task-board). Both can share one board (see above).
- A card from another computer opens through Remote Control, so it only connects while Remote Control is on for that session on its own computer.
- The plugin cannot see the moment you approve a permission dialog, so after you approve a long command the card stays yellow until that command finishes.
- A subagent is attached to the step that was in progress when it started; subagents started between steps are listed under **Main**.

## Uninstall

```bash
claude plugin uninstall task-board@unopot-mods
```

```bash
claude plugin marketplace remove unopot-mods
```

## Development

The plugin lives in [`task-board/`](task-board); the repository root is its marketplace.

```bash
claude plugin validate task-board
```

```bash
claude plugin test task-board
```

## License

[MIT](LICENSE) © 2026 unopot
