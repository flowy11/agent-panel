import { Session, latestSession, readConversation as readClaudeConversation } from "./claude.mjs";
import { CodexSession, readCodexConversation } from "./codex.mjs";
import { resolveSession } from "./sessions.mjs";

export function createSession(id, provider = "claude") {
  return provider === "codex" ? new CodexSession(id) : new Session(latestSession(id));
}
export function paneSession(pane, onResolved) {
  const id = pane.agent_session?.value;
  return pane.agent === "codex" ? id : latestSession(resolveSession(pane, onResolved) || id);
}
export function readConversation(file, provider = "claude") {
  return provider === "codex" ? readCodexConversation(file) : readClaudeConversation(file);
}
