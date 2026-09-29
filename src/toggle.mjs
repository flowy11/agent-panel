// Action entry: hide the panel (it stops following you) or show it again. In a tab
// it was closed in with q, this brings it back to that tab.
import fs from "node:fs";
import { HIDDEN, LABEL, STATE_DIR, dismissedTabs, herdr, isHidden, setDismissed, snapshot } from "./lib.mjs";
import { follow } from "./follow.mjs";

fs.mkdirSync(STATE_DIR, { recursive: true });
const snap = snapshot();
const tab = snap?.focused_tab_id;
if (isHidden() || dismissedTabs().has(tab)) {
  fs.rmSync(HIDDEN, { force: true });
  if (tab) setDismissed(tab, false);
  follow();
} else {
  fs.writeFileSync(HIDDEN, new Date().toISOString());
  for (const p of (snap?.panes || []).filter((p) => p.label === LABEL)) herdr(["pane", "close", p.pane_id]);
}
