#!/usr/bin/env bash
# Enable a Google-registered account as a driver (RCAB-E8.S15).
#
# Until launch, sign-in is Google-only and a first sign-in always registers a
# 'client'. An operator then runs this to turn that account into a driver:
#   * app_user.role      -> 'driver'
#   * driver row         -> inserted if missing (verified_at = now())
#   * client row        -> removed when the user has no rides as a passenger
#   * --vehicle-reg      -> optional starter vehicle (type auto, 3 seats) set as
#                           the current vehicle; the driver can edit it in the app
#
# Usage:
#   scripts/provision-driver.sh <email> [--vehicle-reg <reg>] [--dry-run]
#   scripts/provision-driver.sh <email> --database-url postgres://user:pw@host:5432/db
#
# Targets the dev compose postgres (docker compose exec) unless --database-url
# is given, in which case a host-side `psql` is used.
#
# Safe to re-run (idempotent). Refuses: unknown email, more than one account
# with that email, a suspended/deleted account, a vehicle reg already owned by
# another driver. --dry-run prints the plan and changes nothing.
#
# The role change reaches the driver app on its next token refresh: the API
# reads app_user.role from the database in POST /v1/auth/native/refresh and in
# the web refresh, so the driver taps Retry on the "Not registered as a driver
# yet" screen (or waits <= 15 min for the access token to expire). Already
# issued access tokens keep the old role claim until then.
set -euo pipefail

cd "$(dirname "$0")/.."

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }

EMAIL=""
VEHICLE_REG=""
DB_URL=""
DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --vehicle-reg)  VEHICLE_REG="${2:?--vehicle-reg needs a value}"; shift ;;
    --database-url) DB_URL="${2:?--database-url needs a value}"; shift ;;
    --dry-run)      DRY=1 ;;
    -h|--help)      usage; exit 0 ;;
    -*)             echo "unknown flag: $1" >&2; exit 2 ;;
    *)              [[ -z "$EMAIL" ]] || { echo "only one email allowed" >&2; exit 2; }
                    EMAIL="$1" ;;
  esac
  shift
done

if [[ -z "$EMAIL" ]]; then usage >&2; exit 2; fi
if [[ ! "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "[provision] not an email address: $EMAIL" >&2; exit 2
fi
if [[ -n "$VEHICLE_REG" && ! "$VEHICLE_REG" =~ ^[A-Za-z0-9\ -]{3,20}$ ]]; then
  echo "[provision] --vehicle-reg must be 3-20 letters, digits, spaces or dashes" >&2; exit 2
fi

if [[ -n "$DB_URL" ]]; then
  command -v psql >/dev/null || { echo "[provision] --database-url needs psql on this host" >&2; exit 1; }
  psql() { command psql "$DB_URL" -v ON_ERROR_STOP=1 -X "$@"; }
  TARGET="database-url"
else
  DC=(docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml)
  status=$("${DC[@]}" ps postgres --format '{{.Status}}' 2>/dev/null || true)
  case "$status" in
    *Up*) : ;;
    *) echo "[provision] postgres is not up (status: ${status:-none}). Run: pnpm dev:up" >&2; exit 1 ;;
  esac
  psql() { "${DC[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -X \
             -U "${POSTGRES_USER:-rcab}" -d "${POSTGRES_DB:-rcab}" "$@"; }
  TARGET="dev compose postgres"
fi

# Values travel as psql variables (:'name' quoting), never spliced into SQL.
rows=$(psql -At -F '|' -v email="$EMAIL" <<'SQL'
SELECT id, role, status,
       EXISTS (SELECT 1 FROM driver d WHERE d.user_id = u.id),
       EXISTS (SELECT 1 FROM client c WHERE c.user_id = u.id),
       EXISTS (SELECT 1 FROM rides r WHERE r.passenger_id = u.id)
  FROM app_user u
 WHERE lower(u.email) = lower(:'email');
SQL
)
count=$(printf '%s' "$rows" | grep -c . || true)
if [[ "$count" -eq 0 ]]; then
  echo "[provision] no account with email $EMAIL (the user must sign in with Google once first)" >&2; exit 1
fi
if [[ "$count" -gt 1 ]]; then
  echo "[provision] $count accounts share email $EMAIL; refusing to guess. Matching ids:" >&2
  printf '%s\n' "$rows" | cut -d'|' -f1 >&2; exit 1
fi
IFS='|' read -r UID_ ROLE STATUS HAS_DRIVER HAS_CLIENT HAS_RIDES <<<"$rows"
if [[ "$STATUS" != "active" ]]; then
  echo "[provision] account $UID_ is '$STATUS', not active; refusing" >&2; exit 1
fi

if [[ -n "$VEHICLE_REG" ]]; then
  owner=$(psql -At -v reg="$VEHICLE_REG" <<'SQL'
SELECT driver_id FROM vehicle WHERE reg_no = :'reg';
SQL
)
  if [[ -n "$owner" && "$owner" != "$UID_" ]]; then
    echo "[provision] vehicle reg $VEHICLE_REG already belongs to another driver ($owner); refusing" >&2; exit 1
  fi
fi

echo "[provision] target: $TARGET   account: $UID_ ($EMAIL)"
echo "[provision]   role:   $ROLE -> driver"
echo "[provision]   driver row: $([[ $HAS_DRIVER == t ]] && echo present || echo will insert)"
if [[ "$HAS_CLIENT" == t ]]; then
  echo "[provision]   client row: $([[ $HAS_RIDES == t ]] && echo 'kept (user has rides as a passenger)' || echo 'will remove')"
fi
[[ -z "$VEHICLE_REG" ]] || echo "[provision]   vehicle: $VEHICLE_REG (created if missing, set as current if none)"

if [[ "$DRY" == 1 ]]; then
  echo "[provision] dry run: nothing changed"; exit 0
fi

psql -q -v uid="$UID_" -v reg="$VEHICLE_REG" <<'SQL'
BEGIN;
UPDATE app_user SET role = 'driver', updated_at = now()
 WHERE id = :'uid' AND role <> 'driver';

INSERT INTO driver (user_id, verified_at, availability)
VALUES (:'uid', now(), 'offline')
ON CONFLICT (user_id) DO NOTHING;

DELETE FROM client c
 WHERE c.user_id = :'uid'
   AND NOT EXISTS (SELECT 1 FROM rides r WHERE r.passenger_id = c.user_id);

-- Optional starter vehicle; skipped when --vehicle-reg is empty.
INSERT INTO vehicle (id, driver_id, type, reg_no, make, model, color, seats, active)
SELECT gen_random_uuid(), :'uid', 'auto', :'reg', 'Unspecified', 'Unspecified', 'unspecified', 3, true
 WHERE :'reg' <> ''
ON CONFLICT (reg_no) DO NOTHING;

UPDATE driver SET current_vehicle_id = v.id, updated_at = now()
  FROM vehicle v
 WHERE driver.user_id = :'uid' AND driver.current_vehicle_id IS NULL
   AND :'reg' <> '' AND v.reg_no = :'reg' AND v.driver_id = :'uid';
COMMIT;
SQL

psql -P pager=off -v uid="$UID_" <<'SQL'
SELECT u.email, u.role, u.status, d.availability, d.verified_at IS NOT NULL AS verified,
       v.reg_no AS current_vehicle,
       EXISTS (SELECT 1 FROM client c WHERE c.user_id = u.id) AS has_client_row
  FROM app_user u
  LEFT JOIN driver d ON d.user_id = u.id
  LEFT JOIN vehicle v ON v.id = d.current_vehicle_id
 WHERE u.id = :'uid';
SQL
echo "[provision] done. The driver taps Retry in the app (token refresh) to pick up the new role."
