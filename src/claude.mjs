// Read a Claude Code session's subagents from disk:
//   <project>/<session>/subagents/agent-<id>.jsonl   — each subagent's transcript
//   <project>/<session>/subagents/agent-<id>.meta.json — type, description, spawning tool call
//   <project>/<session>.jsonl — the main transcript; a <task-notification> with the
//     subagent's id and <status> marks each time it stops.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractRefs } from "./refs.mjs";

const STALL_MS = 5 * 60 * 1000;

function findSessionFile(sessionId) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const dir of dirs) {
    const file = path.join(root, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// A resumed session can carry on in a new transcript: the old one then ends with a
// {"type":"continued-in","continuedInSessionId":…} entry, while herdr still reports the old id.
// Follow those links to the session being written to now.
const continued = new Map(); // session id -> { mtime, next }
export function latestSession(sessionId) {
  let id = sessionId;
  for (let hops = 0; id && hops < 20; hops++) {
    const file = findSessionFile(id);
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return id; }
    let hit = continued.get(id);
    if (!hit || hit.mtime !== mtime) {
      let tail = "";
      try {
        const fd = fs.openSync(file, "r");
        const size = fs.fstatSync(fd).size, len = Math.min(size, 64 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        fs.closeSync(fd);
        tail = buf.toString("utf8");
      } catch {}
      const next = [...tail.matchAll(/"continuedInSessionId":"([^"]+)"/g)].pop()?.[1] || null;
      continued.set(id, hit = { mtime, next });
    }
    if (!hit.next || hit.next === id) return id;
    id = hit.next;
  }
  return id;
}

// Reads a growing JSONL file from where it left off.
export class Tail {
  constructor(file) { this.file = file; this.offset = 0; this.partial = ""; }
  read() {
    let size;
    try { size = fs.statSync(this.file).size; } catch { return []; }
    if (size < this.offset) { this.offset = 0; this.partial = ""; } // rewritten
    if (size === this.offset) return [];
    const fd = fs.openSync(this.file, "r");
    const buf = Buffer.alloc(size - this.offset);
    fs.readSync(fd, buf, 0, buf.length, this.offset);
    fs.closeSync(fd);
    this.offset = size;
    const text = this.partial + buf.toString("utf8");
    const lines = text.split("\n");
    this.partial = lines.pop();
    return lines;
  }
}

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
// Entries the harness writes as "user" that the person didn't type.
const isHarnessText = (text) =>
  /^\s*(<(command-|local-command|bash-|task-notification|system-reminder)|Caveat:|\[Request interrupted)/.test(text);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const textOf = (content) =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "";

// "ACTION: Review the plan in docs/plan.md": what Claude needs the user to do. hooks/session-start.sh
// asks Claude to repeat the whole list whenever it changes ("ACTION: none" when it's empty), so the
// latest message with these lines is the current list. Lines inside code blocks don't count.
export function parseActions(text) {
  const found = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    const m = !fence && line.match(/^\s*(?:[-*]\s+)?\**ACTION\**:\**\s*(.+?)\s*$/);
    if (m && m[1].replace(/\*\*/g, "").trim()) found.push(m[1].replace(/^\*\*\s*|\s*\*\*$/g, "").trim());
  }
  return found;
}

// "PROGRESS: 3/7 · Running the Android suite" or "PROGRESS: 40% - drafting". The last one in a message wins.
export function parseProgress(text) {
  const lines = text.match(/^\s*\**PROGRESS\**:?\**\s*.+$/gim);
  if (!lines) return null;
  const line = lines[lines.length - 1].replace(/^\s*\**PROGRESS\**:?\**\s*/i, "");
  const frac = line.match(/^(\d+)\s*(?:\/|of)\s*(\d+)\s*[·\-—–:|]?\s*(.*)$/i);
  if (frac && Number(frac[2]) > 0) return { done: Number(frac[1]), total: Number(frac[2]), percent: Math.min(100, Math.round((100 * frac[1]) / frac[2])), step: frac[3].trim() };
  const pct = line.match(/^(\d{1,3})\s*%\s*[·\-—–:|]?\s*(.*)$/);
  if (pct) return { percent: Math.min(100, Number(pct[1])), step: pct[2].trim() };
  return { step: line.trim() };
}

export function summarizeTool(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : "");
  const first = (s) => String(s || "").split("\n")[0];
  switch (name) {
    case "Bash": return first(input.description || input.command);
    case "Read": case "Edit": case "Write": case "NotebookEdit": return base(input.file_path || input.notebook_path);
    case "Grep": return `${input.pattern || ""}${input.path ? " in " + base(input.path) : ""}`;
    case "Glob": return input.pattern || "";
    case "WebFetch": try { return new URL(input.url).host + new URL(input.url).pathname; } catch { return input.url || ""; }
    case "WebSearch": return input.query || "";
    case "Agent": case "Task": return input.description || "";
    default: {
      const v = Object.values(input).find((x) => typeof x === "string");
      return first(v);
    }
  }
}

// Everything a subagent did, in order, for reading its conversation:
// [{ kind: "task"|"text"|"tool", text, name, summary, result, error }]
export function readConversation(file) {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const items = [];
  const tools = new Map();
  for (const line of raw.split("\n")) {
    const e = parse(line);
    if (!e) continue;
    const content = e.message?.content;
    if (e.type === "user") {
      if (!items.length) {
        const task = textOf(content).trim();
        if (task) items.push({ kind: "task", text: task });
      }
      if (Array.isArray(content)) for (const c of content) {
        if (c.type !== "tool_result") continue;
        const t = tools.get(c.tool_use_id);
        if (!t) continue;
        t.result = c.is_error ? "error" : "ok";
        if (c.is_error) t.error = (typeof c.content === "string" ? c.content : textOf(c.content)).trim().split("\n").slice(0, 3).join("\n");
      }
    } else if (e.type === "assistant" && Array.isArray(content)) {
      for (const c of content) {
        if (c.type === "text" && c.text.trim()) items.push({ kind: "text", text: c.text.trim() });
        if (c.type === "tool_use") {
          const t = { kind: "tool", name: c.name, summary: summarizeTool(c.name, c.input), result: "running" };
          tools.set(c.id, t);
          items.push(t);
        }
      }
    }
  }
  return items;
}

class Subagent {
  constructor(id, dir) {
    this.id = id;
    this.tail = new Tail(path.join(dir, `agent-${id}.jsonl`));
    try { this.meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${id}.meta.json`), "utf8")); } catch { this.meta = {}; }
    this.firstTs = 0; this.lastTs = 0; this.mtime = 0;
    this.task = ""; this.lastText = ""; this.toolCount = 0;
    this.actions = []; // { id, name, summary, ts, result: "running"|"ok"|"error" }
    this.progress = null; // { done, total, percent, step } from the agent's own "PROGRESS:" lines
  }
  refresh() {
    try { this.mtime = fs.statSync(this.tail.file).mtimeMs; } catch {}
    for (const line of this.tail.read()) {
      const e = parse(line);
      if (!e) continue;
      const ts = Date.parse(e.timestamp) || 0;
      if (ts) { this.firstTs ||= ts; this.lastTs = Math.max(this.lastTs, ts); }
      const content = e.message?.content;
      if (e.type === "user") {
        if (!this.task) this.task = textOf(content).trim();
        if (Array.isArray(content)) for (const c of content) {
          if (c.type !== "tool_result") continue;
          const a = this.actions.find((x) => x.id === c.tool_use_id);
          if (a) a.result = c.is_error ? "error" : "ok";
        }
      } else if (e.type === "assistant" && Array.isArray(content)) {
        for (const c of content) {
          if (c.type === "text" && c.text.trim()) {
            this.lastText = c.text.trim();
            this.progress = parseProgress(c.text) || this.progress;
          }
          if (c.type === "tool_use") {
            this.toolCount++;
            this.actions.push({ id: c.id, name: c.name, summary: summarizeTool(c.name, c.input), ts, result: "running" });
            if (this.actions.length > 50) this.actions.shift();
          }
        }
      }
    }
  }
}

export class Session {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.provider = "claude";
    this.assistantRole = "claude";
    this.mainFile = sessionId ? findSessionFile(sessionId) : null;
    this.dir = this.mainFile && path.join(this.mainFile.replace(/\.jsonl$/, ""), "subagents");
    this.main = this.mainFile && new Tail(this.mainFile);
    this.agents = new Map();
    this.stops = new Map(); // agent id -> { ts, status } from task notifications
    this.results = new Map(); // tool_use_id -> ts, for subagents run in the foreground
    // The main conversation, in order: { role: "you"|"claude", ts, text, actions, edits, cmds, errors }.
    // Claude's tool calls belong to the message they follow (one with no text if it hasn't said anything yet).
    this.messages = [];
    this.turns = []; // just your messages
    this.toolActions = new Map(); // tool_use_id -> action, to record results
    // URLs and files Claude mentions in its messages: value -> { kind, value, line, ts, msg, order },
    // filed under the newest message that mentions it (msg: index into messages).
    this.refs = new Map();
    this.edited = new Set(); // files Claude edited or wrote
    this.cwd = "";
    this.refOrder = 0;
    // The user's to-do list as of Claude's latest ACTION: lines: { id, text, ts, msg } where ts and msg
    // are when an item was first asked for; todoMsg/todoTs: the message that gave the current list.
    this.todos = [];
    this.todoMsg = -1;
    this.todoTs = 0;
    this.todoFirst = new Map(); // id -> { ts, msg } of the first time it was asked
  }

  // ACTION: lines in Claude's latest message: they replace the list (blocks of one message add up).
  setTodos(actions, ts) {
    const msg = this.messages.length - 1;
    if (msg !== this.todoMsg) { this.todos = []; this.todoMsg = msg; }
    this.todoTs = ts;
    for (const text of actions) {
      if (/^none\W*$/i.test(text)) continue;
      // Same item, same id, even if the wording's punctuation or case shifts a little.
      const id = text.replace(/\*\*|`/g, "").replace(/[.!\s]+$/, "").replace(/\s+/g, " ").toLowerCase();
      if (this.todos.some((t) => t.id === id)) continue;
      if (!this.todoFirst.has(id)) this.todoFirst.set(id, { ts, msg });
      this.todos.push({ id, text, ...this.todoFirst.get(id) });
    }
  }

  // Refs in the text of Claude's latest message.
  addRefs(refs, ts) {
    const msg = this.messages.length - 1;
    for (const r of refs) {
      const ref = this.refs.get(r.value);
      if (ref?.msg === msg) { if (r.line) ref.line = r.line; continue; }
      this.refs.set(r.value, { kind: r.kind, value: r.value, line: r.line || 0, ts, msg, order: this.refOrder++ });
    }
  }

  addMessage(role, ts, text, msgId = "") {
    const m = { role, ts, text: text.trim(), msgId, actions: [], edits: 0, cmds: 0, errors: 0 };
    this.messages.push(m);
    if (role === "you") this.turns.push(m);
    return m;
  }

  addPrompt(ts, text) {
    if (!text.trim() || isHarnessText(text)) return;
    this.addMessage("you", ts, text);
  }

  // One main-transcript entry -> messages.
  trackTurn(e) {
    if (e.isSidechain) return;
    const ts = Date.parse(e.timestamp) || 0;
    const content = e.message?.content;
    if (e.cwd) this.cwd = e.cwd;
    if (e.type === "user") {
      if (!e.isMeta && !e.isCompactSummary) this.addPrompt(ts, textOf(content));
      if (Array.isArray(content)) for (const c of content) {
        if (c.type !== "tool_result") continue;
        const a = this.toolActions.get(c.tool_use_id);
        if (!a) continue;
        a.result = c.is_error ? "error" : "ok";
        if (c.is_error) a.message.errors++;
        this.toolActions.delete(c.tool_use_id);
      }
    } else if (e.type === "attachment") {
      const a = e.attachment; // messages typed while the agent is busy
      if (a?.type === "queued_command" && a.commandMode === "prompt" && (a.humanTurn || a.origin?.kind === "human")) {
        this.addPrompt(ts, typeof a.prompt === "string" ? a.prompt : textOf(a.prompt));
      }
    } else if (e.type === "assistant" && Array.isArray(content)) {
      const msgId = e.message?.id || "";
      for (const c of content) {
        const last = this.messages[this.messages.length - 1];
        if (c.type === "text" && c.text.trim()) {
          // Tool calls with nothing said yet take this text; text blocks of one response join up.
          if (last?.role === this.assistantRole && (!last.text || (msgId && last.msgId === msgId && !last.actions.length))) {
            last.text = last.text ? `${last.text}\n\n${c.text.trim()}` : c.text.trim();
            last.msgId = msgId;
          } else this.addMessage(this.assistantRole, ts, c.text, msgId);
          this.addRefs(extractRefs(c.text, this.cwd), ts);
          const actions = parseActions(c.text);
          if (actions.length) this.setTodos(actions, ts);
        }
        if (c.type !== "tool_use") continue;
        const m = last?.role === this.assistantRole ? last : this.addMessage(this.assistantRole, ts, "", msgId);
        if (EDIT_TOOLS.has(c.name) && typeof (c.input?.file_path || c.input?.notebook_path) === "string")
          this.edited.add(path.resolve(this.cwd || "/", c.input.file_path || c.input.notebook_path));
        if (EDIT_TOOLS.has(c.name)) m.edits++;
        if (c.name === "Bash") m.cmds++;
        const action = { name: c.name, summary: summarizeTool(c.name, c.input), result: "running", message: m };
        m.actions.push(action);
        if (m.actions.length > 40) m.actions.shift();
        this.toolActions.set(c.id, action);
      }
    }
  }

  refresh() {
    if (!this.mainFile) return;
    for (const line of this.main.read()) {
      const entry = parse(line);
      if (entry) this.trackTurn(entry);
      if (line.includes("<task-notification>")) {
        const e = parse(line);
        const text = JSON.stringify(e?.message?.content ?? e?.content ?? e?.attachment?.prompt ?? "");
        const id = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
        const status = text.match(/<status>([^<]+)<\/status>/)?.[1];
        const ts = Date.parse(e?.timestamp) || Date.now();
        if (id && status && (!this.stops.get(id) || this.stops.get(id).ts <= ts)) this.stops.set(id, { ts, status });
      } else if (line.includes('"tool_result"') && !line.includes("Async agent launched")) {
        const e = parse(line);
        const ts = Date.parse(e?.timestamp) || Date.now();
        for (const c of Array.isArray(e?.message?.content) ? e.message.content : [])
          if (c.type === "tool_result") this.results.set(c.tool_use_id, ts);
      }
    }
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch {}
    for (const f of files) {
      const m = f.match(/^agent-(.+)\.jsonl$/);
      if (!m) continue;
      if (!this.agents.has(m[1])) this.agents.set(m[1], new Subagent(m[1], this.dir));
      this.agents.get(m[1]).refresh();
    }
  }

  // [{ id, type, description, status, started, ended, toolCount, current, actions, lastText, task }]
  list(now = Date.now()) {
    return [...this.agents.values()].map((a) => {
      const last = Math.max(a.lastTs, a.mtime || 0);
      const stop = this.stops.get(a.id);
      const fg = this.results.get(a.meta.toolUseId);
      let status = "running";
      // A stop only counts if nothing happened after it (a stopped agent can be resumed).
      if (stop && stop.ts >= a.lastTs - 2000) status = stop.status === "completed" ? "done" : stop.status;
      else if (fg && fg >= a.lastTs - 2000) status = "done";
      else if (now - last > STALL_MS) status = "stalled";
      const pending = [...a.actions].reverse().find((x) => x.result === "running");
      return {
        id: a.id,
        type: a.meta.agentType || "agent",
        description: a.meta.description || a.task.split("\n")[0] || a.id,
        status,
        started: a.firstTs,
        ended: status === "running" ? 0 : a.lastTs,
        idleFor: now - last,
        toolCount: a.toolCount,
        current: status === "running" || status === "stalled" ? pending || a.actions[a.actions.length - 1] : null,
        actions: a.actions,
        lastText: a.lastText,
        progress: a.progress,
        file: a.tail.file,
        task: a.task,
      };
    });
  }
}
