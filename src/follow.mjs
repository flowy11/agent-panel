// Keep one panel docked on the right of the focused tab.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OLD_LABELS, dismissedTabs, livePanels, PLUGIN_ID, SIDE_RATIO, STATE_DIR, herdr, isAgentPane, isHidden, snapshot } from "./lib.mjs";

const LOCK = path.join(STATE_DIR, "follow.lock");
const AGAIN = path.join(STATE_DIR, "follow.again");
const RATIO = path.join(STATE_DIR, "ratio");

// Keep whatever width the user resized the panel to, as the share of the tab the agent keeps.
function rememberWidth(snap, panel) {
  const layout = (snap.layouts || []).find((l) => l.tab_id === panel.tab_id);
  const rect = layout?.panes.find((p) => p.pane_id === panel.pane_id)?.rect;
  if (!rect || !layout.area?.width || layout.zoomed) return;
  const ratio = 1 - rect.width / layout.area.width;
  if (ratio > 0.2 && ratio < 0.9) fs.writeFileSync(RATIO, ratio.toFixed(3));
}
function savedRatio() {
  let r = 0;
  try { r = Number(fs.readFileSync(RATIO, "utf8").trim()); } catch {}
  return r > 0.2 && r < 0.9 ? r : SIDE_RATIO;
}

function place() {
  const snap = snapshot();
  if (!snap) return;
  const tab = snap.focused_tab_id;
  const layout = (snap.layouts || []).find((l) => l.tab_id === tab);
  if (!tab || !layout || layout.zoomed) return;

  const [panel, ...extra] = livePanels(snap);
  for (const p of extra) herdr(["pane", "close", p.pane_id]); // never more than one
  for (const p of (snap.panes || []).filter((p) => OLD_LABELS.includes(p.label))) herdr(["pane", "close", p.pane_id]);
  // Only tabs running a supported agent session get the panel. Elsewhere it stays in
  // the tab it was in, unless that is this tab (the agent quit here): then it closes.
  const byId = new Map((snap.panes || []).map((p) => [p.pane_id, p]));
  const agents = layout.panes.map((p) => byId.get(p.pane_id)).filter(isAgentPane);
  if (!agents.length) {
    if (panel?.tab_id === tab) herdr(["pane", "close", panel.pane_id]);
    return;
  }
  if (dismissedTabs().has(tab)) return; // closed here with q
  if (panel?.tab_id === tab) return;
  if (panel) rememberWidth(snap, panel);

  // Dock next to the focused agent pane, or the tab's first one.
  const target = agents.find((p) => p.pane_id === layout.focused_pane_id) || agents[0];

  let paneId = panel?.pane_id;
  if (!paneId) {
    const res = herdr(["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "panel",
      "--placement", "split", "--direction", "right", "--target-pane", target.pane_id, "--no-focus"]);
    paneId = res.json?.result?.plugin_pane?.pane?.pane_id;
    if (!paneId) return;
  }
  // Also sizes a freshly opened panel, since plugin.pane.open has no ratio.
  const moved = herdr(["pane", "move", paneId, "--tab", tab, "--split", "right", "--target-pane", target.pane_id,
    "--ratio", String(savedRatio()), "--no-focus"]);
  nudge(moved.json?.result?.move_result?.pane?.pane_id || paneId);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Docking narrows the agent pane after it printed at the wider width, and
// Claude Code doesn't re-lay-out old output, so lines get clipped. A manual
// resize makes it redraw everything, so do a one-column resize and back once
// the layout has settled.
function nudge(paneId) {
  sleep(400);
  herdr(["pane", "resize", "--pane", paneId, "--direction", "left", "--amount", "0.01"]);
  sleep(150);
  herdr(["pane", "resize", "--pane", paneId, "--direction", "right", "--amount", "0.01"]);
}

export function follow() {
  if (isHidden()) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // Focus events come in bursts; one runner at a time, re-running if more arrived.
  try {
    fs.mkdirSync(LOCK);
  } catch {
    try {
      if (Date.now() - fs.statSync(LOCK).mtimeMs < 10000) return fs.writeFileSync(AGAIN, "");
      fs.rmSync(LOCK, { recursive: true, force: true });
      fs.mkdirSync(LOCK);
    } catch {
      return;
    }
  }
  try {
    for (let i = 0; i < 5; i++) {
      fs.rmSync(AGAIN, { force: true });
      place();
      if (!fs.existsSync(AGAIN)) break;
    }
  } finally {
    fs.rmSync(LOCK, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) follow();
