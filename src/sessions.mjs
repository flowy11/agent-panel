// Which Claude session is a pane showing right now? herdr records the session
// the pane started with, but Claude Code's ← agent view can switch the terminal
// to another main session. The terminal title follows the session on screen, and
// each transcript records its title as an "ai-title" entry, so match on that.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
const RECENT_MS = 2 * 24 * 3600 * 1000; // a session you just switched to is being written to
const results = new Map(); // "reported|cwd|title" -> session id
const running = new Set();

function projectDir(cwd, knownSession) {
  const guess = path.join(ROOT, (cwd || "").replace(/[^A-Za-z0-9]/g, "-"));
  if (fs.existsSync(guess)) return guess;
  if (knownSession) {
    for (const d of fs.readdirSync(ROOT)) if (fs.existsSync(path.join(ROOT, d, `${knownSession}.jsonl`))) return path.join(ROOT, d);
  }
  return null;
}

// Search transcripts for the title without blocking; resolves to a session id or null.
function search(dir, title, reported) {
  const now = Date.now();
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .filter((x) => now - x.m < RECENT_MS);
  if (!files.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn("grep", ["-l", "-F", "-e", `"aiTitle":${JSON.stringify(title)}`, "-e", `"customTitle":${JSON.stringify(title)}`, ...files.map((x) => x.f)]);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const hits = out.split("\n").filter(Boolean);
      if (reported && hits.some((f) => path.basename(f) === `${reported}.jsonl`)) return resolve(reported);
      // Several sessions can share a title (resumed or forked); the most recently active wins.
      const best = hits.map((f) => files.find((x) => x.f === f)).filter(Boolean).sort((a, b) => b.m - a.m)[0];
      resolve(best ? path.basename(best.f, ".jsonl") : null);
    });
  });
}

// Returns the best known session id now; when a lookup finishes, calls onResolved().
export function resolveSession(pane, onResolved) {
  const reported = pane.agent_session?.value || null;
  const title = (pane.terminal_title_stripped || "").trim();
  if (!title || title === "Claude Code") return reported;
  const key = `${reported}|${pane.cwd}|${title}`;
  if (results.has(key)) return results.get(key);
  if (!running.has(key)) {
    running.add(key);
    const dir = projectDir(pane.cwd, reported);
    (dir ? search(dir, title, reported) : Promise.resolve(null)).then((id) => {
      running.delete(key);
      results.set(key, id || reported);
      onResolved?.();
    });
  }
  return reported;
}
