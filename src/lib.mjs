import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "agentpanel";
export const LABEL = "agentpanel";
export const OLD_LABELS = ["Subagents", "Agent Panel"]; // earlier name, closed if still open
export const SIDE_RATIO = 0.78; // share of the tab the agent keeps
export const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || path.join(os.homedir(), ".local/state/herdr-agentpanel");
export const HIDDEN = path.join(STATE_DIR, "hidden");

// Other plugins' panels; never dock next to these or track them as the agent.
export const PLUGIN_LABELS = new Set([LABEL, ...OLD_LABELS, "File Viewer", "English Coach", "Annotate", "Comment"]);

export const herdr = (args) => {
  const res = spawnSync(process.env.HERDR_BIN_PATH || "herdr", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch {}
  return { ok: res.status === 0, json, stdout: res.stdout || "", stderr: (res.stderr || "").trim() };
};

export const snapshot = () => herdr(["api", "snapshot"]).json?.result?.snapshot || null;

// A pane running a supported agent session (not one of the plugin panels).
export const isAgentPane = (p) => !!p && !PLUGIN_LABELS.has(p.label) && ["claude", "codex"].includes(p.agent);
export const isHidden = () => fs.existsSync(HIDDEN);

// Tabs the panel was closed in (q): it stays out of those until shown there again.
const DISMISSED = path.join(STATE_DIR, "dismissed.json");
export function dismissedTabs() {
  try { return new Set(JSON.parse(fs.readFileSync(DISMISSED, "utf8"))); } catch { return new Set(); }
}
export function setDismissed(tabId, on, liveTabs = null) {
  const tabs = dismissedTabs();
  if (on) tabs.add(tabId); else tabs.delete(tabId);
  // Forget tabs that no longer exist, so a reused tab id starts fresh.
  if (liveTabs) for (const t of tabs) if (!liveTabs.has(t)) tabs.delete(t);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(DISMISSED, JSON.stringify([...tabs]));
}

// After a herdr restart, panels come back as plain shells that keep their label,
// so a pane only counts if it is actually running this plugin's panel.
const PANEL_SCRIPT = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), "src", "panel.mjs");
export function isLive(paneId) {
  const info = herdr(["pane", "process-info", "--pane", paneId]).json?.result?.process_info;
  return (info?.foreground_processes || []).some((p) => (p.cmdline || "").includes(PANEL_SCRIPT));
}

// Our live panels; dead leftovers with our label are closed.
export function livePanels(snap) {
  return (snap?.panes || []).filter((p) => {
    if (p.label !== LABEL) return false;
    if (isLive(p.pane_id)) return true;
    herdr(["pane", "close", p.pane_id]);
    return false;
  });
}

