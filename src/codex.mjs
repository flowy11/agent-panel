// Codex rollouts are local JSONL transcripts. Read only response_item messages:
// event_msg repeats many of the same messages and would duplicate the conversation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session as ClaudeSession, Tail, parseProgress } from "./claude.mjs";

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const home = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
let indexRoot = "", indexedAt = 0, files = new Map();
const metadata = new Map();
function readMeta(file) {
  if (metadata.has(file)) return metadata.get(file);
  let fd;
  try {
    fd = fs.openSync(file, "r");
    let first = "";
    const buf = Buffer.alloc(65536);
    while (!first.includes("\n") && first.length < 4 * 1024 * 1024) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      first += buf.subarray(0, n).toString("utf8");
    }
    const entry = parse(first.split("\n")[0]);
    const meta = entry?.type === "session_meta" ? entry.payload : null;
    if (meta?.id) metadata.set(file, meta);
    return meta;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function sessionFiles() {
  const root = home();
  if (indexRoot === root && Date.now() - indexedAt < 5000) return files;
  indexRoot = root; indexedAt = Date.now(); files = new Map();
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else if (e.name.endsWith(".jsonl")) {
        const meta = readMeta(file);
        if (meta?.id) files.set(meta.id, { file, meta });
      }
    }
  }
  walk(path.join(root, "archived_sessions"));
  walk(path.join(root, "sessions"));
  return files;
}
const textOf = (content) => typeof content === "string" ? content : (content || [])
  .filter((c) => ["input_text", "output_text", "text"].includes(c.type)).map((c) => c.text || "").join("\n");
const harness = (text) => /^\s*(?:<environment_context>|<permissions instructions>|<turn_aborted>|<subagent_notification>|# AGENTS\.md instructions|<INSTRUCTIONS>)/.test(text);
const nameOf = (name = "") => name.split(/[.:]/).pop();
const toolName = (name) => ({ exec_command: "Bash", shell_command: "Bash", shell: "Bash", apply_patch: "Edit" }[nameOf(name)] || name);
function failed(output) {
  const obj = typeof output === "string" ? parse(output) : output;
  if (obj?.isError || obj?.is_error || obj?.error || (typeof obj?.exit_code === "number" && obj.exit_code !== 0)) return true;
  return /(?:Process exited with code|["']?exit_code["']?\s*:)\s*[1-9]\d*/.test(typeof output === "string" ? output : JSON.stringify(output));
}

export class CodexSession extends ClaudeSession {
  constructor(id, file = null) {
    // No Claude lookup for a Codex id.
    super("");
    this.sessionId = id; this.provider = "codex"; this.assistantRole = "codex";
    this.mainFile = file || sessionFiles().get(id)?.file || null;
    this.main = this.mainFile ? new Tail(this.mainFile) : null;
    this.children = new Map(); this.calls = new Map(); this.spawned = new Map();
    this.firstTs = 0; this.lastTs = 0; this.status = "idle";
  }
  consume(e) {
    const p = e.payload || {}, ts = Date.parse(e.timestamp) || 0;
    this.firstTs ||= ts; this.lastTs = Math.max(this.lastTs, ts);
    if (e.type === "session_meta" || e.type === "turn_context") { this.cwd = p.cwd || this.cwd; return; }
    if (e.type === "event_msg") {
      if (p.type === "task_started") this.status = "running";
      if (p.type === "task_complete") this.status = "done";
      if (p.type === "turn_aborted") this.status = "killed";
      return;
    }
    if (e.type !== "response_item") return;
    if (p.type === "message" && ["user", "assistant"].includes(p.role)) {
      const text = textOf(p.content);
      if (!text.trim() || (p.role === "user" && harness(text)) || p.channel === "analysis") return;
      this.trackTurn({ type: p.role, timestamp: e.timestamp, message: { id: p.id, content: [{ type: "text", text }] } });
      if (p.role === "assistant" && p.phase === "final_answer") this.status = "done";
    } else if (["function_call", "custom_tool_call"].includes(p.type)) {
      this.status = "running";
      const input = parse(p.arguments) || (typeof p.input === "object" ? p.input : null) || { command: p.input || p.arguments || "" };
      this.calls.set(p.call_id, { name: nameOf(p.name), input });
      const name = toolName(p.name);
      const normalized = name === "Bash" ? { ...input, command: input.cmd || input.command, description: input.description } : input;
      this.trackTurn({ type: "assistant", timestamp: e.timestamp, message: { content: [{ type: "tool_use", id: p.call_id, name, input: normalized }] } });
      if (nameOf(p.name) === "apply_patch") for (const m of String(p.input || input.command || "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) this.edited.add(path.resolve(this.cwd || "/", m[1]));
    } else if (["function_call_output", "custom_tool_call_output"].includes(p.type)) {
      const call = this.calls.get(p.call_id), result = typeof p.output === "string" ? parse(p.output) : p.output;
      if (call?.name === "spawn_agent" && result?.agent_id) this.spawned.set(result.agent_id, call.input);
      this.calls.delete(p.call_id);
      this.trackTurn({ type: "user", timestamp: e.timestamp, message: { content: [{ type: "tool_result", tool_use_id: p.call_id, is_error: failed(p.output) }] } });
    }
  }
  refresh(includeChildren = true) {
    if (!this.main) {
      this.mainFile = sessionFiles().get(this.sessionId)?.file || null;
      if (this.mainFile) this.main = new Tail(this.mainFile);
    }
    if (!this.main) return;
    for (const line of this.main.read()) { const e = parse(line); if (e) this.consume(e); }
    if (!includeChildren) return;
    for (const [id, { file, meta }] of sessionFiles()) {
      const parent = meta.source?.subagent?.thread_spawn?.parent_thread_id || meta.thread_source?.subagent?.thread_spawn?.parent_thread_id;
      if (id === this.sessionId || (parent !== this.sessionId && !this.spawned.has(id))) continue;
      if (!this.children.has(id)) this.children.set(id, new CodexSession(id, file));
      this.children.get(id).refresh(false);
    }
  }
  list(now = Date.now()) {
    return [...this.children].map(([id, child]) => {
      const actions = child.messages.flatMap((m) => m.actions), lastText = child.messages.filter((m) => m.role === "codex" && m.text).at(-1)?.text || "";
      const task = this.spawned.get(id)?.message || child.turns[0]?.text || "";
      const status = child.status === "running" && now - child.lastTs > 300000 ? "stalled" : child.status === "idle" ? "stalled" : child.status;
      return { id, type: this.spawned.get(id)?.agent_type || "codex", description: this.spawned.get(id)?.task_name || task.split("\n")[0] || id,
        status, started: child.firstTs, ended: ["done", "failed", "killed"].includes(status) ? child.lastTs : 0,
        idleFor: now - child.lastTs, toolCount: actions.length, current: ["running", "stalled"].includes(status) ? actions.at(-1) : null,
        actions: actions.slice(-50), lastText, progress: parseProgress(lastText), file: child.mainFile, task };
    });
  }
}
export function readCodexConversation(file) {
  const session = new CodexSession("", file);
  session.refresh(false);
  return session.messages.flatMap((m) => [
    ...(m.text ? [{ kind: m.role === "you" ? "task" : "text", text: m.text }] : []),
    ...m.actions.map(({ name, summary, result }) => ({ kind: "tool", name, summary, result })),
  ]);
}
