#!/usr/bin/env bash
# deploy.sh — deploy one immutable release (a commit SHA) and prove it is live.
# RCAB-E8.S11 (review finding F14, guide R11). Runs from Jenkins OR a laptop.
#
# Two layers in one file so it can be piped over SSH without a checkout on the VPS:
#
#   controller (default)   runs where you are. Optionally `--remote user@host`, in
#                          which case the host layer is executed over SSH by piping
#                          this very file to `bash -s`. Orchestrates:
#                            record previous -> host apply -> verify-release.sh
#                            -> on any failure: automatic rollback to previous.
#   host layer (--on-host) runs where Docker is. Actions:
#                            current | previous | apply --version V [--rollback]
#
# Host `apply` (nothing changes on the running stack until step 3):
#   1. docker compose pull api web          (exact tag RCAB_VERSION=V; no building)
#   2. one-shot migrator (api image, compiled dist/migrate.js, advisory-locked)
#   3. write RCAB_VERSION=V (+ RCAB_PREVIOUS_VERSION=<old>) into the env file
#   4. docker compose up -d --no-deps --wait api web, then reload nginx
# `--rollback` skips step 2: migrations are never reversed automatically, so the
# schema must be compatible with both versions (see scripts/deploy/README.md).
#
# Exit codes (controller): 0 released+verified | 1 failed, no rollback attempted
#   | 2 aborted before cutover, running stack untouched | 10 failed, rolled back
#   and previous version verified | 11 failed AND rollback failed (page the owner).
set -euo pipefail

# Paths are only meaningful in controller mode: when the host layer is piped to
# `bash -s` over SSH there is no script file (BASH_SOURCE is empty).
SELF=""; SELF_DIR=""; REPO_ROOT=""
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SELF="${SELF_DIR}/$(basename "${BASH_SOURCE[0]}")"
  REPO_ROOT="$(cd "${SELF_DIR}/../.." && pwd)"
fi

log() { printf '[deploy] %s\n' "$*" >&2; }
die() { printf '[deploy] ERROR: %s\n' "$1" >&2; exit "${2:-1}"; }

valid_version() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; }

# ------------------------------------------------------------------ host layer
get_kv() { # file key
  [[ -f "$1" ]] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n1
}

set_kv() { # file key value  (replace-or-append, keeps mode, swaps in via mv)
  local f="$1" k="$2" v="$3" tmp
  mkdir -p "$(dirname "$f")"
  if [[ ! -f "$f" ]]; then (umask 077; : > "$f"); fi
  tmp="$(mktemp "${f}.XXXXXX")"
  cp -p "$f" "$tmp"
  awk -v k="$k" -v v="$v" '
    index($0, k "=") == 1 { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$f" > "$tmp"
  mv "$tmp" "$f"
}

host_main() {
  local action="${1:-}"; shift || true
  local compose_dir="/opt/rcab/infra/docker" env_file="/opt/rcab/compose/.env"
  local project="" pull=1 version="" rollback=0
  local files=()
  while (( $# )); do
    case "$1" in
      --compose-dir) compose_dir="$2"; shift 2 ;;
      --env-file) env_file="$2"; shift 2 ;;
      --compose-file) files+=("$2"); shift 2 ;;
      --project) project="$2"; shift 2 ;;
      --no-pull) pull=0; shift ;;
      --version) version="$2"; shift 2 ;;
      --rollback) rollback=1; shift ;;
      *) die "host layer: unknown argument $1" ;;
    esac
  done
  if (( ${#files[@]} == 0 )); then files=("docker-compose.prod.yml"); fi

  case "${action}" in
    current) get_kv "${env_file}" RCAB_VERSION; return 0 ;;
    previous) get_kv "${env_file}" RCAB_PREVIOUS_VERSION; return 0 ;;
    apply) ;;
    *) die "host layer: unknown action '${action}'" ;;
  esac

  [[ -n "${version}" ]] || die "apply needs --version"
  valid_version "${version}" || die "refusing invalid version '${version}'"
  [[ -d "${compose_dir}" ]] || die "compose dir ${compose_dir} not found (bootstrap the host or use --sync-infra)"

  dc() {
    local args=(compose --project-directory "${compose_dir}" --env-file "${env_file}")
    if [[ -n "${project}" ]]; then args+=(-p "${project}"); fi
    local f
    for f in "${files[@]}"; do args+=(-f "${compose_dir}/${f}"); done
    docker "${args[@]}" "$@" </dev/null
  }

  local current
  current="$(get_kv "${env_file}" RCAB_VERSION)"
  log "host: current=${current:-<none>} target=${version} rollback=${rollback}"

  # A process-env value beats --env-file in Compose, so pull/migrate run against
  # the target tag while the env file (the source of truth) is still untouched.
  export RCAB_VERSION="${version}"

  if (( pull )); then
    log "host: pulling images for ${version}"
    if ! dc pull --quiet api web; then
      if (( rollback )); then
        # Registry unreachable / tag pruned: acceptable only if both images are already local.
        local img missing=0
        while read -r img; do
          [[ "${img}" == *"/rcab-api:"* || "${img}" == *"/rcab-web:"* ]] || continue
          docker image inspect "${img}" >/dev/null 2>&1 || { log "host: image ${img} not present locally"; missing=1; }
        done < <(dc config --images)
        (( missing == 0 )) || die "pull failed and images for ${version} are not cached locally"
        log "host: pull failed but images are cached locally; continuing rollback"
      else
        die "image pull failed for ${version}; running stack untouched"
      fi
    fi
  fi

  if (( rollback )); then
    log "host: rollback — NOT running migrations (schema must be compatible with ${version})"
  else
    log "host: running one-shot migrator (${version})"
    dc run --rm -T migrator || die "migration failed; running stack untouched"
  fi

  # Cutover begins here.
  if [[ "${current}" != "${version}" && -n "${current}" ]]; then
    set_kv "${env_file}" RCAB_PREVIOUS_VERSION "${current}"
  fi
  set_kv "${env_file}" RCAB_VERSION "${version}"

  log "host: starting api + web ${version}"
  dc up -d --no-deps --wait --wait-timeout 180 api web \
    || die "api/web did not become healthy at ${version}"

  if [[ -n "$(dc ps -q --status running nginx 2>/dev/null || true)" ]]; then
    # nginx resolves the api/web upstreams once at start; re-resolve after recreate.
    dc exec -T nginx nginx -s reload || die "nginx reload failed"
    log "host: nginx reloaded"
  else
    log "host: nginx not running; starting it"
    dc up -d --no-deps nginx || die "nginx failed to start"
  fi
  log "host: DONE RCAB_VERSION=${version} RCAB_PREVIOUS_VERSION=$(get_kv "${env_file}" RCAB_PREVIOUS_VERSION)"
}

# ------------------------------------------------------------ controller layer
usage() {
  cat >&2 <<'USAGE'
usage: deploy.sh --version SHA --api-url URL [options]
       rollback.sh (--previous | --to SHA) --api-url URL [options]

target
  --remote USER@HOST     run the host layer over SSH (default: this machine's Docker)
  --ssh-key FILE         private key for --remote
  --known-hosts FILE     pinned host keys (StrictHostKeyChecking=yes is always on)
  --infra-dir DIR        remote tree holding docker/ and observability/ (default /opt/rcab/infra)
  --sync-infra           tar ./infra/{docker,observability} to --infra-dir before deploying
  --compose-dir DIR      compose directory on the host (default <infra-dir>/docker)
  --env-file FILE        compose env file on the host (default /opt/rcab/compose/.env)
  --compose-file NAME    compose file inside --compose-dir (repeatable; default docker-compose.prod.yml)
  --project NAME         compose project name (-p)
  --no-pull              do not docker compose pull (images already local; local rehearsal)
verification (required: probe the real target, never localhost by default)
  --api-url URL  --web-url URL  --host-header H  --web-host-header H  --insecure  --timeout S
other
  --no-auto-rollback     do not roll back automatically when verification fails
USAGE
  exit 2
}

controller_main() {
  local version="" to="" previous=0 rollback=0 auto=1 sync=0
  local remote="" ssh_key="" known_hosts="" infra_dir="/opt/rcab/infra" compose_dir="" env_file=""
  local api_url="" web_url="" host_header="" web_host_header="" insecure=0 timeout=120
  local host_args=() compose_files=() project="" no_pull=0

  while (( $# )); do
    case "$1" in
      --version) version="${2:-}"; shift 2 ;;
      --rollback) rollback=1; shift ;;
      --to) to="${2:-}"; shift 2 ;;
      --previous) previous=1; shift ;;
      --remote) remote="${2:-}"; shift 2 ;;
      --ssh-key) ssh_key="${2:-}"; shift 2 ;;
      --known-hosts) known_hosts="${2:-}"; shift 2 ;;
      --infra-dir) infra_dir="${2:-}"; shift 2 ;;
      --sync-infra) sync=1; shift ;;
      --compose-dir) compose_dir="${2:-}"; shift 2 ;;
      --env-file) env_file="${2:-}"; shift 2 ;;
      --compose-file) compose_files+=("${2:-}"); shift 2 ;;
      --project) project="${2:-}"; shift 2 ;;
      --no-pull) no_pull=1; shift ;;
      --api-url) api_url="${2:-}"; shift 2 ;;
      --web-url) web_url="${2:-}"; shift 2 ;;
      --host-header) host_header="${2:-}"; shift 2 ;;
      --web-host-header) web_host_header="${2:-}"; shift 2 ;;
      --insecure) insecure=1; shift ;;
      --timeout) timeout="${2:-}"; shift 2 ;;
      --no-auto-rollback) auto=0; shift ;;
      -h|--help) usage ;;
      *) log "unknown argument: $1"; usage ;;
    esac
  done
  [[ -n "${api_url}" ]] || { log "--api-url is required (the pipeline must probe the real target)"; usage; }
  if [[ -n "${remote}" ]]; then
    # F14: after SSH returns, a loopback URL points at the CI executor, not the VPS.
    case "${api_url}${web_url}" in
      *://localhost*|*://127.*|*://\[::1\]*|*://0.0.0.0*)
        die "--remote deploys must verify the real host, not a loopback URL (${api_url})" 2 ;;
    esac
  fi
  if (( rollback )); then
    [[ -n "${to}" || ${previous} -eq 1 ]] || { log "rollback needs --previous or --to SHA"; usage; }
  else
    [[ -n "${version}" ]] || { log "--version is required"; usage; }
    valid_version "${version}" || die "invalid version '${version}'" 2
  fi

  [[ -n "${compose_dir}" ]] || compose_dir="${infra_dir}/docker"
  host_args+=(--compose-dir "${compose_dir}")
  [[ -z "${env_file}" ]] || host_args+=(--env-file "${env_file}")
  [[ -z "${project}" ]] || host_args+=(--project "${project}")
  (( no_pull == 0 )) || host_args+=(--no-pull)
  local f
  for f in ${compose_files[@]+"${compose_files[@]}"}; do host_args+=(--compose-file "${f}"); done

  local ssh_opts=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o ConnectTimeout=15)
  [[ -z "${ssh_key}" ]] || ssh_opts+=(-i "${ssh_key}")
  [[ -z "${known_hosts}" ]] || ssh_opts+=(-o "UserKnownHostsFile=${known_hosts}")

  host_run() { # <action> [args...]
    if [[ -n "${remote}" ]]; then
      # shellcheck disable=SC2029  # client-side expansion into the remote command line is intended
      ssh "${ssh_opts[@]}" "${remote}" "bash -s -- --on-host $(printf '%q ' "$@")" < "${SELF}"
    else
      bash "${SELF}" --on-host "$@"
    fi
  }

  verify() { # <expected-version>
    local v=(--api-url "${api_url}" --expect-version "$1" --timeout "${timeout}")
    [[ -z "${web_url}" ]] || v+=(--web-url "${web_url}")
    [[ -z "${host_header}" ]] || v+=(--host-header "${host_header}")
    [[ -z "${web_host_header}" ]] || v+=(--web-host-header "${web_host_header}")
    (( insecure == 0 )) || v+=(--insecure)
    bash "${SELF_DIR}/verify-release.sh" "${v[@]}"
  }

  # Options replayed to rollback.sh when verification fails.
  local replay=(--api-url "${api_url}" --timeout "${timeout}" --compose-dir "${compose_dir}")
  [[ -z "${remote}" ]] || replay+=(--remote "${remote}")
  [[ -z "${ssh_key}" ]] || replay+=(--ssh-key "${ssh_key}")
  [[ -z "${known_hosts}" ]] || replay+=(--known-hosts "${known_hosts}")
  [[ -z "${env_file}" ]] || replay+=(--env-file "${env_file}")
  [[ -z "${project}" ]] || replay+=(--project "${project}")
  (( no_pull == 0 )) || replay+=(--no-pull)
  [[ -z "${web_url}" ]] || replay+=(--web-url "${web_url}")
  [[ -z "${host_header}" ]] || replay+=(--host-header "${host_header}")
  [[ -z "${web_host_header}" ]] || replay+=(--web-host-header "${web_host_header}")
  (( insecure == 0 )) || replay+=(--insecure)
  for f in ${compose_files[@]+"${compose_files[@]}"}; do replay+=(--compose-file "${f}"); done

  # ---- rollback mode -------------------------------------------------------
  if (( rollback )); then
    local target="${to}"
    if [[ -z "${target}" ]]; then
      target="$(host_run previous "${host_args[@]}")" || die "could not read the previous version from the host"
      [[ -n "${target}" ]] || die "host has no recorded RCAB_PREVIOUS_VERSION; pass --to SHA"
    fi
    valid_version "${target}" || die "invalid rollback target '${target}'" 2
    log "ROLLBACK to ${target}"
    host_run apply --version "${target}" --rollback "${host_args[@]}" || die "rollback apply failed" 11
    verify "${target}" || die "rollback applied but ${target} did not verify" 11
    log "rollback to ${target} verified"
    return 0
  fi

  # ---- release mode --------------------------------------------------------
  if (( sync )); then
    [[ -n "${remote}" ]] || die "--sync-infra only makes sense with --remote" 2
    log "syncing infra/ to ${remote}:${infra_dir}"
    # shellcheck disable=SC2029
    COPYFILE_DISABLE=1 tar -C "${REPO_ROOT}/infra" -cf - docker observability \
      | ssh "${ssh_opts[@]}" "${remote}" "mkdir -p $(printf '%q' "${infra_dir}") && tar -C $(printf '%q' "${infra_dir}") -xf -" \
      || die "infra sync failed; running stack untouched" 2
  fi

  local prev
  prev="$(host_run current "${host_args[@]}")" || die "could not read the current version from the host" 2
  log "RELEASE ${version} (currently running: ${prev:-<none>})"
  if [[ "${prev}" == "${version}" ]]; then log "version already recorded as current; re-applying"; fi

  local apply_ok=1
  host_run apply --version "${version}" "${host_args[@]}" || apply_ok=0

  if (( apply_ok )); then
    if verify "${version}"; then
      log "release ${version} verified (previous: ${prev:-<none>})"
      return 0
    fi
    log "VERIFICATION FAILED for ${version}"
  else
    local now
    now="$(host_run current "${host_args[@]}" 2>/dev/null || true)"
    if [[ "${now}" == "${prev}" ]]; then
      die "release aborted before cutover (pull/migrate failed); running stack still on ${prev:-<none>}" 2
    fi
    log "APPLY FAILED after cutover began (host now records ${now:-<none>})"
  fi

  if (( auto == 0 )); then die "release failed; automatic rollback disabled; previous version was ${prev:-<none>}" 1; fi
  if [[ -z "${prev}" || "${prev}" == "${version}" ]]; then
    die "release failed and there is no earlier version to roll back to; manual intervention required" 11
  fi
  log "AUTOMATIC ROLLBACK to ${prev}"
  if bash "${SELF_DIR}/rollback.sh" --to "${prev}" "${replay[@]}"; then
    die "release ${version} FAILED; rolled back to ${prev} and verified" 10
  fi
  die "release ${version} FAILED and rollback to ${prev} ALSO FAILED; stack state unknown" 11
}

if [[ "${1:-}" == "--on-host" ]]; then
  shift
  host_main "$@"
else
  controller_main "$@"
fi
exit $?
