#!/usr/bin/env bash
# PostToolUse hook for Edit and Write: flags the code graph stale when a source
# file under apps/**|packages/** changes, so /code-graph knows to regenerate.
#
# Touches codegraph/.stale (gitignored) and emits a systemMessage. Never blocks.
# Exit 0 always.

set -uo pipefail

PAYLOAD="$(cat)"

TOOL_NAME="$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // ""')"
if [[ "$TOOL_NAME" != "Edit" && "$TOOL_NAME" != "Write" ]]; then
  exit 0
fi

FILE_PATH="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.file_path // ""')"
[[ -z "$FILE_PATH" ]] && exit 0

REPO_ROOT="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // ""')"
[[ -z "$REPO_ROOT" ]] && REPO_ROOT="$(pwd)"

REL_PATH="${FILE_PATH#"$REPO_ROOT/"}"

# Only product source (TS in apps/api|web + packages, Dart in driver-app) affects
# the graph. Ignore edits to the graph artifact, scripts, docs, config.
SOURCE_REGEX='^(apps/(api|web)/src/.+\.(ts|tsx)|apps/driver-app/lib/.+\.dart|packages/[^/]+/src/.+\.ts)$'
if ! printf '%s' "$REL_PATH" | grep -qE "$SOURCE_REGEX"; then
  exit 0
fi

touch "$REPO_ROOT/codegraph/.stale" 2>/dev/null || exit 0

jq -n --arg f "$REL_PATH" \
  '{"systemMessage": ("code graph marked stale (" + $f + " changed) — run `pnpm code:graph` to refresh codegraph/graph.json")}'

exit 0
