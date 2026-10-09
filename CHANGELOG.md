# Changelog

## 2.1.1
- The grey tag on a card from another computer is that computer's **label** (the **This computer's label** setting; default Win on Windows, Mac on macOS), not its operating system. With several computers of the same kind give each its own label; it doubles as the file name in the shared folder. The Details pane no longer repeats it as "on <name>".

## 2.1.0
- **See sessions from your other computers.** Each computer writes a snapshot of its sessions into a shared folder in a synced drive (default: iCloud Drive, `Claude Code/task-board-shared`) every 10 seconds and reads the others'. Cards from another computer carry a grey **Win** / **Mac** tag, show up in the Details pane with "on <computer>", and are read-only (no click-to-switch). Two new settings: **Shared folder for other computers** (empty = off) and **This computer's name in the shared folder** (empty = host name). Snapshots older than 10 minutes count as offline. Works with the matching plugin on the other computer: [Claude-WINdesktop-task-board](https://github.com/unopot/Claude-WINdesktop-task-board) / [Claude-MACdesktop-task-board](https://github.com/unopot/Claude-MACdesktop-task-board).
- The scanner takes `-Shared DIR` and `-Device NAME`; its output and the local snapshot carry `device` and `os`, plus `remote` (the other computers' snapshots, verbatim) when sharing is on. The board merges them (`mergeRemote` in `plan.ts`).
- The platform-specific bits of `register.tsx` (scanner command, home folder, snapshot path, how a `claude://` link is opened, default shared folder) now sit in one block at the top of the file; the rest of the file is identical in the Windows and macOS repositories.
- Fixed: the shared snapshot `~/.claude/task-board-snapshot.json` was only ever written once. `File.Replace` was called with `$null` as the backup path, which PowerShell passes as an empty string, so every later write failed silently and new sessions ignored the stale file. Now `[NullString]::Value`.
- From the macOS port: the switch is labelled **Next step**; in a narrow window the Running / Done header row truncates instead of wrapping (the switch, Details and the usage ring keep one line).

## 1.9.7
- With next-step suggestions showing (or "thinking…"), the collapse arrow sits at the right end of the suggestion header instead of its own row, so a tall board no longer pushes it out of view.

## 1.9.6
- The collapse arrow at the bottom right sits half a row lower, clear of the session cards.

## 1.9.5
- Faster start: the scanner's first pass is about twice as fast (ordinal string search, inlined timestamp parsing).
- New sessions show the board at once from a shared snapshot (`~/.claude/task-board-snapshot.json`, written at most every 10 s, used when under 10 minutes old, its timers moved forward to now) instead of waiting for their own first scan.

## 1.9.0 – 1.9.4
- Phone layout (Claude mobile app via Remote Control): one narrow column, buttons in place of click layers, folded by default.
- A collapse / expand arrow at the bottom right of the board on desktop and phone; the choice is remembered for new sessions.
- Next-step suggestions react to the first click: click layers are mounted while suggestions are still loading, and fire on pointer down.

## 1.8.4
- Author and marketplace owner: unopot; marketplace name `unopot-mods`.

## 1.8.3
- Details show who does the work: a **Main** row with the session's model and effort ("no subagents this turn" when there are none); each subagent sits under the step that started it. Running cards show "N agents" while subagents run.

## 1.8.2
- Tidier details panel: an equal-width stage strip, then one aligned step table; long lists fold finished stages.

## 1.8.1
- **needs input** (yellow) when a session waits on a permission dialog, a question or an MCP form; the guessed idle-tool-call **waiting** is light blue.

## 1.8.0
- Ring for the account's five-hour usage limit at the right of the Running header.

## 1.7.x
- Two columns (Running / Done), two-line cards with static percentage bars, details panel with stages, steps, timings and subagents, current-session highlight, hide finished sessions.
