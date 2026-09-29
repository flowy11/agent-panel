#!/bin/sh
# Claude Code SubagentStart hook: asks every subagent to report its progress in a
# form the herdr Agent Panel shows as a progress bar.
cat >/dev/null # hook input on stdin, not needed
cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"Progress reporting (required; a status panel shows it to the user): whenever you start a new step of your task, begin that message with one line of plain text before any tool call: `PROGRESS: <step number>/<total steps> · <what this step does>`, for example `PROGRESS: 2/5 · Running the iOS test suite`. Write it as visible text in the same message as the tool call, not only in your thinking. Update the total if your plan changes. Skip it only when the whole task is a single action."}}
JSON
