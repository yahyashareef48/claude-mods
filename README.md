# claude-mods

Claude Code mods (function-hook plugins), tuned to look and work well in the **Claude desktop app** as well as the terminal.

| Mod | What it does | Based on |
| --- | --- | --- |
| [`replay-theater`](plugins/replay-theater) | A live timeline of everything Claude does in a turn — commands with their output, reads, searches and edits with diffs — as rounded chips in a pane, five at a time, with filters and a detail card. | [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground) (Apache-2.0) |
| [`filetree`](plugins/filetree) | An IDE-style file tree of the session folder with git status, line counts and highlights on files Claude reads or writes. `/filetree` opens in the desktop app too. | [data-goblin/claude-code-filetree](https://github.com/data-goblin/claude-code-filetree) (MIT) |

## Install

Needs Claude Code 2.1.287 or later.

```text
/plugin marketplace add yahyashareef48/claude-mods
/plugin install replay-theater@claude-mods
/plugin install filetree@claude-mods
```

Then run `/reload-plugins` (or start a new session).

- `/replay` opens Replay Theater, or press **Replay** in the bar above the prompt while Claude works to watch it live.
- `/filetree` opens the file tree.

## Developing

Each mod lives in `plugins/<name>/` with its own tests:

```bash
claude plugin validate plugins/replay-theater
claude plugin test plugins/replay-theater
```

> **Desktop app note.** If the desktop app bundles an older Claude Code than your terminal, it may run the copy made when the mod was installed (under `~/.claude/plugins/cache/claude-mods/<mod>/<version>/`) rather than this folder. After editing, bump the mod's `version` and reinstall, or copy the changed files into that folder, then `/reload-plugins`.

## License

Each mod keeps its upstream license: `plugins/replay-theater` is Apache-2.0 (see its `LICENSE` and the changes listed in its README), `plugins/filetree` is MIT (see its `LICENSE`).
