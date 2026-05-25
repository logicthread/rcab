#!/usr/bin/env bash
# PostToolUse hook for Edit and Write: warns if a vault .md file is saved with
# [[wiki-links]] that don't resolve to any .md file in the vault.
#
# Fires immediately after each edit — catches dangling links in-flight rather
# than at close-story time.
#
# Output: JSON { "systemMessage": "..." } if dangling links found, nothing otherwise.
# Exit 0 always — this hook never blocks.

set -uo pipefail

PAYLOAD="$(cat)"

TOOL_NAME="$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // ""')"
if [[ "$TOOL_NAME" != "Edit" && "$TOOL_NAME" != "Write" ]]; then
  exit 0
fi

FILE_PATH="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.file_path // ""')"
if [[ "$FILE_PATH" != *.md ]]; then
  exit 0
fi

REPO_ROOT="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // ""')"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(pwd)"
fi

REL_PATH="${FILE_PATH#"$REPO_ROOT/"}"

VAULT_PREFIXES_REGEX='^(00-index|10-product|20-architecture|30-domain|40-backend|50-clients|60-integrations|70-algorithms|80-infrastructure|90-quality|95-delivery|99-decisions|\.obsidian)/'
if ! printf '%s' "$REL_PATH" | grep -qE "$VAULT_PREFIXES_REGEX"; then
  exit 0
fi

if [[ ! -f "$FILE_PATH" ]]; then
  exit 0
fi

SLUGS="$(grep -oE '\[\[[^]]+\]\]' "$FILE_PATH" | sed 's/\[\[//;s/\]\]//' | sort -u)"
if [[ -z "$SLUGS" ]]; then
  exit 0
fi

DANGLING=()
while IFS= read -r slug; do
  [[ -z "$slug" ]] && continue
  FOUND="$(find "$REPO_ROOT" \
    \( -path "$REPO_ROOT/node_modules" -o -path "$REPO_ROOT/.git" \) -prune \
    -o -name "${slug}.md" -print 2>/dev/null | head -1)"
  if [[ -z "$FOUND" ]]; then
    DANGLING+=("[[${slug}]]")
  fi
done <<< "$SLUGS"

if [[ ${#DANGLING[@]} -eq 0 ]]; then
  exit 0
fi

LIST="$(printf '  • %s\n' "${DANGLING[@]}")"
jq -n --arg msg "⚠ Dangling vault links in ${REL_PATH}:
${LIST}

Each [[slug]] must resolve to a <slug>.md file in the vault. Add a stub note or fix the slug before committing." \
  '{"systemMessage": $msg}'

exit 0
