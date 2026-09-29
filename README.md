# agentpanel — a herdr plugin

A permanent side panel for the Claude Code or Codex session you're focused on. It docks on the right of the focused tab when
that tab runs Claude Code or Codex (tabs without it, like a shell or a browser, are left alone), follows you between tabs,
keeps the width you resize it to, and follows Claude's `←` agent view when you switch the terminal to another main
session. If the agent quits in its tab, the panel closes a few seconds later.

```
 Subagents ●1   Messages 211              jobee
 ───────────────────────────────────────────────
 ● you                                  15m ago
 give me estimation of verifier's progress
 ● Claude  $1                           15m ago
 Roughly 1.5 to 2 hours more, so it should be
 done by early afternoon if the Android suite…
```

Switch tabs with a click on the tab bar, `←` / `→`, `Tab`, or `1` / `2` / `3` / `4`. In a narrow panel the tab names shorten
to `A`, `M`, `R` and `D`.

## Install

Needs herdr 0.8.2 or later and Node.js on macOS or Linux.

```sh
herdr plugin install flowy11/agentpanel
```

The Claude Code hooks below are optional. They only print text, so you can register them from the installed
checkout (`ls -d ~/.config/herdr/plugins/github/*agentpanel*`) or copy them somewhere stable such as
`~/.claude/hooks/` first; `<agentpanel>` below stands for that folder.

## Subagents

- **●** running (time since start) · **◌** stalled: still marked running but silent for 5+ minutes
- **✓** done · **✗** failed · **⊘** killed (time since it stopped)
- `↳` the tool call it's on right now

Click or Enter switches Claude to that subagent's view, like picking it in Claude's own agent list (you can message
it there). Claude only lists running and recent subagents, so for finished ones the panel shows the conversation
itself instead: the task, its messages, every tool call with ✓/✗, and the final report (`v` opens this view directly;
Esc goes back, `z` zooms the panel). `m` switches Claude back to main; Space shows its recent tool calls and latest message; `a` toggles between all
subagents and the last 30 minutes. Switching drives Claude's agent list with keystrokes, checking the screen after
each one; it never sends Esc unless that list has focus, and does nothing during a permission prompt.

## Messages

Every message in the conversation, yours (blue ●) and Claude's (orange ●), newest at the bottom. Claude often sends
several messages in a row while it works; each is listed on its own. A header line shows who, when, and for Claude's
messages what the tool calls that followed it did ("2 edits · 4 cmds · 1 failed", or `✎2 $4 ✗1` when the panel is
too narrow for words); below it, the message uses the
full width of the panel for up to 3 lines. Tool calls Claude makes before saying anything show as "N tool calls". The
tab's count is the messages you sent. Click or Enter shows one in full in a popup over the terminal: the whole text
with light Markdown styling, when it was sent, and every tool call that followed it (`j`/`k` or the wheel scroll,
`←`/`→` step to the previous or next message, `y` copies it, Esc closes). Space expands it in the panel instead.

## Refs

The URLs and local files Claude mentions in its messages, like a plan it wants you to review or a page it points
you to, so you can open them without hunting through the reply. They're grouped under the message that mentions
them, newest first, with each one listed once, under its latest mention. Your own messages and Claude's tool calls
aren't scanned; this is what Claude told you about. **✎** marks files Claude edited; files that aren't on disk
(examples, typos, deleted since) are dimmed with **?**; folders end in `/`. Paths show relative to the session's
folder.

Click or Enter opens one through the File Viewer plugin: a file in its popup (at the line, if one was
mentioned), a page in its browser tab. Without File Viewer, or for a folder, it opens in the system's default app.
`y` copies the full URL or path, Space shows it in full, and a click on a group's header (●) shows that message in
full.

## To do

Everything Claude says you still have to do in this session, so a request doesn't get lost when more messages
scroll it away: review a plan, run a command, restart something, answer a question. Claude keeps this list itself:
whenever it changes, Claude ends its message with the complete current list, older requests that are still open
included and finished ones left out, and the panel shows that latest list (`ACTION: none` empties it). The header
says how old the list is, each item when Claude first asked for it, and the tab how many are open (**○2**). `x`
checks one off in the panel (remembered per session, for things you did without telling Claude), click or Enter
shows the message where Claude first asked, and `y` copies it (just the command, if it has one in backticks).

Claude writes the list as lines like `ACTION: Review the plan in docs/plan.md`. The included `SessionStart` hook
asks it to, in every project; register it in `~/.claude/settings.json` (it applies to sessions started, resumed
or cleared after that):

```json
"hooks": {
  "SessionStart": [
    { "hooks": [{ "type": "command", "command": "<agentpanel>/hooks/session-start.sh", "timeout": 5 }] }
  ]
}
```

## Keys

| Key | Action |
| --- | --- |
| `←` / `→`, `Tab`, `1`–`4`, click | Switch tabs |
| `j` / `k`, wheel | Move |
| Enter / click | Messages: show in full (popup) · Subagents: open in Claude · Refs: open |
| Space | Expand details |
| `m` | Subagents: back to main |
| `y` | Refs: copy the URL or path · To do: copy the request |
| `x` | To do: check off or reopen |
| `f` / click the header | Subagents: fold or unfold the Finished section |
| `q` | Close it in this tab; it still follows you to other Claude tabs. The **agentpanel: show / hide** action brings it back here |

Data comes from Claude Code's own files: the session transcript, each subagent's transcript under
`<session>/subagents/`, and the `<task-notification>` entries marking when subagents stop.

## Progress bars

Subagents that write `PROGRESS: 3/7 · <step>` (or `40% · <step>`) in their messages get a progress bar in the
Subagents tab. To ask every subagent to do this, in every project and for built-in and future agents alike, register
the included `SubagentStart` hook in `~/.claude/settings.json`; it adds the instruction to each subagent's context:

```json
"hooks": {
  "SubagentStart": [
    { "hooks": [{ "type": "command", "command": "<agentpanel>/hooks/subagent-start.sh", "timeout": 5 }] }
  ]
}
```

Sonnet and Opus follow it reliably; Haiku tends to skip it.

## Codex

Codex sessions use the same Messages, Refs, and To do tabs, with Codex labels and
message popups. The panel reads local rollouts from `$CODEX_HOME/sessions`
(default `~/.codex/sessions`) and `archived_sessions`, using the exact session ID
reported by herdr. It does not guess between conversations in the same folder.
Messages and tool results update as the rollout grows; internal instructions,
reasoning, and duplicate event messages are excluded.

Codex child rollouts linked by parent thread ID (or a recorded `spawn_agent`
result) appear under Subagents. Enter/click opens their conversation in the
panel; Esc returns to the list. Claude's terminal agent-switching shortcuts are
only used for Claude panes. Progress bars work when a child writes `PROGRESS:`.
Child threads need local rollout files to be visible.

The To do tab reads explicit `ACTION:` lines for both providers. The supplied
SessionStart hook is Claude-specific. For Codex, add this instruction to your
project's `AGENTS.md` if you want the agent to maintain the list:

> Whenever the user's required next steps change, end your message with the
> complete current list, one `ACTION: <step>` per line. Keep unfinished items,
> omit completed items, and write `ACTION: none` when the list is empty.
> Only include things the user needs to do, not your own work.

## Development

Link a local checkout instead of installing from GitHub:

```sh
herdr plugin link /path/to/agentpanel --enabled
```

Run the provider regression tests with `node --test test/*.test.mjs`.
