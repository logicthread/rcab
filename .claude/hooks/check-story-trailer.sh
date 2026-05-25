#!/usr/bin/env bash
# PreToolUse hook for Bash: blocks `git commit` if the message lacks a
# `Story: RCAB-Ex.Sy` trailer AND the staged changes touch any non-vault path.
#
# Vault-only commits (e.g. tidying notes) may omit the trailer. Anything that
# touches code, infra, scripts, root configs, etc. must carry the trailer.
#
# Communicates with Claude Code via JSON on stdin/stdout per the PreToolUse
# hook protocol. Exit 0 always — decision lives in the JSON.

set -uo pipefail

# Read the full hook payload from stdin.
PAYLOAD="$(cat)"

# We only care about Bash tool calls.
TOOL_NAME="$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // ""')"
if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

CMD="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // ""')"

# Only act on `git commit` (not git log, git status, etc.). Match the word
# boundary so `commits` or `commit-msg` don't trigger.
if ! printf '%s' "$CMD" | grep -qE '(^|[[:space:]&;|])git[[:space:]]+commit([[:space:]]|$)'; then
  exit 0
fi

# Allow trailer scan to find the pattern anywhere in the command — covers
# -m "...", -m '...', and HEREDOC ($(cat <<'EOF' ... EOF)) forms.
if printf '%s' "$CMD" | grep -qE 'Story:[[:space:]]*RCAB-E[0-9]+\.S[0-9]+'; then
  exit 0
fi

# No trailer in the command. Check whether the staged changes are vault-only.
# `git -C <repo>` so the script works regardless of caller cwd.
REPO_ROOT="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // ""')"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(pwd)"
fi

STAGED="$(git -C "$REPO_ROOT" diff --cached --name-only 2>/dev/null || true)"

# If nothing is staged, this is probably `git commit --amend` or similar —
# let it through; the developer is in a non-default flow.
if [[ -z "$STAGED" ]]; then
  exit 0
fi

# Vault folders (exact prefixes that may appear in `git diff --name-only`).
VAULT_PREFIXES_REGEX='^(00-index|10-product|20-architecture|30-domain|40-backend|50-clients|60-integrations|70-algorithms|80-infrastructure|90-quality|95-delivery|99-decisions|\.obsidian)/'

# Find any staged path that is NOT under a vault folder.
NON_VAULT="$(printf '%s\n' "$STAGED" | grep -vE "$VAULT_PREFIXES_REGEX" || true)"

if [[ -z "$NON_VAULT" ]]; then
  # Vault-only commit; trailer not required.
  exit 0
fi

# Block. Emit a JSON response per the PreToolUse hook protocol.
NON_VAULT_LIST="$(printf '%s\n' "$NON_VAULT" | head -10 | sed 's/^/  - /')"
REASON="$(cat <<EOF
This commit touches non-vault paths but the message has no \`Story: RCAB-Ex.Sy\` trailer.

Non-vault paths in the staged changes:
$NON_VAULT_LIST

Per 95-delivery/commit-story-linkage.md, every commit related to a story must
carry a \`Story: RCAB-Ex.Sy\` trailer in the message body. Add it (using a
HEREDOC for multi-line messages) and re-run.

If this commit is genuinely not story work (rare for non-vault changes), pass
\`SKIP_STORY_TRAILER=1\` in the bash command — or commit it as a vault-only PR.
EOF
)"

# Escape hatch for legitimate trailer-less commits on non-vault paths.
if printf '%s' "$CMD" | grep -qE '(^|[[:space:]])SKIP_STORY_TRAILER=1'; then
  exit 0
fi

jq -n --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
