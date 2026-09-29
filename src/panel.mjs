// Side panel for the Claude Code session in this tab, with four tabs:
//   Subagents — its subagents; Enter/click switches Claude to that subagent, m back to main
//   Messages  — your messages and Claude's, in order; Enter/click shows one in full in a popup, Space expands it here
//   Refs      — URLs and files Claude mentioned, by message; Enter/click opens one, y copies it
//   To do     — what Claude says you still have to do (its latest ACTION: list); x checks one off, Enter/click shows where it asked
// Tab, ←/→, 1–4 or a click on the tab bar switches tabs. j/k move, q closes the panel in this tab.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { LABEL, PLUGIN_ID, PLUGIN_LABELS, STATE_DIR, herdr, isAgentPane, setDismissed, snapshot } from "./lib.mjs";
import { createSession, paneSession, readConversation } from "./providers.mjs";
import { viewInClaude } from "./jump.mjs";
import { displayPath } from "./refs.mjs";
import { WHO, c, plain, width, fit, fitMiddle, wrap, dur, ago, firstLine, spread, copyText } from "./text.mjs";

const out = process.stdout;
const RECENT_MS = 30 * 60 * 1000;
const TAB_FILE = path.join(STATE_DIR, "tab");
const ICON = {
  running: `${c.yellow}●${c.reset}`, done: `${c.green}✓${c.reset}`, failed: `${c.red}✗${c.reset}`,
  killed: `${c.dim}⊘${c.reset}`, stalled: `${c.magenta}◌${c.reset}`,
};
const ORDER = { running: 0, stalled: 1, failed: 2, killed: 3, done: 4 };

// ---------- state ----------

let tracked = null; // { paneId, sessionId, cwd, status }
let session = null;
const TABS = ["subagents", "messages", "refs", "todo"];
let tab = (() => { try { const t = fs.readFileSync(TAB_FILE, "utf8").trim(); return TABS.includes(t) ? t : TABS[0]; } catch { return TABS[0]; } })();
let refs = []; // what the Refs tab lists: by the Claude message that mentions them, newest first
let todos = []; // what the To do tab lists: Claude's latest list, in its order, the ones you checked off last
// Checked-off to-dos: { [sessionId]: [todo id] }.
const DONE_FILE = path.join(STATE_DIR, "todo-done.json");
const readDone = () => { try { return JSON.parse(fs.readFileSync(DONE_FILE, "utf8")); } catch { return {}; } };
const views = {
  messages: { cursor: -1, scroll: 0, expanded: new Set(), follow: true },
  subagents: { cursor: 0, scroll: 0, expanded: new Set() },
  refs: { cursor: 0, scroll: 0, expanded: new Set() },
  todo: { cursor: 0, scroll: 0, expanded: new Set() },
};
let showAll = false;
const FINISHED_FILE = path.join(STATE_DIR, "finished-collapsed");
let finishedCollapsed = (() => { try { return fs.readFileSync(FINISHED_FILE, "utf8").trim() !== "0"; } catch { return true; } })();
let finishedCount = 0;
let agents = []; // what the Subagents tab lists (finished ones left out while collapsed)
let screenRows = []; // screen row (1-based) -> item index, for clicks
let tabHits = []; // [{ from, to, tab }] columns on the tab bar
let flash = "", flashUntil = 0;
let busy = false;
let detail = null; // { agent, items, stamp, scroll } — a subagent's conversation shown in the panel

const NO_AGENT_GRACE_MS = 5000;
let noAgentSince = 0;

// Which Claude agent to show: the focused pane when it's in this tab, else the
// last one shown, else the first Claude pane in this tab.
function pickAgent() {
  if (process.env.SA_SESSION) { // testing outside herdr
    session ||= createSession(process.env.SA_SESSION, process.env.SA_PROVIDER);
    tracked = { cwd: process.env.SA_CWD || "", status: "idle" };
    return;
  }
  const snap = snapshot();
  if (!snap) return;
  const panes = snap.panes || [];
  const me = panes.find((p) => p.label === LABEL);
  const myTab = me?.tab_id;
  // The pane it sat beside was closed and only plugin panels are left: go with it.
  if (me && !panes.some((p) => p.tab_id === myTab && !PLUGIN_LABELS.has(p.label))) {
    herdr(["pane", "close", me.pane_id]);
    return quit();
  }
  // Claude quit in this tab: after a grace period (detection can blink), go too.
  if (me && !panes.some((p) => p.tab_id === myTab && isAgentPane(p))) {
    noAgentSince ||= Date.now();
    if (Date.now() - noAgentSince > NO_AGENT_GRACE_MS) {
      herdr(["pane", "close", me.pane_id]);
      return quit();
    }
  } else noAgentSince = 0;
  const isEligible = (p) => p && p.tab_id === myTab && isAgentPane(p) && p.agent_session?.value;
  const focused = panes.find((p) => p.pane_id === snap.focused_pane_id);
  const still = tracked && panes.find((p) => p.pane_id === tracked.paneId);
  const pick = isEligible(focused) ? focused : isEligible(still) ? still : panes.find(isEligible);
  if (!pick) { tracked = null; session = null; return; }
  // The session on screen, which differs from herdr's record after Claude's ← agent view switches it,
  // and after a resume that carried on in a new transcript.
  const sessionId = paneSession(pick, pickAgent);
  if (sessionId !== session?.sessionId || pick.agent !== session?.provider) {
    session = createSession(sessionId, pick.agent);
    views.messages = { cursor: -1, scroll: 0, expanded: new Set(), follow: true };
    views.subagents = { cursor: 0, scroll: 0, expanded: new Set() };
    views.refs = { cursor: 0, scroll: 0, expanded: new Set() };
    views.todo = { cursor: 0, scroll: 0, expanded: new Set() };
    refresh();
  }
  tracked = { paneId: pick.pane_id, sessionId, cwd: pick.cwd, status: pick.agent_status };
}

function refresh() {
  if (!session) { agents = []; refs = []; todos = []; return; }
  session.refresh();
  // Keep the cursor on the same ref when a new mention reorders the list.
  const at = refs[views.refs.cursor]?.value;
  refs = [...session.refs.values()].sort((a, b) => b.msg - a.msg || a.order - b.order);
  const keep = refs.findIndex((r) => r.value === at);
  views.refs.cursor = keep >= 0 ? keep : Math.min(views.refs.cursor, Math.max(0, refs.length - 1));
  const doneIds = new Set(readDone()[session.sessionId] || []);
  const atTodo = todos[views.todo.cursor]?.id;
  todos = session.todos.map((t) => ({ ...t, done: doneIds.has(t.id) }))
    .sort((a, b) => Number(a.done) - Number(b.done)); // stable: Claude's order otherwise
  const keepTodo = todos.findIndex((t) => t.id === atTodo);
  views.todo.cursor = keepTodo >= 0 ? keepTodo : Math.min(views.todo.cursor, Math.max(0, todos.length - 1));
  const now = Date.now();
  agents = session.list(now)
    .filter((a) => showAll || a.status === "running" || a.status === "stalled" || now - (a.ended || now) < RECENT_MS)
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || (b.ended || b.started) - (a.ended || a.started));
  const live = (a) => a.status === "running" || a.status === "stalled";
  finishedCount = agents.filter((a) => !live(a)).length;
  if (finishedCollapsed) agents = agents.filter(live);
  const m = views.messages, n = session.messages.length;
  if (m.follow || m.cursor < 0) m.cursor = n - 1; // newest message, like a chat
  m.cursor = Math.min(m.cursor, n - 1);
  views.subagents.cursor = Math.min(views.subagents.cursor, Math.max(0, agents.length - 1));
}

const items = () => (tab === "messages" ? session?.messages || [] : tab === "refs" ? refs : tab === "todo" ? todos : agents);

// ---------- views ----------

// Your messages and Claude's, in order. Each: a line with who, what it did and when, then the
// text at full width (3 rows, or all of it when expanded). The selected one gets a bar in the margin.
// Markdown syntax costs columns in a 3-row preview: drop fences, emphasis, backticks and heading marks.
const unmark = (s) => s.replace(/^```\w*$/gm, "").replace(/\*\*|__|`/g, "").replace(/^#{1,6}\s+/gm, "").replace(/^\s*[-*]\s+/gm, "· ");
// A message's rows (header, then body), cached: re-wrapping every message on every frame made
// scrolling a long session lag. Rebuilt only when what it shows changes.
const rowCache = new WeakMap(); // message -> { key, rows }
function messageBlock(m, w, expanded, time) {
  const results = expanded || !m.text ? m.actions.map((a) => a.result[0]).join("") : "";
  const key = `${w}|${expanded}|${time}|${m.text.length}|${m.actions.length}|${m.edits}${m.cmds}${m.errors}|${results}`;
  const hit = rowCache.get(m);
  if (hit?.key === key) return hit.rows;
  // What its tool calls did, in words ("2 edits · 4 cmds · 1 failed"), or as
  // symbols ("✎2 $4 ✗1") when the words don't fit next to the time.
  const count = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const say = [
    m.edits ? `${c.cyan}${count(m.edits, "edit")}${c.reset}` : "",
    m.cmds ? `${c.dim}${count(m.cmds, "cmd")}${c.reset}` : "",
    m.errors ? `${c.red}${m.errors} failed${c.reset}` : "",
  ].filter(Boolean);
  const brief = [
    m.edits ? `${c.cyan}✎${m.edits}${c.reset}` : "",
    m.cmds ? `${c.dim}$${m.cmds}${c.reset}` : "",
    m.errors ? `${c.red}✗${m.errors}${c.reset}` : "",
  ].filter(Boolean).join(" ");
  let head = `${WHO[m.role]}${say.length ? "  " + say.join(`${c.dim} · ${c.reset}`) : ""}`;
  if (width(head) + width(time) + 1 > w) head = `${WHO[m.role]}${brief ? "  " + brief : ""}`;
  const rows = [spread(head, time, w)];
  if (expanded) {
    rows.push(...wrap(m.text, w).slice(0, 80));
    if (m.actions.length) {
      if (m.text) rows.push("");
      for (const a of m.actions.slice(-12)) {
        const r = a.result === "ok" ? `${c.green}✓${c.reset}` : a.result === "error" ? `${c.red}✗${c.reset}` : `${c.yellow}…${c.reset}`;
        rows.push(`${r} ${c.dim}${fit(`${a.name} ${a.summary}`, w - 2)}${c.reset}`);
      }
    }
  } else if (m.text) {
    // 3 rows never hold more than 3w characters, so wrap just the start of a long message.
    const lines = wrap(unmark(m.text.slice(0, w * 5)).replace(/\s+/g, " "), w);
    if (lines.length > 3) lines.splice(2, Infinity, fit(lines.slice(2).join(" "), w));
    rows.push(...lines);
  } else {
    const n = m.actions.length, last = m.actions.at(-1);
    rows.push(`${c.dim}${c.italic}${n} tool call${n === 1 ? "" : "s"}${last ? ` · ${fit(`${last.name} ${last.summary}`, w - 16)}` : ""}${c.reset}`);
  }
  rowCache.set(m, { key, rows });
  return rows;
}

function messageRows(w, now) {
  const v = views.messages;
  const rows = [];
  const msgs = session?.messages || [];
  msgs.forEach((m, i) => {
    if (m.role === "you" && rows.length) rows.push({ text: "", i: -1 });
    const live = i === msgs.length - 1 && tracked?.status === "working";
    const time = live ? `${c.yellow}working…${c.reset}` : `${c.dim}${ago(now - m.ts)}${c.reset}`;
    for (const text of messageBlock(m, w, v.expanded.has(i), time)) rows.push({ text, i });
  });
  if (!msgs.length) rows.push({ text: `${c.dim}  ${session ? "No messages yet" : "No supported agent session in this tab"}${c.reset}`, i: -1 });
  return rows;
}

function subagentRows(w, now) {
  const v = views.subagents;
  const rows = [];
  const live = (a) => a.status === "running" || a.status === "stalled";
  const nLive = agents.filter(live).length;
  // Section headers, so finished agents aren't mistaken for running ones. Finished folds (f or click).
  const finishedHeader = () => {
    if (rows.length) rows.push({ text: "", i: -1 });
    const arrow = finishedCollapsed ? "▸" : "▾";
    rows.push({ text: `${c.dim}${arrow} FINISHED · ${showAll ? "all" : "last 30 min"} · ${finishedCount}${c.reset}`, i: "finished" });
  };
  if (session) rows.push({ text: `${c.dim}RUNNING · ${nLive || "none"}${c.reset}`, i: -1 });
  agents.forEach((a, i) => {
    if (!live(a) && (i === 0 || live(agents[i - 1]))) finishedHeader();
    const mark = " "; // the selection is a bar in the margin (draw)
    const time = a.status === "running" ? dur(now - a.started) : a.status === "stalled" ? `quiet ${dur(a.idleFor).split(" ")[0]}` : ago(now - a.ended);
    const title = fit(a.description, w - width(time) - 5);
    rows.push({ text: spread(`${mark} ${ICON[a.status] || "?"} ${a.status === "running" ? c.bold : ""}${title}${c.reset}`, `${c.dim}${time}${c.reset}`, w), i });
    rows.push({ text: `    ${c.dim}${fit(`${a.type} · ${a.toolCount} tools${a.status !== "running" && a.ended ? ` · took ${dur(a.ended - a.started)}` : ""}`, w - 4)}${c.reset}`, i });
    if (a.progress && (a.status === "running" || a.status === "stalled")) {
      const p = a.progress;
      const barW = Math.min(12, Math.max(6, Math.floor(w / 5)));
      const bar = p.percent !== undefined
        ? `${c.green}${"▰".repeat(Math.round((p.percent / 100) * barW))}${c.dim}${"▱".repeat(barW - Math.round((p.percent / 100) * barW))}${c.reset} `
        : "";
      const count = p.total ? `${p.done}/${p.total} ` : p.percent !== undefined ? `${p.percent}% ` : "";
      rows.push({ text: `    ${bar}${c.bold}${count}${c.reset}${fit(p.step, Math.max(8, w - 6 - barW - width(count)))}`, i });
    }
    if (a.current) rows.push({ text: `    ${c.cyan}↳${c.reset} ${fit(`${a.current.name} ${a.current.summary}`, w - 6)}`, i });
    if (v.expanded.has(a.id)) {
      for (const act of a.actions.slice(-8)) {
        const r = act.result === "ok" ? `${c.green}✓${c.reset}` : act.result === "error" ? `${c.red}✗${c.reset}` : `${c.yellow}…${c.reset}`;
        rows.push({ text: `      ${r} ${c.dim}${fit(`${act.name} ${act.summary}`, w - 8)}${c.reset}`, i });
      }
      const text = a.status === "running" ? a.lastText : a.lastText || a.task;
      if (text) {
        rows.push({ text: "", i });
        for (const line of wrap(text, w - 6).slice(0, 10)) rows.push({ text: `      ${c.italic}${line}${c.reset}`, i });
      }
    }
    rows.push({ text: "", i });
  });
  if (finishedCount && finishedCollapsed) finishedHeader();
  if (!session) rows.push({ text: `${c.dim}  No supported agent session in this tab${c.reset}`, i: -1 });
  else if (!agents.length && !finishedCount) rows.push({ text: `${c.dim}  ${showAll ? "No subagents in this session" : "None in the last 30 min — a shows all"}${c.reset}`, i: -1 });
  return rows;
}

// Grouped under the Claude message that mentions them, newest first; a click on the group's
// header shows that message in full.
function refRows(w, now) {
  const v = views.refs;
  const rows = [];
  const cwd = tracked?.cwd || session?.cwd || "";
  let group = -1;
  refs.forEach((r, i) => {
    if (r.msg !== group) {
      if (rows.length) rows.push({ text: "", i: -1 });
      const m = session.messages[r.msg];
      const time = `${c.dim}${ago(now - (m?.ts || r.ts))}${c.reset}`;
      const title = `${c.orange}●${c.reset} ${c.dim}${fit(firstLine(m?.text).replace(/\*\*|`/g, ""), w - width(time) - 4)}${c.reset}`;
      rows.push({ text: spread(title, time, w), i: `msg:${r.msg}` });
      group = r.msg;
    }
    const mark = " "; // the selection is a bar in the margin (draw)
    let stat = null;
    if (r.kind === "file") try { stat = fs.statSync(r.value); } catch {}
    const missing = r.kind === "file" && !stat;
    const edited = r.kind === "file" && session.edited.has(r.value);
    const icon = r.kind === "url" ? `${c.cyan}↗${c.reset}` : missing ? `${c.dim}?${c.reset}` : `${c.dim}▤${c.reset}`;
    const right = edited ? `${c.cyan}✎${c.reset}` : "";
    const name = r.kind === "url" ? r.value.replace(/^https?:\/\//, "") : displayPath(r.value, cwd) + (stat?.isDirectory() ? "/" : "") + (r.line ? `:${r.line}` : "");
    const title = fitMiddle(name, w - width(right) - 5);
    const style = missing ? c.dim : "";
    rows.push({ text: spread(`${mark} ${icon} ${style}${title}${c.reset}`, right, w), i });
    if (v.expanded.has(r.value)) {
      for (const line of wrap(r.value, w - 6).slice(0, 4)) rows.push({ text: `      ${line}`, i });
      if (missing) rows.push({ text: `      ${c.dim}not on disk${c.reset}`, i });
    }
  });
  if (!refs.length) rows.push({ text: `${c.dim}  ${session ? "The agent hasn't mentioned any URLs or files yet" : "No supported agent session in this tab"}${c.reset}`, i: -1 });
  return rows;
}

// Claude's current list: open items, then the ones you checked off. Each: up to 3 rows of the request,
// with when Claude first asked in the margin of the first.
function todoRows(w, now) {
  const v = views.todo;
  const rows = [];
  let section = null;
  todos.forEach((t, i) => {
    if (t.done !== section) {
      if (rows.length) rows.push({ text: "", i: -1 });
      const n = todos.filter((x) => x.done === t.done).length;
      const head = `${c.dim}${t.done ? "DONE" : "OPEN"} · ${n}${c.reset}`;
      rows.push({ text: rows.length ? head : spread(head, `${c.dim}list from ${ago(now - session.todoTs)}${c.reset}`, w), i: -1 });
      section = t.done;
    }
    const mark = " "; // the selection is a bar in the margin (draw)
    const icon = t.done ? `${c.green}✓${c.reset}` : `${c.yellow}○${c.reset}`;
    const time = `${c.dim}${ago(now - t.ts)}${c.reset}`;
    const text = t.text.replace(/\*\*|`/g, "");
    const lines = wrap(text, w - 4);
    if (lines.length > 3) lines.splice(2, Infinity, fit(lines.slice(2).join(" "), w - 4));
    const style = t.done ? c.dim : "";
    lines.forEach((line, n) => {
      const row = `${n ? "   " : `${mark}${icon} `} ${style}${line}${c.reset}`;
      rows.push({ text: n === 0 && width(row) + width(time) + 1 <= w ? spread(row, time, w) : row, i });
    });
    if (width(`${mark}${icon}  ${lines[0]}`) + width(time) + 1 > w) rows.push({ text: `    ${time}`, i });
  });
  if (!todos.length) {
    const cleared = session?.todoMsg >= 0;
    rows.push({ text: `${c.dim}  ${!session ? "No supported agent session in this tab" : cleared ? `Nothing left to do · ${ago(now - session.todoTs)}` : "The agent hasn't asked you for anything"}${c.reset}`, i: -1 });
    if (session && !cleared) rows.push({ text: `${c.dim}  (it lists requests as ACTION: lines, see README)${c.reset}`, i: -1 });
  }
  return rows;
}

function toggleTodo(t) {
  if (!t || !session) return;
  const all = readDone();
  const ids = new Set(all[session.sessionId] || []);
  ids.has(t.id) ? ids.delete(t.id) : ids.add(t.id);
  all[session.sessionId] = [...ids];
  // Only the 50 most recently changed sessions are kept.
  const keep = Object.fromEntries(Object.entries(all).filter(([k]) => k !== session.sessionId).slice(-49));
  keep[session.sessionId] = all[session.sessionId];
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(DONE_FILE, JSON.stringify(keep)); } catch {}
  refresh();
  render();
}

// ---------- conversation view ----------

function openDetail(agent) {
  detail = { agent, items: [], stamp: 0, scroll: 0 };
  reloadDetail();
}

function reloadDetail() {
  if (!detail) return;
  let stamp = 0;
  try { stamp = fs.statSync(detail.agent.file).mtimeMs; } catch {}
  if (stamp === detail.stamp) return;
  const atEnd = detail.stamp && detail.scroll >= detail.maxScroll;
  detail.stamp = stamp;
  detail.items = readConversation(detail.agent.file, session?.provider);
  if (atEnd) detail.scroll = Infinity; // keep following a running agent
}

function detailRows(w) {
  const rows = [];
  for (const it of detail.items) {
    if (it.kind === "task") {
      rows.push(`${c.dim}TASK${c.reset}`);
      for (const l of wrap(it.text, w - 2).slice(0, 30)) rows.push(`${c.bold}${l}${c.reset}`);
      rows.push("");
    } else if (it.kind === "text") {
      for (const l of wrap(it.text, w - 2)) rows.push(l);
      rows.push("");
    } else {
      const r = it.result === "ok" ? `${c.green}✓${c.reset}` : it.result === "error" ? `${c.red}✗${c.reset}` : `${c.yellow}…${c.reset}`;
      rows.push(`${r} ${c.dim}${fit(`${it.name} ${it.summary}`, w - 4)}${c.reset}`);
      if (it.error) for (const l of wrap(it.error, w - 4).slice(0, 3)) rows.push(`  ${c.red}${l}${c.reset}`);
    }
  }
  return rows;
}

function renderDetail() {
  const W = out.columns || 50, H = out.rows || 30, w = W - 2;
  const a = detail.agent;
  const head = [
    `${c.bold}← ${fit(a.description, w - 3)}${c.reset}`,
    `${c.dim}${fit(`${a.type} · ${a.status} · ${a.toolCount} tools`, w)}${c.reset}`,
    `${c.dim}${"─".repeat(Math.max(0, w))}${c.reset}`,
  ];
  const rows = detailRows(w);
  const bodyH = H - head.length - 1;
  detail.maxScroll = Math.max(0, rows.length - bodyH);
  detail.scroll = Math.max(0, Math.min(detail.scroll, detail.maxScroll));
  const help = flash && Date.now() < flashUntil ? flash : `${c.dim}Esc back · j/k scroll · space page · z zoom`;
  let frame = "\x1b[H" + head.map((l) => " " + l + "\x1b[K").join("\n") + "\n";
  frame += rows.slice(detail.scroll, detail.scroll + bodyH).map((l) => " " + l + "\x1b[K").join("\n") + "\x1b[J";
  frame += `\x1b[${H};1H ${width(help) > w ? c.dim + fit(plain(help), w) : help}${c.reset}\x1b[K`;
  out.write(frame);
}

function zoom() {
  const me = (snapshot()?.panes || []).find((p) => p.label === LABEL);
  if (me) herdr(["pane", "zoom", me.pane_id, "--toggle"]);
}

function onDetailKey(key) {
  const page = (out.rows || 30) - 5;
  const wheel = key.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
  if (wheel) {
    if (wheel[1] === "64") detail.scroll -= 3;
    else if (wheel[1] === "65") detail.scroll += 3;
    else if (wheel[1] === "0" && /M$/.test(key) && /^\x1b\[<0;\d+;1M$/.test(key)) detail = null; // click the title to go back
    return render();
  }
  if (key === "\x1b" || key === "q" || key === "\x7f" || key === "\x1b[D") detail = null;
  else if (key === "j" || key === "\x1b[B") detail.scroll += 1;
  else if (key === "k" || key === "\x1b[A") detail.scroll -= 1;
  else if (key === " " || key === "\x1b[6~") detail.scroll += page;
  else if (key === "\x1b[5~") detail.scroll -= page;
  else if (key === "g") detail.scroll = 0;
  else if (key === "G") detail.scroll = Infinity;
  else if (key === "z") return zoom();
  else return;
  render();
}

// ---------- rendering ----------

// Draw on the next tick, once, however many events asked for it: a trackpad flick sends dozens of
// wheel events at once, and drawing after each one fell behind.
let drawPending = false;
function render() {
  if (drawPending) return;
  drawPending = true;
  setImmediate(() => { drawPending = false; draw(); });
}

function draw() {
  if (detail) return renderDetail();
  const W = out.columns || 50;
  const H = out.rows || 30;
  const w = W - 2;
  const now = Date.now();

  // Tab bar
  const all = session ? session.list(now) : [];
  const running = all.filter((a) => a.status === "running").length;
  // Tab labels, shortened until the bar fits the panel's width.
  const counts = {
    messages: `${c.dim}${session?.turns.length || 0}${c.reset}`, // yours
    subagents: running ? `${c.yellow}●${running}${c.reset}` : "", // running only, like Claude's own count
    refs: refs.length ? `${c.dim}${refs.length}${c.reset}` : "",
    todo: (() => { const n = todos.filter((t) => !t.done).length; return n ? `${c.yellow}○${n}${c.reset}` : ""; })(),
  };
  const names = [
    { messages: "Messages", subagents: "Subagents", refs: "Refs", todo: "To do" },
    { messages: "Msgs", subagents: "Agents", refs: "Refs", todo: "To do" },
    { messages: "M", subagents: "A", refs: "R", todo: "D" },
  ];
  let bar = "";
  for (const set of names) {
    let col = 2;
    bar = "";
    tabHits = [];
    for (const name of TABS) {
      const text = ` ${set[name]}${counts[name] ? " " + counts[name] : ""} `;
      tabHits.push({ from: col, to: col + width(text) - 1, tab: name });
      bar += (name === tab ? `${c.inverse}${c.bold}${plain(text)}${c.reset}` : text) + (set === names[2] ? "" : " ");
      col += width(text) + (set === names[2] ? 0 : 1);
    }
    if (width(bar) <= w) break;
  }
  const where = tracked?.cwd ? path.basename(tracked.cwd) : "";
  const room = w - width(bar) - 1;
  const head = [
    room >= 6 ? spread(bar, `${c.dim}${fit(where, room)}${c.reset}`, w) : bar,
    `${c.dim}${"─".repeat(Math.max(0, w))}${c.reset}`,
  ];

  const v = views[tab];
  const rows = tab === "messages" ? messageRows(w, now) : tab === "refs" ? refRows(w, now) : tab === "todo" ? todoRows(w, now) : subagentRows(w, now);
  const bodyH = H - head.length - 1;
  v.maxScroll = Math.max(0, rows.length - bodyH);
  if (v.free) {
    // Scrolled with the wheel: the view stays put (or on the bottom, if it's there) wherever the cursor is.
    if (v.stick) v.scroll = v.maxScroll;
  } else {
    const first = rows.findIndex((r) => r.i === v.cursor);
    let last = first;
    while (last + 1 < rows.length && rows[last + 1].i === v.cursor) last++;
    if (first >= 0) {
      if (first < v.scroll) v.scroll = first;
      if (last >= v.scroll + bodyH) v.scroll = Math.min(first, last - bodyH + 1);
    }
  }
  v.scroll = Math.max(0, Math.min(v.scroll, v.maxScroll));
  // The selected item gets a teal bar in the margin, down all its rows but the blank ones after it.
  const sel = v.cursor >= 0 && items().length ? rows.map((r, n) => (r.i === v.cursor ? n : -1)).filter((n) => n >= 0) : [];
  while (sel.length && !plain(rows[sel[sel.length - 1]].text).trim()) sel.pop();
  const barred = new Set(sel);
  const shown = rows.slice(v.scroll, v.scroll + bodyH).map((r, n) => ({ ...r, bar: barred.has(v.scroll + n) }));
  screenRows = [...head.map(() => -1), ...shown.map((r) => r.i)];

  let help;
  if (busy) help = `${c.yellow}switching…`;
  else if (flash && now < flashUntil) help = flash;
  else if (tab === "messages") help = `${c.dim}click/Enter full message · Space expand · q close`;
  else if (tab === "refs") help = `${c.dim}click/Enter open · y copy · click ● message · q close`;
  else if (tab === "todo") help = `${c.dim}x done · click/Enter message · y copy · q close`;
  else help = `${c.dim}${w >= 58 ? `${session?.provider === "codex" ? "click/Enter read" : "click/Enter open in Claude"} · v read here · f finished · a ${showAll ? "recent" : "all"}` : "click open · v read · f finished"}`;
  const footer = width(help) > w ? `${c.dim}${fit(plain(help), w)}` : help;

  let frame = "\x1b[H" + head.map((l) => " " + l + "\x1b[K").join("\n") + "\n";
  frame += shown.map((r) => (r.bar ? `${c.cyan}▎${c.reset}` : " ") + r.text + "\x1b[K").join("\n") + "\x1b[J";
  frame += `\x1b[${H};1H ${footer}${c.reset}\x1b[K`;
  out.write(frame);
}

// ---------- input ----------

// dismiss: close in this tab only; the panel keeps following you to other Claude tabs.
function quit({ dismiss = false } = {}) {
  if (dismiss) {
    const snap = snapshot();
    const me = (snap?.panes || []).find((p) => p.label === LABEL);
    if (me) setDismissed(me.tab_id, true, new Set((snap.tabs || []).map((t) => t.tab_id)));
  }
  out.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
  process.exit(0);
}

function setTab(name) {
  tab = name;
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(TAB_FILE, name); } catch {}
}

// Switch the Claude session's own view to this subagent (or main).
async function openInClaude(target) {
  if (session?.provider === "codex") {
    if (target !== "main") openDetail(target); else detail = null;
    return render();
  }
  if (busy || !tracked?.paneId) return;
  busy = true;
  draw(); // now: switching can block before its first pause
  const err = await viewInClaude(tracked.paneId, target);
  busy = false;
  // Claude only lists running and recent subagents; show finished ones' conversations here instead.
  if (err && target !== "main" && /Not in Claude's list|isn't showing/.test(err)) {
    openDetail(target);
    flash = `${c.dim}Claude no longer lists it — showing its conversation here`;
    flashUntil = Date.now() + 5000;
    return render();
  }
  flash = err ? `${c.red}${err}` : `${c.green}Showing ${target === "main" ? "main" : target.description} in Claude`;
  flashUntil = Date.now() + 4000;
  render();
}

function toggleFinished() {
  finishedCollapsed = !finishedCollapsed;
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(FINISHED_FILE, finishedCollapsed ? "1" : "0"); } catch {}
  refresh();
  render();
}

// Open a ref: files and web pages through the File Viewer plugin when it's installed
// (the file in its popup, pages in its browser tab), else the system's default app.
let viewerRoot; // File Viewer's folder, looked up once
function openRef(r) {
  if (!r) return;
  const isDir = r.kind === "file" && (() => { try { return fs.statSync(r.value).isDirectory(); } catch { return false; } })();
  if (r.kind === "file" && !isDir && !fs.existsSync(r.value)) {
    flash = `${c.red}Not on disk: ${displayPath(r.value, session?.cwd || "")}`;
    flashUntil = Date.now() + 4000;
    return render();
  }
  if (viewerRoot === undefined) {
    const p = herdr(["plugin", "list", "--plugin", "file-viewer", "--json"]).json?.result?.plugins?.[0];
    viewerRoot = p?.enabled ? p.plugin_root : null;
  }
  if (viewerRoot && !isDir && tracked?.paneId) {
    const env = { ...process.env, HERDR_PLUGIN_ID: "file-viewer",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ selected_text: r.line ? `${r.value}:${r.line}` : r.value, focused_pane_id: tracked.paneId }) };
    delete env.HERDR_PLUGIN_CLICKED_URL;
    // Its state lives next to ours (…/plugins/<id>), where its panel reads it.
    if (process.env.HERDR_PLUGIN_STATE_DIR) env.HERDR_PLUGIN_STATE_DIR = path.join(path.dirname(process.env.HERDR_PLUGIN_STATE_DIR), "file-viewer");
    else delete env.HERDR_PLUGIN_STATE_DIR;
    spawn(process.execPath, [path.join(viewerRoot, "src", "open.mjs")], { cwd: viewerRoot, env, detached: true, stdio: "ignore" }).unref();
  } else {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [r.value], { detached: true, stdio: "ignore" }).unref();
  }
  flash = `${c.green}Opening ${fit(r.kind === "url" ? r.value.replace(/^https?:\/\//, "") : path.basename(r.value), 40)}`;
  flashUntil = Date.now() + 3000;
  render();
}

function copyRef(r) {
  if (!r) return;
  const text = r.value;
  const ok = copyText(text);
  flash = ok ? `${c.green}Copied ${fit(text, 40)}` : `${c.red}No clipboard tool found`;
  flashUntil = Date.now() + 3000;
  render();
}

// One message in full, in a popup over the whole terminal (src/message.mjs). Where that can't
// open (another herdr dialog is up, or testing outside herdr), expand it in the panel instead.
function popOut(i) {
  if (i < 0 || !session) return;
  const res = process.env.SA_SESSION ? { ok: false, stderr: "not in herdr" }
    : herdr(["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "message",
      "--env", `MSG_SESSION=${session.sessionId}`, "--env", `MSG_INDEX=${i}`, "--env", `MSG_PROVIDER=${session.provider}`]);
  if (res.ok) return;
  views.messages.expanded.add(i);
  flash = `${c.dim}No popup (${fit(res.stderr || "herdr refused", 30)}) — expanded here`;
  flashUntil = Date.now() + 4000;
  render();
}

function activate() { // Enter or click on the current item
  const v = views[tab];
  if (tab === "refs") return openRef(refs[v.cursor]);
  if (tab === "todo") return todos[v.cursor] && popOut(todos[v.cursor].msg);
  if (tab === "messages") return popOut(v.cursor);
  const a = agents[v.cursor];
  if (a) openInClaude(a);
}

function move(delta) {
  const v = views[tab];
  const n = items().length;
  if (v.free) {
    // Back from wheel scrolling: start from what's on screen, not a cursor scrolled out of view.
    v.free = false;
    const visible = screenRows.filter((x) => typeof x === "number" && x >= 0);
    if (visible.length && !visible.includes(v.cursor)) {
      v.cursor = delta < 0 ? visible[visible.length - 1] : visible[0];
      if (tab === "messages") views.messages.follow = v.cursor === n - 1;
      return;
    }
  }
  v.cursor = Math.max(0, Math.min(n - 1, v.cursor + delta));
  if (tab === "messages") views.messages.follow = v.cursor === n - 1;
}

// The wheel scrolls the view a row at a time and leaves the cursor alone. Moving the cursor by whole
// items made a trackpad flick (which keeps sending wheel events after you let go) fly through the list.
function wheel(delta) {
  const v = views[tab];
  v.free = true;
  v.scroll = Math.max(0, Math.min(v.maxScroll ?? 0, v.scroll + delta));
  v.stick = v.scroll >= (v.maxScroll ?? 0);
  if (tab === "messages") views.messages.follow = v.stick; // at the bottom: keep showing new messages
}

function onKey(key) {
  if (detail && key !== "\x03") return onDetailKey(key);
  const mouse = key.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (mouse) {
    const [, b, x, y, kind] = mouse;
    if (b === "64") wheel(-1);
    else if (b === "65") wheel(1);
    else if (b === "0" && kind === "M") {
      if (Number(y) === 1) {
        const hit = tabHits.find((h) => Number(x) >= h.from && Number(x) <= h.to);
        if (hit) setTab(hit.tab);
      } else if (screenRows[Number(y) - 1] === "finished") {
        return toggleFinished();
      } else if (/^msg:\d+$/.test(screenRows[Number(y) - 1])) {
        return popOut(Number(screenRows[Number(y) - 1].slice(4)));
      } else if (screenRows[Number(y) - 1] >= 0) {
        views[tab].cursor = screenRows[Number(y) - 1];
        if (tab === "messages") views.messages.follow = views.messages.cursor === items().length - 1;
        return activate();
      }
    }
    return render();
  }
  if (key === "\x03") return quit();
  if (key === "q") return quit({ dismiss: true });
  if (key === "\t" || key === "\x1b[C") setTab(TABS[(TABS.indexOf(tab) + 1) % TABS.length]); // Tab, →
  else if (key === "\x1b[D") setTab(TABS[(TABS.indexOf(tab) + TABS.length - 1) % TABS.length]); // ←
  else if (/^[1-4]$/.test(key)) setTab(TABS[Number(key) - 1]);
  else if (key === "j" || key === "\x1b[B") move(1);
  else if (key === "k" || key === "\x1b[A") move(-1);
  else if (key === "g") move(-Infinity);
  else if (key === "G") move(Infinity);
  else if (key === "\r") return activate();
  else if (key === " " || key === "l" || key === "h") {
    const v = views[tab];
    const id = tab === "messages" ? v.cursor : tab === "refs" ? refs[v.cursor]?.value : agents[v.cursor]?.id;
    if (id !== undefined && id !== -1) v.expanded.has(id) ? v.expanded.delete(id) : v.expanded.add(id);
  } else if (key === "m" && tab === "subagents") return openInClaude("main");
  else if (key === "v" && tab === "subagents" && agents[views.subagents.cursor]) openDetail(agents[views.subagents.cursor]);
  else if (key === "a" && tab === "subagents") { showAll = !showAll; refresh(); }
  else if (key === "y" && tab === "refs") return copyRef(refs[views.refs.cursor]);
  else if (key === "x" && tab === "todo") return toggleTodo(todos[views.todo.cursor]);
  else if (key === "y" && tab === "todo" && todos[views.todo.cursor]) {
    // A request with a command in it ("Run `herdr server stop`") copies just the command.
    const t = todos[views.todo.cursor].text;
    const text = t.match(/`([^`]+)`/)?.[1] || t.replace(/\*\*|`/g, "");
    flash = copyText(text) ? `${c.green}Copied ${fit(text, 40)}` : `${c.red}No clipboard tool found`;
    flashUntil = Date.now() + 3000;
  }
  else if (key === "f" && tab === "subagents") return toggleFinished();
  else return;
  render();
}

// ---------- main ----------

out.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1000h\x1b[?1006h"); // mouse clicks and wheel
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const key of chunk.match(/\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[0-9;]*[~A-Za-z]|\x1b.|[\s\S]/gu) || []) onKey(key);
});
out.on("resize", () => { out.write("\x1b[2J"); render(); });
process.on("SIGTERM", () => quit());
process.on("SIGHUP", () => quit());

pickAgent();
refresh();
render();
setInterval(() => { refresh(); reloadDetail(); render(); }, 1000);
setInterval(pickAgent, 1500);
