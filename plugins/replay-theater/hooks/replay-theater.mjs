// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Replay Theater: records every tool call Claude makes in a turn (edits,
// commands, reads, searches) and lets you step through them in a pane.
//
// Claude Code 2.1.280 function hooks. Load with --plugin-dir.

const PANE_ID = "replay-theater";
const MAX_DIFF_LINES = 12;
const MAX_LCS_LINES = 400;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Module state. `pending` fills during a turn; `replay` is the last finished
// turn's steps, the ones the pane shows.
// `isLive` while the turn that fills `replay` is still running; `offset` is
// the list window's first row; `follow` keeps the newest step selected.
const LIST_WINDOW = 5;
const state = {
  pending: [], replay: [], index: 0, filter: "all", expanded: false,
  isLive: false, offset: 0, follow: false, listRows: { top: 0, bottom: 0 },
  isOpen: false, inBand: false, turns: 0, turnStartedAt: 0, turnMs: 0,
};

// ── Recording ─────────────────────────────────────────────────────────────

// Paths are shown with forward slashes, relative to the session's folder.
// Windows paths compare case-insensitively.
function relPath(cwd, path) {
  if (!path) return "(unknown file)";
  const p = String(path).replace(/\\/g, "/");
  const c = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (c && p.toLowerCase().startsWith(c.toLowerCase() + "/")) return p.slice(c.length + 1);
  return p;
}

function splitLines(text) {
  if (text === undefined || text === null || text === "") return [];
  const lines = String(text).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// A line diff. Small inputs get an LCS diff, so unchanged lines show as
// context; large ones fall back to all-removed then all-added.
function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [...a.map((t) => ({ op: "-", t })), ...b.map((t) => ({ op: "+", t }))];
  }
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: " ", t: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", t: a[i++] });
    else out.push({ op: "+", t: b[j++] });
  }
  while (i < n) out.push({ op: "-", t: a[i++] });
  while (j < m) out.push({ op: "+", t: b[j++] });
  return trimContext(out);
}

// Keep one line of context around each change, so a long file's Write shows
// the changed lines, not the whole file. A skipped run becomes one "~" line
// that remembers how many lines it stands for, so line numbers stay true.
function trimContext(lines) {
  if (!lines.some((l) => l.op !== " ")) return lines.slice(0, MAX_DIFF_LINES);
  const isChange = (l) => l && l.op !== " ";
  const out = [];
  let skipped = 0;
  lines.forEach((l, k) => {
    if (isChange(l) || isChange(lines[k - 1]) || isChange(lines[k + 1])) {
      if (skipped) out.push({ op: "~", t: "⋯", n: skipped });
      out.push(l);
      skipped = 0;
    } else skipped++;
  });
  return out;
}

function countChanges(diff) {
  let add = 0, del = 0;
  for (const l of diff || []) { if (l.op === "+") add++; else if (l.op === "-") del++; }
  return { add, del };
}

function lineOf(text, needle) {
  const at = needle ? String(text).indexOf(needle) : -1;
  return at < 0 ? 1 : String(text).slice(0, at).split("\n").length;
}

const firstLine = (s) => String(s ?? "").split("\n").find((l) => l.trim()) ?? "";
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// What every tool call is called and how it reads in the list. Edits get a
// diff; everything else keeps its input summary and its output.
function describe(cwd, e) {
  const t = e.tool;
  const file = e.file_path || e.notebook_path ? relPath(cwd, e.file_path || e.notebook_path) : undefined;
  switch (t) {
    case "Bash": return { kind: "command", title: e.description || clip(firstLine(e.command), 80), detail: e.command };
    case "PowerShell": return { kind: "command", title: e.description || clip(firstLine(e.command), 80), detail: e.command, language: "powershell" };
    case "Read": return { kind: "read", file, title: file };
    case "Grep": return { kind: "search", title: e.pattern, detail: `Grep${e.path ? " in " + relPath(cwd, e.path) : ""}${e.glob ? " · " + e.glob : ""}` };
    case "Glob": return { kind: "search", title: e.pattern, detail: `Glob${e.path ? " in " + relPath(cwd, e.path) : ""}` };
    case "WebSearch": return { kind: "web", title: e.query, detail: "Web search" };
    case "WebFetch": return { kind: "web", title: e.url, detail: "Fetch" };
    case "Agent": case "Task": return { kind: "agent", title: e.description || "Subagent", detail: e.subagent_type ? `Agent · ${e.subagent_type}` : "Agent" };
    default: {
      if (EDIT_TOOLS.has(t)) return { kind: "edit", file, title: file };
      const { tool, tool_use_id, ...input } = e;
      return { kind: "other", title: t.replace(/^mcp__[^_]+__/, ""), detail: clip(JSON.stringify(input), 120), input };
    }
  }
}

// Edit steps, built before the call runs: a Write's "before" is the file as
// it was. MultiEdit gives one step per edit.
async function editSteps($, e, file) {
  if (e.tool === "Edit") {
    return [{ diff: diffLines(e.old_string, e.new_string), note: e.replace_all ? "replace all" : "", find: e.new_string }];
  }
  if (e.tool === "MultiEdit" && Array.isArray(e.edits)) {
    return e.edits.map((ed, k) => ({ diff: diffLines(ed.old_string, ed.new_string), note: `part ${k + 1} of ${e.edits.length}`, find: ed.new_string }));
  }
  if (e.tool === "Write") {
    let before = "", isNew = true;
    try {
      if (e.file_path && (await $.fs.exists(e.file_path))) { before = await $.fs.read(e.file_path); isNew = false; }
    } catch { /* unreadable: show it as a new file */ }
    return [{ diff: diffLines(before, e.content), note: isNew ? "new file" : "rewrite", startLine: 1 }];
  }
  return [{ diff: [], note: "" }];
}

function outputOf(r) {
  if (!r) return "";
  if (r.deny) return r.deny;
  const res = r.result;
  if (res && typeof res === "object" && "stdout" in res) return [res.stdout, res.stderr].filter(Boolean).join("\n");
  return typeof r.text === "string" ? r.text : typeof res === "string" ? res : "";
}

async function record($, e, next) {
  let cwd = "";
  try { cwd = await $.session.cwd(); } catch { /* keep the full path */ }
  const base = describe(cwd, e);
  let parts = [{}];
  if (base.kind === "edit") { try { parts = await editSteps($, e, base.file); } catch { parts = [{ diff: [] }]; } }
  const startedAt = Date.now();

  // Live: the steps go in as the call starts, marked running, and the pane
  // shows this turn from its first call on.
  const steps = parts.map(({ find, ...part }) => ({ tool: e.tool, ...base, ...part, isRunning: true, startedAt }));
  try {
    if (!state.isLive) { state.replay = state.pending; state.isLive = true; state.index = 0; state.offset = 0; state.filter = "all"; state.follow = true; }
    state.pending.push(...steps);
    if (state.follow) followLatest();
    $.ui.invalidate("ui.render");
  } catch { /* recording must never break the call */ }

  let r;
  try { r = await next(e); }
  finally {
    try {
      const ms = Date.now() - startedAt;
      const isError = !r || !!(r.deny || r.isError);
      const output = outputOf(r);
      const extra = {};
      if (base.kind === "read" && r?.result?.file) {
        extra.content = r.result.file.content;
        extra.startLine = r.result.file.startLine;
        extra.numLines = r.result.file.numLines;
      }
      if (base.kind === "search" && r?.result) extra.count = r.result.numFiles ?? r.result.numMatches;
      // An edit's line numbers: where its new text landed in the file.
      if (base.kind === "edit" && !isError && e.file_path) {
        let after = "";
        try { after = await $.fs.read(e.file_path); } catch { /* numbers from 1 */ }
        parts.forEach((p, k) => { if (steps[k].startLine === undefined) steps[k].startLine = after ? lineOf(after, p.find) : 1; });
      }
      for (const s of steps) Object.assign(s, extra, { isError, output, ms, isRunning: false });
      $.ui.invalidate("ui.render");
    } catch { /* recording must never break the call */ }
  }
  return r;
}

// While nobody has picked a step, the selection rides the newest one.
function followLatest() {
  state.index = Math.max(0, state.replay.length - 1);
  state.offset = Math.max(0, visibleSteps().length - LIST_WINDOW);
}

// ── Shared helpers ────────────────────────────────────────────────────────

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const baseName = (p) => String(p).split("/").pop();
const dirName = (p) => (String(p).includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function duration(ms) {
  if (!ms && ms !== 0) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}

const FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "edit", label: "Edits", test: (s) => s.kind === "edit" },
  { id: "command", label: "Commands", test: (s) => s.kind === "command" },
  { id: "read", label: "Reads", test: (s) => s.kind === "read" },
  { id: "search", label: "Searches", test: (s) => s.kind === "search" || s.kind === "web" },
];

function visibleSteps() {
  const f = FILTERS.find((x) => x.id === state.filter) ?? FILTERS[0];
  return state.replay.map((s, i) => ({ s, i })).filter(({ s }) => f.test(s));
}

function summaryText() {
  const by = (k) => state.replay.filter((s) => s.kind === k).length;
  const parts = [plural(state.replay.length, "step")];
  if (by("edit")) parts.push(plural(by("edit"), "edit"));
  if (by("command")) parts.push(plural(by("command"), "command"));
  if (by("read")) parts.push(plural(by("read"), "read"));
  return parts.join(" · ");
}

async function openReplay($) {
  if (!state.replay.length) return false;
  state.filter = "all";
  state.expanded = false;
  state.follow = state.isLive;
  if (state.isLive) followLatest(); else { state.index = 0; state.offset = 0; }
  state.isOpen = true;
  // The pane only takes the keyboard while nothing else holds it. Hide the
  // band first (it held the keys if its button was pressed), then open.
  $.ui.invalidate("ui.render");
  await $.clock.sleep(200);
  const rows = Math.min(MAX_DIFF_LINES + 8, 22);
  const placed = await $.ui.open({ id: PANE_ID, title: "Replay", focus: true, closeOnEscape: true, rows, columns: 58 });
  // No room for a pane (a narrow terminal): draw the replay in the band.
  state.inBand = placed?.isPlaced === false;
  $.ui.invalidate("ui.render");
  return true;
}

const EXT_LANG = { js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "tsx", jsx: "jsx", py: "python", md: "markdown", json: "json", css: "css", html: "html", sh: "bash", go: "go", rs: "rust", ps1: "powershell" };

// The step's diff as unified-diff hunks, so the desktop's diff viewer colors
// and numbers it. A skipped run ("~") starts a new hunk past its lines.
function unifiedDiff(diff, start = 1) {
  const hunks = [];
  let cur = null, oldAt = start, newAt = start;
  for (const l of diff) {
    if (l.op === "~") { cur = null; oldAt += l.n || 0; newAt += l.n || 0; continue; }
    if (!cur) { cur = { oldStart: oldAt, newStart: newAt, oldLen: 0, newLen: 0, lines: [] }; hunks.push(cur); }
    cur.lines.push(`${l.op}${l.t}`);
    if (l.op !== "+") { cur.oldLen++; oldAt++; }
    if (l.op !== "-") { cur.newLen++; newAt++; }
  }
  return hunks
    .map((h) => [`@@ -${h.oldLen ? h.oldStart : h.oldStart - 1},${h.oldLen} +${h.newLen ? h.newStart : h.newStart - 1},${h.newLen} @@`, ...h.lines].join("\n"))
    .join("\n");
}

// ── Desktop view ──────────────────────────────────────────────────────────
// After Apple's source lists: a symbol, a primary and a secondary label per
// row, one tinted selection, the accent kept for what is current. Text is
// native and themed; SVG only draws small marks in grays that read on light
// and dark alike.

const DESKTOP_MAX_DIFF = 60;
const DESKTOP_MAX_OUTPUT = 40;
const ACCENT = "claude";
const ACCENT_HEX = "#d97757";
const GRAY = "#8e8e93";
const GREEN = "#34c759", RED = "#ff453a", TRACK = "rgba(142, 142, 147, 0.35)";
const SELECTED_BG = "rgba(142, 142, 147, 0.18)";
const HOVER_BG = "rgba(142, 142, 147, 0.09)";

// SF Symbols–style glyphs on a 16-unit grid, stroked so they sit with text.
const GLYPHS = {
  edit: `<path d="M10.5 2.5l3 3L6 13H3v-3z"/><path d="M9 4l3 3"/>`,
  create: `<path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z"/><path d="M9.5 1.5V5H13"/><path d="M8 7.5v4M6 9.5h4"/>`,
  command: `<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6l2 2-2 2M8 10.5h3.5"/>`,
  read: `<path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z"/><path d="M9.5 1.5V5H13M5.5 8h5M5.5 10.5h5"/>`,
  search: `<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>`,
  web: `<circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c2 2 2.8 4.2 2.8 6.5S10 12.5 8 14.5C6 12.5 5.2 10.3 5.2 8S6 3.5 8 1.5z"/>`,
  agent: `<path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z"/>`,
  other: `<circle cx="8" cy="8" r="6.5"/><circle cx="5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="11" cy="8" r=".6"/>`,
  play: `<circle cx="8" cy="8" r="6.5"/><path d="M6.6 5.4v5.2L10.8 8z" fill="currentColor"/>`,
};

function glyphOf(step) {
  if (step.kind === "edit") return step.note === "new file" ? "create" : "edit";
  return GLYPHS[step.kind] ? step.kind : "other";
}

function symbol(name, color, size = 16, opacity = 1) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" color="${color}" opacity="${opacity}">${GLYPHS[name]}</svg>`;
}

// A ring with a turning arc. Drawn as a plain image: its SMIL animation runs
// there too, and an interactive frame would paint an opaque background.
function spinner(size = 14) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="rgba(142, 142, 147, 0.3)" stroke-width="2"/><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="${ACCENT_HEX}" stroke-width="2" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite"/></path></svg>`;
}

// The chip at a window's edge fades toward what is
// scrolled out of sight: its border, its marks and its labels.
const CHIP_BORDER = ["rgba(142, 142, 147, 0.32)", "rgba(142, 142, 147, 0.18)", "rgba(142, 142, 147, 0.08)"];
const MARK_OPACITY = [1, 0.55, 0.25];

function statusDot(isError) {
  const c = isError ? RED : GREEN;
  const mark = isError ? `<path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>` : `<path d="M5 8.2l2 2 4-4.4"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${c}" opacity=".18"/><g fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${mark}</g></svg>`;
}

// GitHub's diffstat: five cells split between added and removed lines.
function diffstat(add, del, cell = 7) {
  const total = add + del;
  let green = total ? Math.round((5 * add) / total) : 0;
  let red = total ? 5 - green : 0;
  if (add && !green) { green = 1; red--; }
  if (del && !red) { red = 1; green--; }
  const gap = 2, w = cell * 5 + gap * 4;
  const cells = Array.from({ length: 5 }, (_, i) => {
    const fill = i < green ? GREEN : i < green + red ? RED : TRACK;
    return `<rect x="${i * (cell + gap)}" y="0" width="${cell}" height="${cell}" rx="1.5" fill="${fill}"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${cell}" viewBox="0 0 ${w} ${cell}">${cells}</svg>`;
}

// What the row says on its right: a diffstat, a status, a count.
function trailing(ui, s, n, isCurrent) {
  const { Text, Svg, Box } = ui;
  const items = [];
  if (s.isRunning) {
    items.push(Text({ key: `run${n}`, dimColor: true, children: "Running" }));
    items.push(Svg({ key: `spin${n}`, source: spinner(), alt: "Running", width: 14, height: 14 }));
  } else if (s.kind === "edit" && !s.isError) {
    const c = countChanges(s.diff);
    items.push(Text({ key: `add${n}`, color: "success", dimColor: !isCurrent, children: `+${c.add}` }));
    items.push(Text({ key: `del${n}`, color: "error", dimColor: !isCurrent, children: `−${c.del}` }));
    items.push(Svg({ key: `stat${n}`, source: diffstat(c.add, c.del), alt: `${c.add} added, ${c.del} removed`, width: 43, height: 7 }));
  } else {
    const note = s.kind === "read" && s.numLines ? plural(s.numLines, "line")
      : s.kind === "search" && s.count !== undefined ? plural(s.count, "result")
      : s.ms >= 1000 ? duration(s.ms) : "";
    if (note) items.push(Text({ key: `note${n}`, dimColor: true, children: note }));
    if (s.kind === "command" || s.isError) items.push(Svg({ key: `ok${n}`, source: statusDot(s.isError), alt: s.isError ? "Failed" : "Succeeded", width: 14, height: 14 }));
  }
  return Box({ key: `trail${n}`, flexDirection: "row", alignItems: "center", gap: 1, flexShrink: 0, children: items });
}

function secondaryOf(s) {
  if (s.kind === "edit" || s.kind === "read") return dirName(s.file);
  if (s.kind === "command") return s.title === s.detail ? "" : clip(firstLine(s.detail), 90);
  return s.detail || "";
}

function bodyOf(ui, $, step) {
  const { Box, Text, Button, Code } = ui;
  const more = (total) => Button({
    key: "more", label: `Show all ${total} lines`, plain: true, dimColor: true,
    onPress: () => { state.expanded = true; $.ui.invalidate("ui.render"); },
  });
  const section = (key, label, children) => Box({ key, flexDirection: "column", gap: 0, children: [
    Text({ key: `${key}-label`, dimColor: true, bold: true, children: label }), ...children,
  ] });
  const textBlock = (key, text, language) => {
    const lines = splitLines(text);
    const isClipped = !state.expanded && lines.length > DESKTOP_MAX_OUTPUT;
    const shown = (isClipped ? lines.slice(0, DESKTOP_MAX_OUTPUT) : lines).join("\n").slice(0, 60000);
    return [
      shown ? Code({ key, source: shown, language, wrap: "wrap" }) : Text({ key, dimColor: true, italic: true, children: "No output" }),
      isClipped ? more(lines.length) : null,
    ].filter(Boolean);
  };

  if (step.isRunning) {
    return [
      step.kind === "command" ? Code({ key: "cmd", source: step.detail, language: step.language || "bash", wrap: "wrap" }) : null,
      Text({ key: "running", dimColor: true, italic: true, children: "Running…" }),
    ].filter(Boolean);
  }
  if (step.kind === "edit") {
    if (step.isError) return [section("why", "Didn't apply", textBlock("err", step.output))];
    if (!step.diff.length) return [Text({ key: "empty", dimColor: true, children: "No line changes." })];
    const isClipped = !state.expanded && step.diff.length > DESKTOP_MAX_DIFF;
    const ext = baseName(step.file).split(".").pop().toLowerCase();
    return [
      Code({ key: "diff", source: unifiedDiff(isClipped ? step.diff.slice(0, DESKTOP_MAX_DIFF) : step.diff, step.startLine), format: "diff", language: EXT_LANG[ext], path: step.file, wrap: "wrap" }),
      isClipped ? more(step.diff.length) : null,
    ].filter(Boolean);
  }
  if (step.kind === "command") {
    return [
      Code({ key: "cmd", source: step.detail, language: step.language || "bash", wrap: "wrap" }),
      section("out", step.isError ? "Output · failed" : "Output", textBlock("output", step.output)),
    ];
  }
  if (step.kind === "read" && step.content !== undefined) {
    const lines = splitLines(step.content);
    const isClipped = !state.expanded && lines.length > DESKTOP_MAX_OUTPUT;
    const ext = baseName(step.file).split(".").pop().toLowerCase();
    return [
      Code({ key: "content", source: (isClipped ? lines.slice(0, DESKTOP_MAX_OUTPUT) : lines).join("\n") || " ", language: EXT_LANG[ext], path: step.file, startLine: step.startLine || 1, wrap: "wrap" }),
      isClipped ? more(lines.length) : null,
    ].filter(Boolean);
  }
  if (step.kind === "other" && step.input) {
    return [
      section("in", "Input", [Code({ key: "input", source: JSON.stringify(step.input, null, 2).slice(0, 20000), language: "json", wrap: "wrap" })]),
      section("out", step.isError ? "Result · failed" : "Result", textBlock("output", step.output)),
    ];
  }
  return [section("out", step.isError ? "Result · failed" : "Result", textBlock("output", step.output))];
}

function kindLabel(s) {
  if (s.kind === "edit") return s.note === "new file" ? "New file" : s.note === "rewrite" ? "Rewrite" : s.note === "replace all" ? "Edit · replace all" : s.note ? `Edit · ${s.note}` : "Edit";
  return { command: "Command", read: "Read", search: "Search", web: "Web", agent: "Agent" }[s.kind] || s.tool;
}

function desktopView($, e, go) {
  const ui = $.ui.resolve(e);
  const { Box, Text, Button, Svg, Markdown } = ui;
  const total = state.replay.length;
  const k = Math.max(0, Math.min(state.index, total - 1));
  const step = state.replay[k];
  const shown = visibleSteps();
  const pos = shown.findIndex((v) => v.i === k);
  const edits = state.replay.filter((s) => s.kind === "edit" && !s.isError);
  const sum = edits.reduce((t, s) => { const c = countChanges(s.diff); return { add: t.add + c.add, del: t.del + c.del }; }, { add: 0, del: 0 });

  const header = Box({
    key: "header", flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", paddingX: 1,
    children: [
      Box({ key: "heading", flexDirection: "column", children: [
        state.isLive
          ? Box({ key: "title", flexDirection: "row", alignItems: "center", gap: 1, children: [
              Markdown({ key: "t", text: "### This turn" }),
              Svg({ key: "live", source: spinner(12), alt: "Live", width: 12, height: 12 }),
              Text({ key: "live-label", color: ACCENT, children: "Live" }),
            ] })
          : Markdown({ key: "title", text: "### Last turn" }),
        Text({ key: "sub", dimColor: true, children: `${summaryText()}${state.turnMs ? " · " + duration(state.turnMs) : ""}` }),
      ] }),
      edits.length ? Box({ key: "sum", flexDirection: "row", alignItems: "center", gap: 1, children: [
        Text({ key: "add", color: "success", children: `+${sum.add}` }),
        Text({ key: "del", color: "error", children: `−${sum.del}` }),
        Svg({ key: "bar", source: diffstat(sum.add, sum.del, 9), alt: `${sum.add} lines added, ${sum.del} removed`, width: 53, height: 9 }),
      ] }) : null,
    ].filter(Boolean),
  });

  // A segmented control: only the kinds this turn has.
  const segments = FILTERS.filter((f) => f.id === "all" || state.replay.some(f.test)).map((f) => {
    const count = state.replay.filter(f.test).length;
    const isOn = state.filter === f.id;
    return Button({
      key: `filter-${f.id}`, label: f.id === "all" ? f.label : `${f.label} ${count}`,
      ...(isOn ? { variant: "secondary" } : { plain: true, dimColor: true }),
      onPress: () => {
        state.filter = f.id;
        const first = visibleSteps()[0];
        if (first && !f.test(state.replay[state.index])) state.index = first.i;
        state.follow = false;
        state.offset = 0;
        revealSelection();
        state.expanded = false;
        $.ui.invalidate("ui.render");
      },
    });
  });
  const filters = segments.length > 2 ? Box({ key: "filters", flexDirection: "row", gap: 1, paddingX: 1, alignItems: "center", children: segments }) : null;
  state.listRows = listRowsOf(!!filters, shown.length);

  // The list: five chips at a time, the wheel moving the window (ui.scroll).
  // No scrollbar; the chip at an edge with more beyond it fades instead.
  const offset = clampOffset(state.offset, shown.length);
  const windowed = shown.slice(offset, offset + LIST_WINDOW);
  const hasAbove = offset > 0;
  const hasBelow = offset + LIST_WINDOW < shown.length;
  const fadeOf = (j) => Math.max(
    hasAbove && j === 0 ? 2 : 0,
    hasBelow && j === windowed.length - 1 ? 2 : 0,
  );

  const chips = windowed.map(({ s, i }, j) => {
    const isCurrent = i === k;
    const fade = isCurrent ? 0 : fadeOf(j);
    const secondary = secondaryOf(s);
    const tint = s.isError ? RED : isCurrent || s.isRunning ? ACCENT_HEX : GRAY;
    return Box({
      key: `row${i}`, flexDirection: "row", alignItems: "center", gap: 1, paddingX: 1,
      borderStyle: "round", borderColor: isCurrent ? ACCENT : CHIP_BORDER[fade],
      backgroundColor: isCurrent ? SELECTED_BG : undefined,
      hover: isCurrent ? undefined : { backgroundColor: HOVER_BG, borderColor: CHIP_BORDER[0] },
      children: [
        Svg({ key: `icon${i}`, source: symbol(glyphOf(s), tint, 16, MARK_OPACITY[fade]), alt: kindLabel(s), width: 16, height: 16 }),
        Box({ key: `label${i}`, flexDirection: "row", flexGrow: 1, flexShrink: 1, gap: 1, alignItems: "center", overflow: "hidden", children: [
          Button({ key: `pick${i}`, label: s.kind === "edit" || s.kind === "read" ? baseName(s.file) : clip(String(s.title ?? s.tool), 70), plain: true, dimColor: fade > 0, onPress: () => go(i) }),
          secondary ? Text({ key: `sec${i}`, dimColor: true, color: fade > 1 ? "inactive" : undefined, wrap: "truncate-end", children: secondary }) : null,
        ].filter(Boolean) }),
        trailing(ui, s, i, fade > 0 ? false : isCurrent),
      ].filter(Boolean),
    });
  });
  const list = Box({ key: "rows", flexDirection: "column", gap: 1, children: chips });

  const stepGo = (d) => { const to = shown[pos + d]; if (to) go(to.i); };
  // A matched pair, no key badges: the pane's wheel and the chips are the
  // quick ways about; these two step in order.
  const nav = Box({ key: "nav", flexDirection: "row", gap: 1, alignItems: "center", flexShrink: 0, children: [
    Button({ key: "prev", label: "Previous", variant: "secondary", dimColor: pos <= 0, onPress: () => stepGo(-1) }),
    Button({ key: "next", label: "Next", variant: "secondary", dimColor: pos >= shown.length - 1, onPress: () => stepGo(1) }),
  ] });

  const c = countChanges(step.diff);
  const meta = [
    kindLabel(step),
    step.kind === "edit" || step.kind === "read" ? dirName(step.file) : "",
    step.ms >= 1000 ? duration(step.ms) : "",
  ].filter(Boolean).join(" · ");
  const card = Box({
    key: "card", flexDirection: "column", gap: 1, padding: 1, borderStyle: "round", borderColor: "subtle",
    children: [
      // The buttons have a row of their own, so a long title never pushes
      // them out of the card.
      Box({ key: "card-top", flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 2, children: [
        Text({ key: "pos", dimColor: true, children: `Step ${pos + 1} of ${shown.length}` }),
        nav,
      ] }),
      Box({ key: "card-head", flexDirection: "row", children: [
        Box({ key: "who", flexDirection: "row", gap: 1, alignItems: "flex-start", flexShrink: 1, children: [
          Svg({ key: "icon", source: symbol(glyphOf(step), step.isError ? RED : ACCENT_HEX, 20), alt: kindLabel(step), width: 20, height: 20 }),
          Box({ key: "names", flexDirection: "column", flexShrink: 1, children: [
            Text({ key: "title", bold: true, wrap: "truncate-end", children: step.kind === "edit" || step.kind === "read" ? baseName(step.file) : String(step.title ?? step.tool) }),
            Box({ key: "meta", flexDirection: "row", gap: 1, children: [
              Text({ key: "kind", dimColor: true, children: meta }),
              step.kind === "edit" && !step.isError ? Text({ key: "add", color: "success", children: `+${c.add}` }) : null,
              step.kind === "edit" && !step.isError ? Text({ key: "del", color: "error", children: `−${c.del}` }) : null,
              step.isError ? Text({ key: "failed", color: "error", children: "Failed" }) : null,
            ].filter(Boolean) }),
          ] }),
        ] }),
      ] }),
      ...bodyOf(ui, $, step),
    ],
  });

  return Box({
    flexDirection: "column", gap: 1, padding: 1,
    children: [header, filters, list, card].filter(Boolean),
  });
}

function clampOffset(offset, length) {
  return Math.max(0, Math.min(offset || 0, length - LIST_WINDOW));
}

// Keeps the selected step inside the list window.
function revealSelection() {
  const shown = visibleSteps();
  const pos = shown.findIndex((v) => v.i === state.index);
  if (pos < 0) return;
  if (pos < state.offset) state.offset = pos;
  else if (pos >= state.offset + LIST_WINDOW) state.offset = pos - LIST_WINDOW + 1;
  state.offset = clampOffset(state.offset, shown.length);
}

// Where the list sits in the pane body, in rows, for telling a wheel tick over
// the list from one over the card: the padding, the heading (title, summary),
// the filter row when drawn, the gaps; then each chip (border, label, border)
// and the gap after it.
function listRowsOf(hasFilters, count) {
  const top = 1 + 2 + 1 + (hasFilters ? 2 : 0);
  return { top, bottom: top + Math.min(count, LIST_WINDOW) * 4 - 1 };
}

// ── Terminal view ─────────────────────────────────────────────────────────
// One step at a time. Drawn in the Pane, or in the band above the prompt when
// the surface can't place a pane.

function terminalLines(step) {
  if (step.kind === "edit") return step.diff;
  const head = step.kind === "command" ? [{ op: "$", t: firstLine(step.detail) }] : [];
  return [...head, ...splitLines(step.output).map((t) => ({ op: " ", t }))];
}

function replayView($, e, inBand) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const maxDiff = inBand ? Math.max(3, Math.min(MAX_DIFF_LINES, (e.maxRows || 20) - 7)) : MAX_DIFF_LINES;
  const total = state.replay.length;
  if (!total) return Text({ dimColor: true, children: "Nothing to replay." });
  const k = Math.max(0, Math.min(state.index, total - 1));
  const step = state.replay[k];
  const go = (to) => { state.index = Math.max(0, Math.min(to, total - 1)); state.follow = false; state.expanded = false; revealSelection(); $.ui.invalidate("ui.render"); };
  const close = () => {
    state.isOpen = false;
    if (!state.inBand) $.ui.close({ id: PANE_ID });
    state.inBand = false;
    $.ui.invalidate("ui.render");
  };

  if (!inBand && e.surface === "desktop") return desktopView($, e, go);

  const width = Math.max(40, (e.bodyColumns || 100) - 4);
  const lines = terminalLines(step);
  const shown = lines.slice(0, maxDiff);
  const diffRows = shown.map((l, n) => {
    const color = l.op === "+" ? "success" : l.op === "-" ? "error" : l.op === "$" ? ACCENT : undefined;
    const line = `${l.op === "~" ? " " : l.op} ${l.t}`.slice(0, width);
    return Text({ key: `d${n}`, color, dimColor: l.op === " " || l.op === "~", wrap: "truncate-end", children: line });
  });
  if (lines.length > maxDiff) diffRows.push(Text({ key: "more", dimColor: true, children: `  … ${lines.length - maxDiff} more lines` }));
  if (!shown.length) diffRows.push(Text({ key: "empty", dimColor: true, children: "  (nothing to show)" }));
  const { add, del } = countChanges(step.diff);

  return Box({
    flexDirection: "column", borderStyle: "round", borderColor: "subtle", paddingX: 1,
    children: [
      Box({ flexDirection: "row", justifyContent: "space-between", children: [
        Text({ bold: true, children: "Replay" }),
        Text({ dimColor: true, children: `${k + 1} of ${total}` }),
      ] }),
      Text({ bold: true, color: step.isError ? "error" : ACCENT, wrap: "truncate-start", children: step.file ?? String(step.title ?? step.tool) }),
      Box({ flexDirection: "row", gap: 2, children: [
        Text({ dimColor: true, children: kindLabel(step) }),
        step.kind === "edit" ? Text({ color: "success", children: `+${add}` }) : null,
        step.kind === "edit" ? Text({ color: "error", children: `-${del}` }) : null,
      ].filter(Boolean) }),
      Box({ flexDirection: "column", marginTop: 1, children: diffRows }),
      Box({ flexDirection: "row", gap: 2, marginTop: 1, children: [
        Button({ key: "prev", label: "Prev", hotkey: "p", onPress: () => go(k - 1) }),
        Button({ key: "next", label: "Next", hotkey: "n", autoFocus: true, onPress: () => go(k + 1) }),
        Button({ key: "close", label: "Close", hotkey: "c", onPress: close }),
      ] }),
    ],
  });
}

// The band above the prompt: what the last turn did, and a way in.
function bandView($, e) {
  const { Box, Text, Button, Svg } = $.ui.resolve(e);
  const open = Button({ key: "open-replay", label: "Replay", variant: "secondary", hotkey: "r", onPress: () => openReplay($) });
  const label = state.isLive ? "This turn" : "Last turn";
  if (e.surface === "terminal") {
    return Box({ flexDirection: "row", gap: 2, paddingX: 1, children: [
      Text({ dimColor: true, children: `${label} · ${summaryText()}` }),
      open,
    ] });
  }
  return Box({ key: "band", flexDirection: "row", alignItems: "center", gap: 1, paddingX: 1, children: [
    Svg ? Svg(state.isLive
      ? { key: "icon", source: spinner(16), alt: "Live", width: 16, height: 16 }
      : { key: "icon", source: symbol("play", GRAY), alt: "", width: 16, height: 16 }) : null,
    Text({ key: "label", children: label }),
    Text({ key: "summary", dimColor: true, children: summaryText() }),
    Box({ key: "spacer", flexGrow: 1 }),
    open,
  ].filter(Boolean) });
}

export function register(on, options) {
  // Slash command: /replay opens the pane.
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    await $.command.register({ name: "replay", description: "Replay: step through everything the last turn did" });
    return r;
  });

  on("command.run", { command: "replay" }, async ($, e) => {
    const opened = await openReplay($);
    return { text: opened ? `Replay: ${summaryText()}` : "Replay: nothing happened in the last turn." };
  });

  // Record every main-loop tool call with what it returned. Never blocks it.
  on("tool.call", async ($, e, next) => {
    if (e.agentId) return next(e);
    return record($, e, next);
  });

  // A turn starts empty; its first tool call makes it the live replay.
  on("turn.start", ($, e, next) => {
    if (!e.agentId) { state.pending = []; state.isLive = false; state.turnStartedAt = Date.now(); }
    return next(e);
  });

  // At the end of a main-loop turn the live replay settles as the last turn's.
  // The selection stays where it is, so a step being read isn't snatched away.
  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    if (e.agentId || !state.isLive) return r;
    state.isLive = false;
    state.follow = false;
    state.pending = [];
    state.turnMs = state.turnStartedAt ? Date.now() - state.turnStartedAt : 0;
    state.turns++;
    $.ui.invalidate("ui.render");
    return r;
  });

  // The wheel over the list moves its window, a chip a tick; anywhere else in
  // the pane it scrolls the pane as usual.
  on("ui.scroll", { requestId: PANE_ID }, ($, e, next) => {
    const length = visibleSteps().length;
    const row = e.pointer?.row;
    const overList = row !== undefined && row >= state.listRows.top - 1 && row <= state.listRows.bottom;
    if (e.component !== "Pane" || length <= LIST_WINDOW || !overList) return next(e);
    const by = Math.sign(e.by) * Math.max(1, Math.round(Math.abs(e.by)));
    const offset = clampOffset(state.offset + by, length);
    if (offset !== state.offset) {
      state.offset = offset;
      state.follow = false;
      $.ui.invalidate("ui.render");
    }
    return {};
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (state.isOpen && state.inBand) return replayView($, e, true);
    if (!state.replay.length || state.isOpen) return next(e);
    return bandView($, e);
  });

  // The pane.
  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e);
    return replayView($, e, false);
  });

  // The person closed the pane (Escape): keep our flag in step.
  on("ui.close", ($, e, next) => {
    if (e.id === PANE_ID || e.requestId === PANE_ID) state.isOpen = false;
    $.ui.invalidate("ui.render");
    return next(e);
  });
}
