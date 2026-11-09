#!/usr/bin/env bash
# rollback.sh — put a previously deployed release back and verify it.
#
#   rollback.sh --previous  --api-url https://api.example.com [target options]
#   rollback.sh --to <sha>  --api-url https://api.example.com [target options]
#
# `--previous` uses RCAB_PREVIOUS_VERSION recorded on the host by deploy.sh. The
# images must still exist in the registry or in the host's local image cache.
# Migrations are NOT reversed (and not re-run): only roll back across a schema that
# both versions accept. Same options as deploy.sh; see `deploy.sh --help`.
set -euo pipefail
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy.sh" --rollback "$@"
