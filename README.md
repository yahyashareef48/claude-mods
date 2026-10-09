# claude-mods

Claude Code mods (function-hook plugins), tuned to look and work well in the **Claude desktop app** as well as the terminal.

| Mod | What it does | Based on |
| --- | --- | --- |
| [`replay-theater`](plugins/replay-theater) | A live timeline of everything Claude does in a turn — commands with their output, reads, searches and edits with diffs — as rounded chips in a pane, five at a time, with filters and a detail card. | [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground) (Apache-2.0) |
| [`repo-worktree`](plugins/repo-worktree) | A git dashboard for the repos you choose to watch: a card per repo with a row per worktree (branch, ↑ahead ↓behind, changed files, +/− lines), Pull / Push / Sync, the other local branches, fetched every minute. Double-click a repo to open it in VS Code. The list survives restarts. | — |

## Install

Needs Claude Code 2.1.287 or later.

```text
/plugin marketplace add yahyashareef48/claude-mods
/plugin install replay-theater@claude-mods
/plugin install repo-worktree@claude-mods
```

Then run `/reload-plugins` (or start a new session).

- `/replay` opens Replay Theater, or press **Replay** in the bar above the prompt while Claude works to watch it live.
- `/repos` opens Repo Worktree; `/watch` watches the current folder's repo, `/watch <path>` another. Sync pulls fast-forward only, then pushes; a diverged branch stops with a message instead of merging. Opening in VS Code needs the `code` command on your PATH.

## Developing

Each mod lives in `plugins/<name>/` with its own tests:

```bash
claude plugin validate plugins/replay-theater
claude plugin test plugins/replay-theater
```

> **Desktop app note.** If the desktop app bundles an older Claude Code than your terminal, it may run the copy made when the mod was installed (under `~/.claude/plugins/cache/claude-mods/<mod>/<version>/`) rather than this folder. After editing, bump the mod's `version` and reinstall, or copy the changed files into that folder, then `/reload-plugins`.

## License

`plugins/replay-theater` keeps its upstream Apache-2.0 license (see its `LICENSE` and the changes listed in its README). `plugins/repo-worktree` is original to this repo.
