// Popup with one message of the conversation in full: its text (with light Markdown styling) and,
// for Claude's, the tool calls that followed it. Opened from the panel's Messages tab with
// MSG_SESSION and MSG_INDEX; ←/→ step through the other messages, Esc closes.
import { createSession } from "./providers.mjs";
import { WHO, ago, c, charWidth, copyText, fit, plain, spread, width, wrap } from "./text.mjs";

const out = process.stdout;
const session = createSession(process.env.MSG_SESSION || process.env.SA_SESSION || "", process.env.MSG_PROVIDER || process.env.SA_PROVIDER);
let index = Number(process.env.MSG_INDEX) || 0;
let scroll = 0, maxScroll = 0;
let stamp = ""; // what's on screen, to redraw only on change
let flash = "", flashUntil = 0;

// A code line keeps its indentation, cut into rows of w columns.
function chunk(line, w) {
  const rows = [];
  let row = "", used = 0;
  for (const ch of line.replace(/\t/g, "  ")) {
    if (used + charWidth(ch) > w) { rows.push(row); row = ""; used = 0; }
    row += ch; used += charWidth(ch);
  }
  rows.push(row);
  return rows;
}

// **bold** and `code` inside a wrapped row; state carries a span over to the next row.
function styleRow(row, state) {
  let s = (state.bold ? c.bold : "") + (state.code ? c.cyan : "");
  for (const part of row.split(/(\*\*|`)/)) {
    if (part === "**") { state.bold = !state.bold; s += state.bold ? c.bold : "\x1b[22m"; }
    else if (part === "`") { state.code = !state.code; s += state.code ? c.cyan : "\x1b[39m"; }
    else s += part;
  }
  return s + c.reset;
}

function bodyRows(m, w) {
  const rows = [];
  let fence = false;
  for (const para of m.text.split("\n")) {
    if (/^\s*```/.test(para)) { fence = !fence; continue; }
    if (fence) { for (const r of chunk(para, w - 2)) rows.push(`${c.dim}│${c.reset} ${r}`); continue; }
    const heading = para.match(/^#{1,6}\s+(.*)$/);
    if (heading) { rows.push(`${c.bold}${c.under}${fit(heading[1].replace(/\*\*|`/g, ""), w + 1)}${c.reset}`); continue; }
    const state = { bold: false, code: false };
    for (const r of wrap(para, w)) rows.push(styleRow(r, state));
  }
  if (!m.text) rows.push(`${c.dim}${c.italic}(no text, only tool calls)${c.reset}`);
  if (m.actions.length) {
    rows.push("", `${c.dim}TOOL CALLS · ${m.actions.length}${m.actions.length >= 40 ? " (last 40)" : ""}${c.reset}`);
    for (const a of m.actions) {
      const r = a.result === "ok" ? `${c.green}✓${c.reset}` : a.result === "error" ? `${c.red}✗${c.reset}` : `${c.yellow}…${c.reset}`;
      rows.push(`${r} ${c.dim}${fit(`${a.name} ${a.summary}`, w - 1)}${c.reset}`);
    }
  }
  return rows;
}

function render(force = false) {
  const W = out.columns || 80, H = out.rows || 24, w = W - 4;
  const msgs = session.messages;
  const m = msgs[index];
  const key = `${W}x${H}:${index}:${scroll}:${m?.text.length}:${m?.actions.map((a) => a.result[0]).join("")}:${flash}`;
  if (!force && key === stamp) return;
  stamp = key;
  if (!m) {
    out.write(`\x1b[H\x1b[2J  ${c.dim}Message not found — Esc closes${c.reset}`);
    return;
  }
  const when = new Date(m.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const head = [
    spread(`${WHO[m.role]}  ${c.dim}${when} · ${ago(Date.now() - m.ts)}${c.reset}`, `${c.dim}${index + 1} / ${msgs.length}${c.reset}`, w),
    `${c.dim}${"─".repeat(w)}${c.reset}`,
  ];
  const rows = bodyRows(m, w);
  const bodyH = H - head.length - 2;
  const atEnd = scroll >= maxScroll && maxScroll > 0;
  maxScroll = Math.max(0, rows.length - bodyH);
  if (atEnd) scroll = maxScroll; // keep following a message that's still growing
  scroll = Math.max(0, Math.min(scroll, maxScroll));
  const more = maxScroll ? ` · ${Math.min(100, Math.round((100 * (scroll + bodyH)) / rows.length))}%` : "";
  const help = flash && Date.now() < flashUntil ? flash : `${c.dim}j/k scroll · ←/→ prev/next · y copy · Esc close${more}`;
  let frame = "\x1b[H" + head.map((l) => "  " + l + "\x1b[K").join("\n") + "\n";
  frame += rows.slice(scroll, scroll + bodyH).map((l) => "  " + l + "\x1b[K").join("\n") + "\x1b[J";
  frame += `\x1b[${H};1H  ${width(help) > w ? c.dim + fit(plain(help), w) : help}${c.reset}\x1b[K`;
  out.write(frame);
}

function go(i) {
  const n = session.messages.length;
  if (i < 0 || i >= n) return;
  index = i; scroll = 0; maxScroll = 0;
}

function quit() {
  out.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
  process.exit(0);
}

function onKey(key) {
  const page = Math.max(1, (out.rows || 24) - 5);
  const wheel = key.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
  if (wheel) {
    if (wheel[1] === "64") scroll -= 1;
    else if (wheel[1] === "65") scroll += 1;
    else return;
  } else if (key === "\x1b" || key === "q" || key === "\x03" || key === "\r") return quit();
  else if (key === "j" || key === "\x1b[B") scroll += 1;
  else if (key === "k" || key === "\x1b[A") scroll -= 1;
  else if (key === " " || key === "\x1b[6~" || key === "f") scroll += page;
  else if (key === "b" || key === "\x1b[5~") scroll -= page;
  else if (key === "g") scroll = 0;
  else if (key === "G") scroll = Infinity;
  else if (key === "\x1b[D" || key === "h" || key === "p") go(index - 1);
  else if (key === "\x1b[C" || key === "l" || key === "n") go(index + 1);
  else if (key === "y") {
    const m = session.messages[index];
    flash = m && copyText(m.text) ? `${c.green}Copied the message` : `${c.red}Nothing copied`;
    flashUntil = Date.now() + 2500;
    setTimeout(() => render(), 2600);
  } else return;
  scroll = Math.max(0, Math.min(scroll, maxScroll));
  render();
}

out.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1000h\x1b[?1006h");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const key of chunk.match(/\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[0-9;]*[~A-Za-z]|\x1b.|[\s\S]/gu) || []) onKey(key);
});
out.on("resize", () => { out.write("\x1b[2J"); render(true); });
process.on("SIGTERM", quit);
process.on("SIGHUP", quit);

session.refresh();
index = Math.max(0, Math.min(index, session.messages.length - 1));
render(true);
setInterval(() => { session.refresh(); render(); }, 1000);
