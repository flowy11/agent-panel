#!/bin/sh
# Launcher: herdr runs commands without a shell profile, so find node ourselves.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)

node_bin=$(command -v node 2>/dev/null || true)
if [ -z "$node_bin" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.volta/bin/node" \
    "$HOME/.local/share/fnm/aliases/default/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$candidate" ] && node_bin=$candidate
  done
fi
if [ -z "$node_bin" ]; then
  echo "agent-panel: node not found" >&2
  exit 1
fi

cmd=${1:-}
[ $# -gt 0 ] && shift
exec "$node_bin" "$root/src/$cmd.mjs" "$@"
