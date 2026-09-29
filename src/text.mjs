// Terminal text helpers shared by the panel and the message popup.
import { spawnSync } from "node:child_process";

export const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", italic: "\x1b[3m", inverse: "\x1b[7m", under: "\x1b[4m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", magenta: "\x1b[35m",
  blue: "\x1b[34m", orange: "\x1b[38;5;208m",
};

// Who sent a message: a blue dot for you, an orange one for Claude.
export const WHO = { codex: `${c.green}●${c.reset} ${c.bold}Codex${c.reset}`, you: `${c.blue}●${c.reset} ${c.bold}you${c.reset}`, claude: `${c.orange}●${c.reset} ${c.bold}Claude${c.reset}` };

export const charWidth = (ch) =>
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}]/u.test(ch) ? 2 : 1;
export const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
export const width = (s) => [...plain(s)].reduce((n, ch) => n + charWidth(ch), 0);
export function fit(s, w) { // truncate plain text to w columns
  let r = "", used = 0;
  for (const ch of s.replace(/\s+/g, " ")) {
    if (used + charWidth(ch) > w - 1) return r + "…";
    r += ch; used += charWidth(ch);
  }
  return r;
}
// Truncate in the middle, keeping the end (a file name, a page) in view.
export function fitMiddle(s, w) {
  if (width(s) <= w) return s;
  const chars = [...s];
  const keep = Math.max(1, w - 1), tail = Math.ceil(keep * 0.6);
  return chars.slice(0, keep - tail).join("") + "…" + chars.slice(-tail).join("");
}
export function wrap(s, w) {
  const rows = [];
  for (const para of s.split("\n")) {
    let line = "";
    for (let word of para.split(/\s+/)) {
      if (line && width(line + " " + word) > w) { rows.push(line); line = ""; }
      // A word wider than the row (a URL, a long path) is broken across rows.
      while (width(word) > w) {
        let head = "", used = 0;
        for (const ch of word) { if (used + charWidth(ch) > w - width(line) - (line ? 1 : 0)) break; head += ch; used += charWidth(ch); }
        if (!head) { if (!line) break; rows.push(line); line = ""; continue; }
        rows.push(line ? line + " " + head : head);
        line = "";
        word = word.slice(head.length);
      }
      line = line ? line + " " + word : word;
    }
    rows.push(line);
  }
  return rows;
}
export function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}
export function ago(ms) {
  if (ms < 60000) return "just now";
  if (ms < 86400000) return `${dur(ms).split(" ")[0]} ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}
export const firstLine = (s) => (s || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
// Right-align `right` on a row of width w.
export const spread = (left, right, w) => `${left}${" ".repeat(Math.max(1, w - width(left) - width(right)))}${right}`;

// Copy to the system clipboard; false when there's no clipboard tool.
export const copyText = (text) =>
  [["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "-b", "-i"]]
    .some(([cmd, ...args]) => spawnSync(cmd, args, { input: text, timeout: 2000 }).status === 0);
