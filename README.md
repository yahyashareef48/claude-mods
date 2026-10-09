# claude-mods

Claude Code mods (function-hook plugins), tuned to look and work well in the **Claude desktop app** as well as the terminal.

| Mod | What it does | Based on |
| --- | --- | --- |
| [`replay-theater`](plugins/replay-theater) | A live timeline of everything Claude does in a turn — commands with their output, reads, searches and edits with diffs — as rounded chips in a pane, five at a time, with filters and a detail card. | [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground) (Apache-2.0) |
| [`repo-worktree`](plugins/repo-worktree) | A compact git dashboard. Every repo in the chat's folder is watched on its own; every other repo on the computer is one pick away in the **Add repo** menu. One chip per repo, worktrees nested under it: a status dot, ↓behind ↑ahead, changed files, the branch as a pill, and the one action that fits (Pull, Push, Publish or Sync). Fetched every minute; double-click a repo to open it in VS Code. Everything survives restarts. | — |

## Install

Needs Claude Code 2.1.287 or later.

```text
/plugin marketplace add yahyashareef48/claude-mods
/plugin install replay-theater@claude-mods
/plugin install repo-worktree@claude-mods
```

Then run `/reload-plugins` (or start a new session).

- `/replay` opens Replay Theater, or press **Replay** in the bar above the prompt while Claude works to watch it live.
- `/repos` opens Repo Worktree. Repos in the chat's folder are added on their own (one you unwatch, with the ✕ that shows on hover, stays unwatched); the **Add repo** menu lists the rest of the repos on the computer — folders Claude Code has worked in, then a scan of your home folder and other drives (4 levels deep, skipping `node_modules`, `AppData` and the like), rescanned daily or from the menu. `/watch` re-adds the current folder's repos, `/watch <path>` adds another. Click a row's ● count to list its changed files. Sync fetches, pulls fast-forward only, then pushes; a diverged branch stops with a message instead of merging. Opening in VS Code needs the `code` command on your PATH.

## Developing

Each mod lives in `plugins/<name>/` with its own tests:

```bash
claude plugin validate plugins/replay-theater
claude plugin test plugins/replay-theater
```

> **Desktop app note.** If the desktop app bundles an older Claude Code than your terminal, it may run the copy made when the mod was installed (under `~/.claude/plugins/cache/claude-mods/<mod>/<version>/`) rather than this folder. After editing, bump the mod's `version` and reinstall, or copy the changed files into that folder, then `/reload-plugins`.

## License

`plugins/replay-theater` keeps its upstream Apache-2.0 license (see its `LICENSE` and the changes listed in its README). `plugins/repo-worktree` is original to this repo.
