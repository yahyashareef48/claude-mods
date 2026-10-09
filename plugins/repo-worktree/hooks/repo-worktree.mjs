// Repo Worktree: a git dashboard. The repos in the chat's folder are watched
// on their own; every other repo on this computer is listed to pick from.
// Each repo is a card with a row per worktree (its branch, ahead/behind its
// upstream, changed files) and Pull, Push and Sync; the other local branches
// sit below. Fetched and refreshed every minute. The watched list, what was
// unwatched, what was found and whether the pane was open are kept in the
// plugin's store, so they come back after a restart.
//
// Claude Code 2.1.287+ function hooks.

const PANE_ID = "repo-worktree";
const REFRESH_MS = 60_000;
const DOUBLE_PRESS_MS = 450;
const MAX_FILES = 50;
const STORE_REPOS = "repos";
const STORE_OPEN = "paneOpen";
const STORE_DISMISSED = "dismissed";
const STORE_FOUND = "discovered";
const RESCAN_MS = 24 * 60 * 60_000;
const SCAN_DEPTH = 4;
const SCAN_BUDGET = 3000;
const FOUND_SHOWN = 8;

// Folders a repo is never under, or too big to walk for nothing.
const SKIP_DIRS = new Set([
  "node_modules", "appdata", "library", "applications", "program files", "program files (x86)", "windows",
  "programdata", "$recycle.bin", "system volume information", "vendor", "dist", "build", "target", "out",
  "venv", "env", "__pycache__", "site-packages", "pictures", "music", "videos", "movies", "snap",
]);

// `repos` is the watched list (main worktree roots), in the order added;
// `dismissed` repos the person unwatched, never added again on their own;
// `data` what git last said about each; `found` the repos discovered on this
// computer; the rest is the pane's own.
const state = {
  repos: [], dismissed: [], data: {}, expanded: {}, messages: {}, busy: {},
  lastPress: {}, isOpen: false, isLoaded: false, isRefreshing: false, refreshedAt: 0, addError: "",
  found: [], foundAt: 0, isScanning: false, query: "", showAllFound: false,
};

// ── git ───────────────────────────────────────────────────────────────────

// Forward slashes, no trailing slash, but a drive's root keeps its own ("C:/":
// "C:" alone would be that drive's current folder).
const norm = (p) => {
  const s = String(p ?? "").trim().replace(/^"|"$/g, "").replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:$/.test(s) ? `${s}/` : s;
};
const join = (dir, name) => (dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`);
const baseName = (p) => norm(p).split("/").pop() || norm(p);
const isWindowsPath = (p) => /^[A-Za-z]:\//.test(norm(p));
const samePath = (a, b) => (isWindowsPath(a) ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b));

// Never asks for a password (a fetch with no credentials fails instead of
// hanging) and takes no optional locks, so a refresh never blocks the user's
// own git.
async function git($, cwd, args, timeoutMs = 30_000) {
  try {
    const r = await $.process.run(["git", ...args], { cwd, env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, timeoutMs });
    return { ok: r.exitCode === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
  } catch (error) {
    return { ok: false, out: "", err: String(error?.message ?? error) };
  }
}

// The main worktree's root for any folder inside a repo or one of its
// worktrees: the first entry `git worktree list` gives.
async function resolveRepo($, path) {
  const top = await git($, path, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { error: `Not a git repository: ${path}` };
  const list = await git($, norm(top.out), ["worktree", "list", "--porcelain"]);
  const first = list.ok ? parseWorktrees(list.out)[0] : undefined;
  return { root: norm(first?.path ?? top.out) };
}

function parseWorktrees(text) {
  return text.split(/\r?\n\r?\n/).map((block) => {
    const wt = {};
    for (const line of block.split(/\r?\n/)) {
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "worktree") wt.path = norm(value);
      else if (key === "branch") wt.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "detached") wt.detached = true;
      else if (key === "bare") wt.bare = true;
      else if (key === "prunable") wt.prunable = true;
      else if (key === "HEAD") wt.head = value;
    }
    return wt;
  }).filter((wt) => wt.path);
}

const STATUS_NAME = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflict", T: "type changed" };

// `git status --porcelain=v2 --branch`: the branch, its upstream, ahead and
// behind, and one entry per changed path.
function parseStatus(text) {
  const s = { upstream: "", ahead: 0, behind: 0, files: [] };
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) s.head = line.slice(14);
    else if (line.startsWith("# branch.upstream ")) s.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { s.ahead = Number(m[1]); s.behind = Number(m[2]); }
    } else if (line[0] === "1" || line[0] === "2") {
      const f = line.split(" ");
      const xy = f[1];
      const path = f.slice(line[0] === "1" ? 8 : 9).join(" ").split("\t")[0];
      const code = xy[0] !== "." ? xy[0] : xy[1];
      s.files.push({ code, path, staged: xy[0] !== "." });
    } else if (line[0] === "u") {
      s.files.push({ code: "U", path: line.split(" ").slice(10).join(" ") });
    } else if (line[0] === "?") {
      s.files.push({ code: "?", path: line.slice(2) });
    }
  }
  return s;
}

function parseNumstat(text) {
  let add = 0, del = 0;
  for (const line of text.split(/\r?\n/)) {
    const [a, d] = line.split("\t");
    if (/^\d+$/.test(a)) add += Number(a);
    if (/^\d+$/.test(d)) del += Number(d);
  }
  return { add, del };
}

// Local branches: their upstream and how far ahead or behind it they are.
function parseBranches(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, upstream, track] = line.split("\t");
    const ahead = Number(track?.match(/ahead (\d+)/)?.[1] ?? 0);
    const behind = Number(track?.match(/behind (\d+)/)?.[1] ?? 0);
    return { name, upstream: upstream || "", ahead, behind, gone: track === "gone" };
  });
}

async function loadWorktree($, wt) {
  const [status, numstat] = await Promise.all([
    git($, wt.path, ["status", "--porcelain=v2", "--branch"]),
    git($, wt.path, ["diff", "--numstat", "HEAD"]),
  ]);
  if (!status.ok) return { ...wt, error: status.err || "git status failed" };
  return { ...wt, ...parseStatus(status.out), ...parseNumstat(numstat.out) };
}

async function loadRepo($, root) {
  const list = await git($, root, ["worktree", "list", "--porcelain"]);
  if (!list.ok) return { root, name: baseName(root), error: list.err || "Not a git repository", worktrees: [], branches: [] };
  const wts = parseWorktrees(list.out).filter((wt) => !wt.bare && !wt.prunable);
  const [worktrees, refs] = await Promise.all([
    Promise.all(wts.map((wt) => loadWorktree($, wt))),
    git($, root, ["for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)", "refs/heads"]),
  ]);
  const checkedOut = new Set(worktrees.map((wt) => wt.branch).filter(Boolean));
  const branches = refs.ok ? parseBranches(refs.out).filter((b) => !checkedOut.has(b.name)) : [];
  return { root, name: baseName(root), worktrees, branches, loadedAt: Date.now() };
}

async function fetchRepo($, root) {
  const r = await git($, root, ["fetch", "--all", "--prune", "--quiet"], 120_000);
  return r.ok ? "" : r.err.split(/\r?\n/).pop();
}

// ── Finding repos ─────────────────────────────────────────────────────────

const pathKey = (p) => (isWindowsPath(p) ? norm(p).toLowerCase() : norm(p));
const isWatched = (root) => state.repos.some((r) => samePath(r, root));
const isDismissed = (root) => state.dismissed.some((r) => samePath(r, root));

// Folders holding a `.git`, breadth first from `bases`, `depth` levels down,
// at most `budget` folders listed. A repo is not walked into. `.git` is a
// folder in a repo's main checkout and a file in a worktree or submodule.
async function findRepos($, bases, { depth = SCAN_DEPTH, budget = SCAN_BUDGET } = {}) {
  const found = [];
  const queue = bases.map((p) => ({ path: norm(p), level: 0 }));
  const seen = new Set();
  let listed = 0;
  while (queue.length && listed < budget) {
    const { path, level } = queue.shift();
    if (seen.has(pathKey(path))) continue;
    seen.add(pathKey(path));
    let entries;
    try { entries = await $.fs.list(path); } catch { continue; }
    listed++;
    const dotGit = entries.find((en) => en.name === ".git");
    if (dotGit) { found.push({ path, mtimeMs: dotGit.mtimeMs || 0, isMain: dotGit.kind === "dir" }); continue; }
    if (level >= depth) continue;
    for (const en of entries) {
      const name = en.name.toLowerCase();
      if (en.kind !== "dir" || en.isLink || name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      queue.push({ path: join(path, en.name), level: level + 1 });
    }
  }
  return found;
}

async function homeDir($) {
  return norm((await $.env.get("USERPROFILE")) || (await $.env.get("HOME")) || "");
}

// Watches the repo `base` is in and every repo below it. On its own (the
// chat's folder at start) a repo the person unwatched stays unwatched; asked
// for (Watch this folder, /watch) it comes back.
async function watchFolder($, base, { isManual = false } = {}) {
  const roots = [];
  const here = await resolveRepo($, base);
  if (!here.error) roots.push(here.root);
  for (const hit of await findRepos($, [base], { budget: 1500 })) {
    const r = await resolveRepo($, hit.path);
    if (!r.error) roots.push(r.root);
  }
  const added = [];
  for (const root of roots) {
    if (isWatched(root) || added.some((a) => samePath(a, root))) continue;
    if (isDismissed(root) && !isManual) continue;
    if (isManual) state.dismissed = state.dismissed.filter((d) => !samePath(d, root));
    state.repos.push(root);
    added.push(root);
  }
  if (added.length) {
    await save($);
    $.ui.invalidate("ui.render");
    await Promise.all(added.map((root) => refreshRepo($, root)));
  }
  return { added, found: roots.length };
}

// Every repo on this computer worth offering: folders Claude Code has worked
// in (~/.claude.json) first, then a walk of the home folder and the other
// drives. Kept in the store and walked again once a day or on Rescan.
async function discover($, { force = false } = {}) {
  if (state.isScanning) return;
  if (!force && state.foundAt && Date.now() - state.foundAt < RESCAN_MS) return;
  state.isScanning = true;
  $.ui.invalidate("ui.render");
  try {
    const home = await homeDir($);
    const recent = [];
    try {
      const config = JSON.parse(await $.fs.read(join(home, ".claude.json")));
      for (const p of Object.keys(config.projects ?? {})) {
        try {
          const stat = await $.fs.stat(join(norm(p), ".git"));
          if (stat.kind === "dir") recent.push({ path: norm(p), mtimeMs: stat.mtimeMs || 0, isRecent: true });
        } catch { /* not a repo's root */ }
      }
    } catch { /* no config to read */ }
    const bases = home ? [home] : [];
    if (isWindowsPath(home)) {
      for (const d of "DEFGHIJ") {
        try { if (await $.fs.exists(`${d}:/`)) bases.push(`${d}:/`); } catch { /* no such drive */ }
      }
    }
    const scanned = (await findRepos($, bases)).filter((r) => r.isMain);
    const byKey = new Map();
    for (const r of [...recent, ...scanned]) if (!byKey.has(pathKey(r.path))) byKey.set(pathKey(r.path), r);
    state.found = [...byKey.values()]
      .sort((a, b) => Number(!!b.isRecent) - Number(!!a.isRecent) || b.mtimeMs - a.mtimeMs)
      .map(({ path, isRecent }) => ({ path, isRecent: !!isRecent }));
    state.foundAt = Date.now();
    try { await $.store.set(STORE_FOUND, { at: state.foundAt, repos: state.found }); } catch { /* best effort */ }
  } catch { /* nothing found this time: offered again on Rescan */ } finally {
    state.isScanning = false;
    $.ui.invalidate("ui.render");
  }
}

// ── Watching and refreshing ───────────────────────────────────────────────

async function save($) {
  try {
    await $.store.set(STORE_REPOS, state.repos);
    await $.store.set(STORE_DISMISSED, state.dismissed);
    await $.store.set(STORE_OPEN, state.isOpen);
  } catch { /* best effort */ }
}

async function refreshRepo($, root, { fetch = true } = {}) {
  const fetchError = fetch ? await fetchRepo($, root) : state.data[root]?.fetchError ?? "";
  state.data[root] = { ...(await loadRepo($, root)), fetchError };
  $.ui.invalidate("ui.render");
}

async function refreshAll($, { fetch = true } = {}) {
  if (state.isRefreshing) return;
  state.isRefreshing = true;
  $.ui.invalidate("ui.render");
  try { await Promise.all(state.repos.map((root) => refreshRepo($, root, { fetch }))); }
  finally {
    state.isRefreshing = false;
    state.refreshedAt = Date.now();
    $.ui.invalidate("ui.render");
  }
}

async function addRepo($, input) {
  const path = norm(input);
  state.addError = "";
  if (!path) return;
  const found = await resolveRepo($, path);
  if (found.error) { state.addError = found.error; $.ui.invalidate("ui.render"); return; }
  if (isWatched(found.root)) { state.addError = `Already watching ${baseName(found.root)}`; $.ui.invalidate("ui.render"); return; }
  state.dismissed = state.dismissed.filter((d) => !samePath(d, found.root));
  state.repos.push(found.root);
  await save($);
  $.ui.invalidate("ui.render");
  await refreshRepo($, found.root);
}

// Unwatching is remembered, so the chat's folder doesn't add it back.
async function removeRepo($, root) {
  state.repos = state.repos.filter((r) => r !== root);
  if (!isDismissed(root)) state.dismissed.push(root);
  delete state.data[root];
  await save($);
  $.ui.invalidate("ui.render");
}

const looksLikePath = (s) => /[\\/]/.test(s) || /^[A-Za-z]:/.test(s) || s.startsWith("~");

async function openPane($, focus) {
  state.isOpen = true;
  await save($);
  // `focus` only when asked for: the host refuses `focus: false`.
  await $.ui.open({ id: PANE_ID, title: "Repos", ...(focus ? { focus: true } : {}), closeOnEscape: true, columns: 72, rows: 24 });
  $.ui.invalidate("ui.render");
}

// ── Actions ───────────────────────────────────────────────────────────────

function say($, wtPath, text, isError = false) {
  state.messages[wtPath] = { text, isError };
  $.ui.invalidate("ui.render");
}

const lastLine = (r) => (r.err || r.out).trim().split(/\r?\n/).filter(Boolean).pop() ?? "";

async function push($, wt) {
  if (wt.upstream) return git($, wt.path, ["push"], 120_000);
  const remotes = await git($, wt.path, ["remote"]);
  const remote = remotes.out.split(/\r?\n/).filter(Boolean)[0];
  if (!remote) return { ok: false, err: "No remote to push to" };
  return git($, wt.path, ["push", "-u", remote, wt.branch], 120_000);
}

async function act($, root, wt, kind) {
  if (state.busy[wt.path]) return;
  if (!wt.branch) { say($, wt.path, "Detached HEAD: check out a branch first", true); return; }
  state.busy[wt.path] = kind;
  say($, wt.path, `${kind === "pull" ? "Pulling" : kind === "push" ? "Pushing" : "Syncing"}…`);
  try {
    let r;
    if (kind === "pull") {
      r = await git($, wt.path, ["pull", "--ff-only"], 120_000);
      say($, wt.path, r.ok ? "Pulled" : `Pull stopped: ${lastLine(r)}`, !r.ok);
    } else if (kind === "push") {
      r = await push($, wt);
      say($, wt.path, r.ok ? "Pushed" : `Push failed: ${lastLine(r)}`, !r.ok);
    } else {
      // Sync: fast-forward only, then push. A diverged branch stops here and
      // says so instead of merging or rebasing on its own.
      if (wt.upstream && wt.behind > 0) {
        r = await git($, wt.path, ["pull", "--ff-only"], 120_000);
        if (!r.ok) {
          say($, wt.path, wt.ahead > 0 ? `Diverged from ${wt.upstream} (${wt.ahead} ahead, ${wt.behind} behind): rebase or merge first` : `Pull stopped: ${lastLine(r)}`, true);
          return;
        }
      }
      const now = await loadWorktree($, wt);
      if (!now.upstream || now.ahead > 0) {
        r = await push($, now);
        if (!r.ok) { say($, wt.path, `Push failed: ${lastLine(r)}`, true); return; }
      }
      say($, wt.path, "In sync");
    }
  } finally {
    delete state.busy[wt.path];
    await refreshRepo($, root, { fetch: false });
  }
}

// One press arms, a second within DOUBLE_PRESS_MS opens the repo in VS Code.
async function pressRepo($, root) {
  const now = Date.now();
  const last = state.lastPress[root] ?? 0;
  state.lastPress[root] = now;
  if (now - last > DOUBLE_PRESS_MS) return;
  state.lastPress[root] = 0;
  const argv = isWindowsPath(root) ? ["cmd.exe", "/d", "/c", "code", root] : ["code", root];
  try {
    const r = await $.process.run(argv, { cwd: root, timeoutMs: 15_000 });
    if (r.exitCode !== 0) await $.ui.toast(`Couldn't open VS Code: ${(r.stderr || r.stdout).trim() || "is `code` on your PATH?"}`);
  } catch (error) {
    await $.ui.toast(`Couldn't open VS Code: ${error?.message ?? error}`);
  }
}

// ── View ──────────────────────────────────────────────────────────────────

const FILE_COLOR = { M: "warning", A: "success", D: "error", R: "suggestion", C: "suggestion", U: "error", T: "warning", "?": "subtle" };
const CHIP_BORDER = "rgba(142, 142, 147, 0.32)";

const timeOf = (ms) => (ms ? new Date(ms).toTimeString().slice(0, 5) : "");
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function worktreeLabel(root, wt) {
  if (samePath(wt.path, root)) return "main worktree";
  const rel = norm(wt.path).toLowerCase().startsWith(norm(root).toLowerCase() + "/") ? norm(wt.path).slice(norm(root).length + 1) : baseName(wt.path);
  return `worktree · ${rel}`;
}

function worktreeChip(ui, $, repo, wt) {
  const { Box, Text, Button } = ui;
  const busy = state.busy[wt.path];
  const msg = state.messages[wt.path];
  const isOpen = !!state.expanded[wt.path];
  const changes = wt.files?.length ?? 0;
  const tracking = [];
  if (wt.error) tracking.push(Text({ key: "err", color: "error", children: wt.error }));
  else {
    if (!wt.upstream && wt.branch) tracking.push(Text({ key: "noup", dimColor: true, children: "no upstream" }));
    if (wt.behind) tracking.push(Text({ key: "behind", color: "warning", bold: true, children: `↓${wt.behind} behind` }));
    if (wt.ahead) tracking.push(Text({ key: "ahead", color: "suggestion", children: `↑${wt.ahead} ahead` }));
    if (wt.upstream && !wt.ahead && !wt.behind) tracking.push(Text({ key: "even", dimColor: true, children: "up to date" }));
  }
  const summary = changes
    ? [Text({ key: "files", dimColor: true, children: plural(changes, "change") }), Text({ key: "add", color: "success", children: `+${wt.add ?? 0}` }), Text({ key: "del", color: "error", children: `−${wt.del ?? 0}` })]
    : [Text({ key: "clean", dimColor: true, children: "clean" })];
  const action = (kind, label, isUseful) => Button({
    key: `${kind}:${wt.path}`, label: busy === kind ? `${label}…` : label, variant: "secondary", dimColor: !isUseful || !!busy,
    onPress: () => act($, repo.root, wt, kind),
  });

  return Box({ key: `wt-${wt.path}`, flexDirection: "column", children: [
    Box({
      key: "chip", flexDirection: "row", alignItems: "center", gap: 1, paddingX: 1,
      borderStyle: "round", borderColor: wt.behind ? "warning" : CHIP_BORDER,
      children: [
        Box({ key: "name", flexDirection: "column", flexGrow: 1, flexShrink: 1, children: [
          Box({ key: "line1", flexDirection: "row", gap: 1, alignItems: "center", children: [
            Button({ key: `branch:${wt.path}`, label: `${isOpen ? "▾" : "▸"} ${wt.branch ?? (wt.detached ? `detached ${String(wt.head ?? "").slice(0, 7)}` : "?")}`, plain: true,
              onPress: () => { state.expanded[wt.path] = !isOpen; $.ui.invalidate("ui.render"); } }),
            ...tracking,
          ] }),
          Box({ key: "line2", flexDirection: "row", gap: 1, children: [
            Text({ key: "where", dimColor: true, wrap: "truncate-end", children: worktreeLabel(repo.root, wt) }),
            Text({ key: "dot", dimColor: true, children: "·" }),
            ...summary,
          ] }),
        ] }),
        Box({ key: "actions", flexDirection: "row", gap: 1, flexShrink: 0, children: [
          action("pull", "Pull", !!wt.behind),
          action("push", "Push", !!wt.ahead || (!wt.upstream && !!wt.branch)),
          action("sync", "Sync", !!wt.behind || !!wt.ahead || (!wt.upstream && !!wt.branch)),
        ] }),
      ],
    }),
    msg ? Text({ key: "msg", color: msg.isError ? "error" : undefined, dimColor: !msg.isError, children: `  ${msg.text}` }) : null,
    isOpen ? Box({ key: "files", flexDirection: "column", paddingX: 2, children: changes
      ? [
          ...wt.files.slice(0, MAX_FILES).map((f, n) => Box({ key: `f${n}`, flexDirection: "row", gap: 1, children: [
            Text({ key: "code", color: FILE_COLOR[f.code] ?? "subtle", bold: true, children: f.code === "?" ? "U" : f.code }),
            Text({ key: "path", wrap: "truncate-start", children: f.path }),
            Text({ key: "what", dimColor: true, children: f.code === "?" ? "untracked" : `${STATUS_NAME[f.code] ?? ""}${f.staged ? " · staged" : ""}` }),
          ] })),
          wt.files.length > MAX_FILES ? Text({ key: "more", dimColor: true, children: `… ${wt.files.length - MAX_FILES} more` }) : null,
        ].filter(Boolean)
      : [Text({ key: "none", dimColor: true, children: "No changes" })] }) : null,
  ].filter(Boolean) });
}

function repoCard(ui, $, root) {
  const { Box, Text, Button } = ui;
  const repo = state.data[root];
  const behind = repo?.worktrees?.reduce((n, wt) => n + (wt.behind || 0), 0) ?? 0;
  const head = Box({ key: "head", flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 1, children: [
    Box({ key: "title", flexDirection: "row", gap: 1, alignItems: "center", flexShrink: 1, children: [
      Button({ key: `open:${root}`, label: baseName(root), plain: true, onPress: () => pressRepo($, root) }),
      Text({ key: "path", dimColor: true, wrap: "truncate-start", children: root }),
    ] }),
    Box({ key: "tools", flexDirection: "row", gap: 1, flexShrink: 0, alignItems: "center", children: [
      behind ? Text({ key: "behind", color: "warning", children: `${behind} behind` }) : null,
      Button({ key: `unwatch:${root}`, label: "Unwatch", plain: true, dimColor: true, onPress: () => removeRepo($, root) }),
    ].filter(Boolean) }),
  ] });

  if (!repo) return Box({ key: `repo-${root}`, flexDirection: "column", gap: 1, padding: 1, borderStyle: "round", borderColor: "subtle", children: [
    head, Text({ key: "loading", dimColor: true, children: "Loading…" }),
  ] });

  const branches = repo.branches?.length
    ? Box({ key: "branches", flexDirection: "column", paddingX: 1, children: [
        Text({ key: "label", dimColor: true, bold: true, children: "Other branches" }),
        ...repo.branches.map((b) => Box({ key: `b-${b.name}`, flexDirection: "row", gap: 1, children: [
          Text({ key: "name", children: b.name }),
          b.gone ? Text({ key: "gone", color: "error", dimColor: true, children: "upstream gone" })
            : !b.upstream ? Text({ key: "local", dimColor: true, children: "local only" })
            : null,
          b.behind ? Text({ key: "behind", color: "warning", children: `↓${b.behind}` }) : null,
          b.ahead ? Text({ key: "ahead", color: "suggestion", children: `↑${b.ahead}` }) : null,
        ].filter(Boolean) })),
      ] })
    : null;

  return Box({ key: `repo-${root}`, flexDirection: "column", gap: 1, padding: 1, borderStyle: "round", borderColor: "subtle", children: [
    head,
    repo.error ? Text({ key: "error", color: "error", children: repo.error }) : null,
    repo.fetchError ? Text({ key: "fetch", color: "warning", dimColor: true, children: `Fetch failed: ${repo.fetchError}` }) : null,
    ...repo.worktrees.map((wt) => worktreeChip(ui, $, repo, wt)),
    branches,
  ].filter(Boolean) });
}

function paneView($, e) {
  const ui = $.ui.resolve(e);
  const { Box, Text, Button, Input, Markdown } = ui;
  const behind = Object.values(state.data).reduce((n, r) => n + (r.worktrees ?? []).reduce((m, wt) => m + (wt.behind || 0), 0), 0);
  const sub = [
    plural(state.repos.length, "repo"),
    behind ? `${behind} behind` : "",
    state.isRefreshing ? "refreshing…" : state.refreshedAt ? `fetched ${timeOf(state.refreshedAt)}` : "",
  ].filter(Boolean).join(" · ");

  const header = Box({ key: "header", flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", paddingX: 1, children: [
    Box({ key: "heading", flexDirection: "column", children: [
      Markdown ? Markdown({ key: "title", text: "### Repos" }) : Text({ key: "title", bold: true, children: "Repos" }),
      Text({ key: "sub", dimColor: true, children: sub }),
    ] }),
    Button({ key: "refresh", label: state.isRefreshing ? "Refreshing…" : "Refresh", variant: "secondary", dimColor: state.isRefreshing, onPress: () => refreshAll($) }),
  ] });

  const body = state.repos.length
    ? state.repos.map((root) => repoCard(ui, $, root))
    : [Text({ key: "empty", dimColor: true, children: "No repos in this folder. Pick some below, or paste a folder's path." })];

  return Box({ flexDirection: "column", gap: 1, padding: 1, children: [
    header, ...body,
    state.repos.length ? Text({ key: "tip", dimColor: true, children: "Double-click a repo's name to open it in VS Code. Click a branch to list its changes." }) : null,
    addSection(ui, $),
  ].filter(Boolean) });
}

// The repos on this computer not yet watched: searchable, a Watch button
// each. The field takes a pasted path too.
function addSection(ui, $) {
  const { Box, Text, Button, Input } = ui;
  const q = state.query.trim().toLowerCase();
  const candidates = state.found.filter((f) => !isWatched(f.path));
  const matches = q && !looksLikePath(q)
    ? candidates.filter((f) => baseName(f.path).toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
    : candidates;
  const shown = state.showAllFound || q ? matches.slice(0, 100) : matches.slice(0, FOUND_SHOWN);
  const status = state.isScanning
    ? "Looking for repos on this computer…"
    : state.foundAt ? `${plural(candidates.length, "more repo")} on this computer` : "";

  const rows = shown.map((f) => Box({
    key: `found:${f.path}`, flexDirection: "row", alignItems: "center", gap: 1, paddingX: 1,
    borderStyle: "round", borderColor: CHIP_BORDER,
    children: [
      Box({ key: "names", flexDirection: "row", gap: 1, flexGrow: 1, flexShrink: 1, alignItems: "center", children: [
        Text({ key: "name", bold: true, children: baseName(f.path) }),
        f.isRecent ? Text({ key: "recent", color: "suggestion", dimColor: true, children: "used with Claude" }) : null,
        Text({ key: "path", dimColor: true, wrap: "truncate-start", children: f.path }),
      ].filter(Boolean) }),
      Button({ key: `watch:${f.path}`, label: "Watch", variant: "secondary", onPress: () => addRepo($, f.path) }),
    ],
  }));

  return Box({ key: "add", flexDirection: "column", gap: 1, children: [
    Box({ key: "add-head", flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingX: 1, children: [
      Box({ key: "add-title", flexDirection: "column", children: [
        Text({ key: "label", bold: true, children: "Add more" }),
        status ? Text({ key: "status", dimColor: true, children: status }) : null,
      ].filter(Boolean) }),
      Box({ key: "add-tools", flexDirection: "row", gap: 1, children: [
        Button({ key: "add-here", label: "Watch repos in this folder", variant: "secondary", onPress: async () => {
          const { added, found } = await watchFolder($, await $.session.cwd(), { isManual: true });
          state.addError = found ? (added.length ? "" : "Every repo in this folder is already watched") : "No repos in this folder";
          $.ui.invalidate("ui.render");
        } }),
        Button({ key: "rescan", label: state.isScanning ? "Scanning…" : "Rescan", variant: "secondary", dimColor: state.isScanning, onPress: () => discover($, { force: true }) }),
      ] }),
    ] }),
    Input
      ? Box({ key: "field", paddingX: 1, children: [Input({
          key: "search", placeholder: "Search repos, or paste a folder's path", submitLabel: "Watch",
          onInput: (value) => { state.query = value; state.addError = ""; $.ui.invalidate("ui.render"); },
          onSubmit: (value) => {
            const v = value.trim();
            if (looksLikePath(v)) return addRepo($, v);
            if (matches[0]) return addRepo($, matches[0].path);
          },
        })] })
      : Text({ key: "hint", dimColor: true, children: "/watch <path> adds a repo" }),
    state.addError ? Text({ key: "add-error", color: "error", children: `  ${state.addError}` }) : null,
    ...rows,
    !q && matches.length > FOUND_SHOWN
      ? Button({ key: "show-all", label: state.showAllFound ? "Show fewer" : `Show all ${matches.length}`, plain: true, dimColor: true,
          onPress: () => { state.showAllFound = !state.showAllFound; $.ui.invalidate("ui.render"); } })
      : null,
    q && !looksLikePath(q) && !matches.length ? Text({ key: "none", dimColor: true, children: "  No repo by that name. Paste its folder's path instead." }) : null,
  ].filter(Boolean) });
}

// ── Hooks ─────────────────────────────────────────────────────────────────

let stopTimer;

export function register(on) {
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    await $.command.register({ name: "repos", description: "Repo Worktree: show the repos you watch" });
    await $.command.register({ name: "watch", description: "Repo Worktree: watch a repo (this folder, or a path)", argumentHint: "[path]" });
    try {
      const saved = await $.store.get(STORE_REPOS);
      state.repos = Array.isArray(saved) ? saved.map(norm) : [];
      const dismissed = await $.store.get(STORE_DISMISSED);
      state.dismissed = Array.isArray(dismissed) ? dismissed.map(norm) : [];
      state.isOpen = (await $.store.get(STORE_OPEN)) === true;
      const found = await $.store.get(STORE_FOUND);
      if (found && Array.isArray(found.repos)) { state.found = found.repos; state.foundAt = Number(found.at) || 0; }
    } catch { /* start empty */ }
    state.isLoaded = true;
    if (state.isOpen) { try { await openPane($, false); } catch { /* no room yet */ } }
    // The chat's folder first: its repos are watched on their own. Then the
    // rest refresh, and the computer is searched for more when it's due.
    void (async () => {
      try { await watchFolder($, e.cwd); } catch { /* a folder we can't read */ }
      try { await refreshAll($); } catch { /* shown per repo */ }
      try { await discover($); } catch { /* offered again on Rescan */ }
    })();
    stopTimer?.();
    const timer = $.clock.every(REFRESH_MS, () => { void refreshAll($); });
    stopTimer = () => timer.cancel();
    return r;
  });

  on("command.run", { command: "repos" }, async ($) => {
    await openPane($, true);
    void refreshAll($);
    void discover($);
    return { text: `Repos: ${plural(state.repos.length, "repo")} watched` };
  });

  // `/watch` alone: every repo in the chat's folder; `/watch <path>`: that one.
  on("command.run", { command: "watch" }, async ($, e) => {
    const arg = e.args?.trim();
    if (arg) {
      await addRepo($, arg);
      if (state.addError) return { text: `Repos: ${state.addError}` };
      await openPane($, true);
      return { text: `Repos: watching ${baseName(state.repos[state.repos.length - 1])}` };
    }
    const { added, found } = await watchFolder($, await $.session.cwd(), { isManual: true });
    await openPane($, true);
    if (!found) return { text: "Repos: no repos in this folder" };
    return { text: added.length ? `Repos: watching ${added.map(baseName).join(", ")}` : "Repos: every repo in this folder is already watched" };
  });

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e);
    return paneView($, e);
  });

  // The person closed the pane: remember it closed for next time.
  on("ui.close", async ($, e, next) => {
    if (e.id === PANE_ID || e.requestId === PANE_ID) { state.isOpen = false; await save($); }
    return next(e);
  });
}
