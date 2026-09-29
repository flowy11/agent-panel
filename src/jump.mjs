// Switch a Claude Code session's view to one of its subagents (or back to main)
// by driving its own agent list: Down moves focus into the list, ↑/↓ selects a
// row, Enter views it. Every step is checked against the screen, and Esc is only
// sent while the list has focus (anywhere else, Esc interrupts the agent).
import { herdr } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROW = /^\s*(❯)?\s*([⏺◯])\s+(.*)$/;

function readList(pane) {
  const lines = herdr(["pane", "read", pane, "--source", "visible"]).stdout.split("\n");
  // The list sits at the bottom of the screen, under the input box.
  const rows = [];
  for (const line of lines.slice(-20)) {
    const m = line.match(ROW);
    if (m) rows.push({ selected: Boolean(m[1]), text: m[3].trim() });
  }
  const focused = lines.slice(-20).some((l) => /↑\/↓ to select|Enter to view/.test(l));
  return { rows, focused };
}

const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

// target: "main" or { type, description }. Resolves to null on success, or a message.
export async function viewInClaude(pane, target) {
  const agent = herdr(["agent", "get", pane]).json?.result?.agent;
  if (agent && agent.agent !== "claude") return "This pane is not running Claude Code";
  if (!agent) return "That Claude session is gone";
  if (agent.agent_status === "blocked") return "Claude is waiting for your answer — reply first";

  const matches = (row) => target === "main"
    ? /^main\b/.test(row.text)
    : norm(row.text).startsWith(norm(target.type)) && norm(row.text).includes(norm(target.description).slice(0, 24));

  for (let step = 0; step < 30; step++) {
    const { rows, focused } = readList(pane);
    if (!rows.length) return "Claude's agent list isn't showing";
    const want = rows.findIndex(matches);
    if (want < 0) return "Not in Claude's list (it only shows recent agents)";
    const at = rows.findIndex((r) => r.selected);
    if (at < 0 || !focused) {
      herdr(["pane", "send-keys", pane, "Down"]); // from the input, through any footer pills, into the list
      await sleep(200);
      continue;
    }
    if (at !== want) {
      const key = want > at ? "Down" : "Up";
      herdr(["pane", "send-keys", pane, ...Array(Math.abs(want - at)).fill(key)]);
      await sleep(200);
      continue;
    }
    herdr(["pane", "send-keys", pane, "Enter"]);
    await sleep(350);
    if (readList(pane).focused) herdr(["pane", "send-keys", pane, "Escape"]); // back to the input box
    herdr(["agent", "focus", pane]);
    return null;
  }
  return "Couldn't reach the row in Claude's list";
}
