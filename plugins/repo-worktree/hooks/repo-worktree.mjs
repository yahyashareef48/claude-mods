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
  lastPress: {}, flash: {}, isOpen: false, isLoaded: false, isRefreshing: false, refreshedAt: 0, addError: "",
  found: [], foundAt: 0, isScanning: false,
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
// own git. Long paths on: Git for Windows has them off, and a long branch
// name then fails a fetch with "Filename too long".
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.longpaths", GIT_CONFIG_VALUE_0: "true",
};

async function git($, cwd, args, timeoutMs = 30_000) {
  try {
    const r = await $.process.run(["git", ...args], { cwd, env: GIT_ENV, timeoutMs });
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
  const loaded = { ...wt, ...parseStatus(status.out), ...parseNumstat(numstat.out) };
  return loaded.branch ? loaded : { ...loaded, ...(await detachedFrom($, wt.path)) };
}

// A detached worktree checked out from a ref (`git checkout origin/main`):
// that ref, read from HEAD's reflog, and how far HEAD is behind or ahead of it.
async function detachedFrom($, path) {
  const log = await git($, path, ["reflog", "-1", "--format=%gs"]);
  const ref = log.out.trim().match(/ to (\S+)$/)?.[1];
  if (!ref || /^[0-9a-f]{7,40}$/i.test(ref)) return {};
  const ok = await git($, path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!ok.ok) return {};
  const [behind, ahead] = await Promise.all([
    git($, path, ["rev-list", "--count", `HEAD..${ref}`]),
    git($, path, ["rev-list", "--count", `${ref}..HEAD`]),
  ]);
  return { detachedFrom: ref, behind: Number(behind.out.trim()) || 0, ahead: Number(ahead.out.trim()) || 0 };
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
  if (r.ok) return "";
  // A remote branch whose name the file system can't hold (a `"` on
  // Windows) fails the prune alone: fetch again without it.
  if (/could not delete references/i.test(r.err)) {
    const plain = await git($, root, ["fetch", "--all", "--quiet"], 120_000);
    return plain.ok ? "" : plain.err.split(/\r?\n/).pop();
  }
  return r.err.split(/\r?\n/).pop();
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
  // A success note ("Pushed") lasts until the next refresh; an error stays.
  for (const [path, m] of Object.entries(state.messages)) if (!m.isError) delete state.messages[path];
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


async function openPane($, focus) {
  state.isOpen = true;
  await save($);
  // `focus` only when asked for: the host refuses `focus: false`.
  await $.ui.open({ id: PANE_ID, title: "Repos", ...(focus ? { focus: true } : {}), closeOnEscape: true, columns: 72, rows: 24 });
  $.ui.invalidate("ui.render");
}

// ── Actions ───────────────────────────────────────────────────────────────

// An error gets a line under its row, kept until the next action.
function say($, wtPath, text, isError = false) {
  state.messages[wtPath] = { text, isError };
  $.ui.invalidate("ui.render");
}

// Success is said on the button itself ("Synced ✓") for a moment, so nothing
// moves: no line comes and goes.
const FLASH_MS = 2200;
function flash($, wtPath, text) {
  state.flash[wtPath] = text;
  $.ui.invalidate("ui.render");
  try {
    $.clock.after(FLASH_MS, () => {
      if (state.flash[wtPath] !== text) return;
      delete state.flash[wtPath];
      $.ui.invalidate("ui.render");
    });
  } catch { /* cleared at the next refresh instead */ }
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
  if (!wt.branch && kind !== "advance") { say($, wt.path, "Detached HEAD: check out a branch first", true); return; }
  state.busy[wt.path] = kind;
  delete state.messages[wt.path];
  $.ui.invalidate("ui.render");
  try {
    let r;
    if (kind === "advance") {
      // A detached worktree moves to the latest of the ref it came from.
      await fetchRepo($, root);
      r = await git($, wt.path, ["checkout", "--detach", wt.detachedFrom], 60_000);
      if (r.ok) flash($, wt.path, "Pulled ✓"); else say($, wt.path, `Couldn't move: ${lastLine(r)}`, true);
    } else if (kind === "pull") {
      r = await git($, wt.path, ["pull", "--ff-only"], 120_000);
      if (r.ok) flash($, wt.path, "Pulled ✓"); else say($, wt.path, `Pull stopped: ${lastLine(r)}`, true);
    } else if (kind === "push") {
      r = await push($, wt);
      if (r.ok) flash($, wt.path, wt.upstream ? "Pushed ✓" : "Published ✓"); else say($, wt.path, `Push failed: ${lastLine(r)}`, true);
    } else {
      // Sync: fetch, fast-forward, then push. A diverged branch stops here
      // and says so instead of merging or rebasing on its own.
      await fetchRepo($, root);
      const fresh = await loadWorktree($, wt);
      if (fresh.upstream && fresh.behind > 0) {
        r = await git($, wt.path, ["pull", "--ff-only"], 120_000);
        if (!r.ok) {
          say($, wt.path, fresh.ahead > 0 ? `Diverged from ${fresh.upstream} (${fresh.ahead} ahead, ${fresh.behind} behind): rebase or merge first` : `Pull stopped: ${lastLine(r)}`, true);
          return;
        }
      }
      const now = await loadWorktree($, wt);
      if (!now.upstream || now.ahead > 0) {
        r = await push($, now);
        if (!r.ok) { say($, wt.path, `Push failed: ${lastLine(r)}`, true); return; }
      }
      flash($, wt.path, "Synced ✓");
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
// After a source list: one chip per repo with its worktrees nested under it,
// each row a status dot, a name, ahead/behind, the branch as a pill and the
// one action that fits. Details (changed files, errors) wait to be asked for.

const GREEN = "#34c759", AMBER = "#ff9f0a", RED = "#ff453a", GRAY = "#8e8e93";
const STATUS_ALT = { [GREEN]: "Up to date", [AMBER]: "Behind or changed", [RED]: "Error", [GRAY]: "On a bare commit" };
const CHIP_BORDER = "rgba(142, 142, 147, 0.28)";
const BLUE = "#58a6ff";
const FILE_COLOR = { M: "warning", A: "success", D: "error", R: "suggestion", C: "suggestion", U: "error", T: "warning", "?": "subtle" };

const timeOf = (ms) => (ms ? new Date(ms).toTimeString().slice(0, 5) : "");
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// The part of a git error worth reading: what follows its last colon.
const shortError = (s) => clip(String(s).trim().split(/:\s+/).filter(Boolean).pop() ?? String(s), 60);

function dot(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="${color}"/></svg>`;
}

const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

// A label's width at 11.5px in the UI font, by character class (an image
// can't measure text): narrow letters, wide ones, capitals, digits, the rest.
const PILL_FONT = 11.5;
function textWidth(s) {
  let em = 0;
  for (const c of s) {
    if ("iIlj.,:;'|!".includes(c)) em += 0.25;
    else if (" ·".includes(c)) em += 0.27;
    else if ("frt-/()[]".includes(c)) em += 0.36;
    else if ("mwMW".includes(c)) em += 0.84;
    else if (/[A-Z]/.test(c)) em += 0.62;
    else if (/[0-9]/.test(c)) em += 0.55;
    else if (c === "_") em += 0.48;
    else em += 0.52;
  }
  return em * PILL_FONT;
}

// The branch as a rounded pill with a branch mark, drawn as an image: a
// Box's background has square corners. The text is held to the measured
// width (`textLength`), so the pill fits it with even room at both ends.
function pill(label, color = BLUE) {
  const text = clip(label, 32);
  const tw = Math.ceil(textWidth(text));
  const w = 19 + tw + 8;
  const icon = `<g fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round"><circle cx="9" cy="5.5" r="1.4"/><circle cx="9" cy="12.5" r="1.4"/><circle cx="14" cy="7" r="1.4"/><path d="M9 6.9v4.2M14 8.4c0 2-2.5 2.2-4.6 3.3"/></g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="18" viewBox="0 0 ${w} 18"><rect x="0.5" y="0.5" width="${w - 1}" height="17" rx="8.5" fill="${color}" fill-opacity="0.13" stroke="${color}" stroke-opacity="0.45"/>${icon}<text x="19" y="12.6" textLength="${tw}" lengthAdjust="spacingAndGlyphs" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="${PILL_FONT}" fill="${color}">${escapeXml(text)}</text></svg>`;
  return { svg, width: w };
}

function pillFor(wt) {
  if (wt.branch) return { ...pill(wt.branch), alt: `Branch ${wt.branch}` };
  const label = wt.detachedFrom ? `${wt.detachedFrom} · detached` : `${String(wt.head ?? "").slice(0, 7)} · detached`;
  return { ...pill(label, wt.detachedFrom ? BLUE : GRAY), alt: `Detached at ${wt.detachedFrom ?? String(wt.head ?? "").slice(0, 7)}` };
}

function statusColor(repo, wt) {
  if (wt.error || (repo.fetchError && !wt.isChild)) return RED;
  if (!wt.branch && !wt.detachedFrom) return GRAY;
  if (wt.behind || wt.files?.length) return AMBER;
  return GREEN;
}

// The one button a row offers, as a source list does: Publish a branch with
// no upstream, Pull when behind, Push when ahead, Sync otherwise. A detached
// worktree that is clean and only behind its ref can move up to it.
function primaryAction(wt) {
  if (wt.error) return null;
  if (!wt.branch) {
    return wt.detachedFrom && wt.behind && !wt.ahead && !wt.files?.length ? { kind: "advance", label: "Pull" } : null;
  }
  if (!wt.upstream) return { kind: "push", label: "Publish" };
  if (wt.behind && !wt.ahead) return { kind: "pull", label: "Pull" };
  if (wt.ahead && !wt.behind) return { kind: "push", label: "Push" };
  return { kind: "sync", label: "Sync" };
}

const BUSY_LABEL = { pull: "Pulling…", push: "Pushing…", sync: "Syncing…", advance: "Pulling…" };

function worktreeRow(ui, $, repo, wt, isChild) {
  const { Box, Text, Button, Svg } = ui;
  const busy = state.busy[wt.path];
  const msg = state.messages[wt.path];
  const changes = wt.files?.length ?? 0;
  const isOpen = !!state.expanded[wt.path];
  const action = primaryAction(wt);
  // A worktree named after its repo (`WebApp-API-linkedin-spec-725`) drops the
  // repo's name: it already sits in that repo's card.
  const own = baseName(wt.path);
  const name = !isChild ? repo.name
    : own.toLowerCase().startsWith(`${repo.name.toLowerCase()}-`) ? own.slice(repo.name.length + 1) : own;
  const others = repo.worktrees.length - 1;
  const note = wt.error ? shortError(wt.error) : !isChild && repo.fetchError ? `Fetch failed: ${shortError(repo.fetchError)}` : "";

  const line = Box({ key: "line", flexDirection: "row", alignItems: "center", gap: 1, children: [
    // The dot needs an alt: the desktop draws no image without one.
    Svg({ key: "dot", source: dot(statusColor(repo, { ...wt, isChild })), alt: STATUS_ALT[statusColor(repo, { ...wt, isChild })], width: 8, height: 8 }),
    isChild
      ? Text({ key: "name", wrap: "truncate-end", children: name })
      : Button({ key: `open:${repo.root}`, label: name, plain: true, onPress: () => pressRepo($, repo.root) }),
    !isChild && others > 0 ? Text({ key: "count", dimColor: true, children: plural(others, "worktree") }) : null,
    Box({ key: "gap", flexGrow: 1 }),
    changes ? Button({ key: `files:${wt.path}`, label: `● ${changes}`, plain: true, dimColor: !isOpen,
      onPress: () => { state.expanded[wt.path] = !isOpen; $.ui.invalidate("ui.render"); } }) : null,
    wt.behind ? Text({ key: "behind", color: "warning", bold: true, children: `↓${wt.behind}` }) : null,
    wt.ahead ? Text({ key: "ahead", color: "suggestion", bold: true, children: `↑${wt.ahead}` }) : null,
    (() => { const p = pillFor(wt); return Svg({ key: "branch", source: p.svg, alt: p.alt, width: p.width, height: 18 }); })(),
    // The action button, which also says how its last press went ("Synced ✓")
    // for a moment, even where no action is left to offer.
    action || state.flash[wt.path]
      ? Button({
          key: `${action?.kind ?? "done"}:${wt.path}`,
          label: busy ? BUSY_LABEL[busy] : state.flash[wt.path] ?? action.label,
          variant: "secondary", dimColor: !!busy || !action,
          onPress: () => { if (action) act($, repo.root, wt, action.kind); },
        })
      : null,
    // Unwatch shows while the pointer is on the row (the keyed "line").
    !isChild ? Box({ display: "none", hover: { display: "flex" }, children: [
      Button({ key: `unwatch:${repo.root}`, label: "✕", plain: true, dimColor: true, onPress: () => removeRepo($, repo.root) }),
    ] }) : null,
  ].filter(Boolean) });

  // A worktree is a chip of its own inside its repo's card.
  const chip = isChild ? { borderStyle: "round", borderColor: CHIP_BORDER, paddingX: 1, marginLeft: 2 } : {};
  return Box({ key: `wt:${wt.path}`, flexDirection: "column", ...chip, children: [
    line,
    note ? Text({ key: "note", color: "error", dimColor: true, wrap: "truncate-end", children: `   ${note}` }) : null,
    msg ? Text({ key: "msg", color: msg.isError ? "error" : undefined, dimColor: !msg.isError, wrap: "truncate-end", children: `   ${msg.text}` }) : null,
    isOpen && changes ? Box({ key: "files", flexDirection: "column", paddingLeft: 3, children: wt.files.slice(0, MAX_FILES).map((f, n) =>
      Box({ key: `f${n}`, flexDirection: "row", gap: 1, children: [
        Text({ key: "code", color: FILE_COLOR[f.code] ?? "subtle", bold: true, children: f.code === "?" ? "U" : f.code }),
        Text({ key: "path", dimColor: true, wrap: "truncate-start", children: f.path }),
      ] })) }) : null,
  ].filter(Boolean) });
}

function repoCard(ui, $, root) {
  const { Box, Text } = ui;
  const repo = state.data[root];
  const children = repo
    ? [
        ...repo.worktrees.slice(0, 1).map((wt) => worktreeRow(ui, $, repo, wt, false)),
        ...repo.worktrees.slice(1).map((wt) => worktreeRow(ui, $, repo, wt, true)),
        repo.error && !repo.worktrees.length ? Text({ key: "error", color: "error", dimColor: true, children: `${baseName(root)}: ${shortError(repo.error)}` }) : null,
      ].filter(Boolean)
    : [Text({ key: "loading", dimColor: true, children: `${baseName(root)}  ·  loading…` })];
  const hasChips = (repo?.worktrees.length ?? 0) > 1;
  // Even room on every side, so a row's button never meets the border.
  return Box({ key: `repo:${root}`, flexDirection: "column", gap: hasChips ? 1 : 0, padding: 1, borderStyle: "round", borderColor: CHIP_BORDER, children });
}

// The unwatched repos on this computer, as one menu; picking one watches it.
function addMenu(ui, $) {
  const { Select } = ui;
  if (!Select) return null;
  const candidates = state.found.filter((f) => !isWatched(f.path));
  const parent = (p) => baseName(norm(p).slice(0, norm(p).lastIndexOf("/")));
  const options = [
    { value: "", label: state.isScanning ? "Looking for repos…" : candidates.length ? `Add repo (${candidates.length})` : "Add repo" },
    ...candidates.map((f) => ({ value: f.path, label: `${baseName(f.path)}  ·  ${parent(f.path)}` })),
    { value: "__rescan__", label: "Rescan this computer" },
  ];
  return Select({ key: "add", options, value: "", onSelect: (value) => {
    if (value === "__rescan__") return discover($, { force: true });
    if (value) return addRepo($, value);
  } });
}

function paneView($, e) {
  const ui = $.ui.resolve(e);
  const { Box, Text, Button } = ui;
  const behind = Object.values(state.data).reduce((n, r) => n + (r.worktrees ?? []).reduce((m, wt) => m + (wt.behind || 0), 0), 0);
  const sub = [
    plural(state.repos.length, "repo"),
    behind ? `${behind} behind` : "",
    state.isRefreshing ? "refreshing…" : timeOf(state.refreshedAt),
  ].filter(Boolean).join(" · ");

  const header = Box({ key: "header", flexDirection: "row", alignItems: "center", gap: 1, paddingX: 1, children: [
    Text({ key: "title", bold: true, children: "Repos" }),
    Text({ key: "sub", dimColor: true, children: sub }),
    Box({ key: "gap", flexGrow: 1 }),
    addMenu(ui, $),
    Button({ key: "refresh", label: "Refresh", variant: "secondary", dimColor: state.isRefreshing, onPress: () => refreshAll($) }),
  ].filter(Boolean) });

  return Box({ flexDirection: "column", gap: 1, padding: 1, children: [
    header,
    state.addError ? Text({ key: "add-error", color: "error", dimColor: true, children: `  ${state.addError}` }) : null,
    ...(state.repos.length
      ? state.repos.map((root) => repoCard(ui, $, root))
      : [Text({ key: "empty", dimColor: true, children: "  No repos yet. Add one from the menu." })]),
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
