#!/usr/bin/env bash
# Record the driver-app onboarding videos (RCAB-E8.S14) — TEST-HARNESS ONLY.
#
#   scripts/demo/record-driver.sh            # all scenes D01..D08
#   scripts/demo/record-driver.sh D04 D06    # just these
#   KEEP_EMULATOR=1 scripts/demo/record-driver.sh D05   # leave the emulator running afterwards
#
# Needs: the dev stack up (`pnpm dev:up`, migrated), Flutter, the Android SDK with the AVD
# "Small_Phone" (override AVD=…), ffmpeg, Node ≥ 20. The emulator is booted if none is attached.
#
# Per scene it: resets the Area-B fixture users and mints an ordinary session for the scene's
# driver (apps/driver-app/integration_test/demo/host/session.mjs), starts the host director
# (host/director.mjs: screen recorder, GPS, permission dialog, simulated passengers), runs the
# on-device scene (integration_test/demo/dNN_*_test.dart) with the session as --dart-define, then
# converts the emulator console's .webm recording into docs/onboarding/videos/driver/<ID>-<slug>.mp4.
# See apps/driver-app/integration_test/demo/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/apps/driver-app"
OUT="$ROOT/docs/onboarding/videos/driver"
RAW="${RAW_DIR:-${TMPDIR:-/tmp}/rcab-driver-demo}"
SDK="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
AVD="${AVD:-Small_Phone}"
SERIAL="${SERIAL:-emulator-5554}"
PORT="${DEMO_CUE_PORT:-8787}"
FFMPEG="${FFMPEG:-$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)}"
export PATH="$SDK/platform-tools:$HOME/.local/share/fnm/aliases/default/bin:$PATH"

# scene id -> "<test file> <slug>" (bash 3.2 compatible: no associative arrays on stock macOS)
scene_info() {
  case "$1" in
    D01) echo "d01_sign_in_test.dart sign-in" ;;
    D02) echo "d02_vehicle_onboarding_test.dart vehicle-onboarding" ;;
    D03) echo "d03_go_online_test.dart go-online-presence" ;;
    D04) echo "d04_solo_ride_test.dart solo-ride-lifecycle" ;;
    D05) echo "d05_offer_outcomes_test.dart offer-decline-expire-lost" ;;
    D06) echo "d06_shared_ride_test.dart shared-ride-stops" ;;
    D07) echo "d07_cancel_no_show_test.dart driver-cancel-no-show" ;;
    D08) echo "d08_earnings_profile_test.dart earnings-profile-sign-out" ;;
    *) return 1 ;;
  esac
}

scenes=("$@")
[ ${#scenes[@]} -eq 0 ] && scenes=(D01 D02 D03 D04 D05 D06 D07 D08)

die() { echo "[record-driver] $*" >&2; exit 2; }
command -v flutter >/dev/null || die "flutter not on PATH"
command -v node >/dev/null || die "node not on PATH"
[ -x "$FFMPEG" ] || die "ffmpeg not found (set FFMPEG=…)"
curl -fsS -o /dev/null "http://localhost:3000/v1/health/live" || die "dev api not reachable on :3000 — run pnpm dev:up"

# ── emulator ─────────────────────────────────────────────────────────────────
if ! adb -s "$SERIAL" get-state >/dev/null 2>&1; then
  echo "[record-driver] booting AVD $AVD (headless)…"
  nohup "$SDK/emulator/emulator" -avd "$AVD" -no-window -no-audio -no-snapshot-save \
    -gpu swiftshader_indirect >"$RAW.emulator.log" 2>&1 &
  adb -s "$SERIAL" wait-for-device
fi
until [ "$(adb -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
adb -s "$SERIAL" shell settings put global window_animation_scale 1 >/dev/null
adb -s "$SERIAL" shell svc power stayon true >/dev/null
adb -s "$SERIAL" shell input keyevent KEYCODE_WAKEUP >/dev/null
adb -s "$SERIAL" shell wm dismiss-keyguard >/dev/null 2>&1 || true

mkdir -p "$OUT" "$RAW"
failed=()
for id in "${scenes[@]}"; do
  info="$(scene_info "$id")" || die "unknown scene $id"
  file="${info% *}"; slug="${info#* }"
  echo "[record-driver] ── $id ($slug) ──"
  rm -f "$RAW/$id.raw.webm"

  # 1. fixtures + session (env lines DEMO_JWT=…, DEMO_REFRESH=…)
  eval "$(node "$APP/integration_test/demo/host/session.mjs" --scene "$id" | sed 's/^/export /')"

  # 2. host director (cue server); a previous scene's director must have released the port
  for _ in $(seq 1 20); do lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done
  node "$APP/integration_test/demo/host/director.mjs" --scene "$id" --out "$RAW" --port "$PORT" \
    --serial "$SERIAL" >"$RAW/$id.director.log" 2>&1 &
  dpid=$!
  sleep 1

  # 3. the on-device scene
  set +e
  (cd "$APP" && flutter test "integration_test/demo/$file" -d "$SERIAL" \
    --dart-define=DEMO_JWT="$DEMO_JWT" --dart-define=DEMO_REFRESH="$DEMO_REFRESH" \
    --dart-define=DEMO_CUE_BASE="http://10.0.2.2:$PORT") 2>&1 | tee "$RAW/$id.flutter.log" | grep -E "^[0-9]+:[0-9]+ |Error|FAIL|Exception" || true
  set -e
  if ! grep -q "All tests passed" "$RAW/$id.flutter.log"; then
    echo "[record-driver] $id FAILED (see $RAW/$id.flutter.log, $RAW/$id.director.log)"
    kill "$dpid" 2>/dev/null || true
    wait "$dpid" 2>/dev/null || true # it finalises the recording on SIGTERM; free the cue port first
    failed+=("$id")
    continue
  fi
  wait "$dpid" || true

  # 4. webm → H.264 mp4 (portrait, faststart)
  [ -s "$RAW/$id.raw.webm" ] || { echo "[record-driver] $id: no recording"; failed+=("$id"); continue; }
  dst="$OUT/$id-$slug.mp4"
  "$FFMPEG" -v error -y -i "$RAW/$id.raw.webm" -an -vf "fps=24,scale=540:-2" \
    -c:v libx264 -crf 28 -preset slow -pix_fmt yuv420p -movflags +faststart "$dst"
  secs=$("${FFMPEG%ffmpeg}ffprobe" -v error -show_entries format=duration -of csv=p=0 "$dst" 2>/dev/null || echo "?")
  echo "[record-driver] $id -> $dst (${secs%.*} s, $(du -h "$dst" | cut -f1))"
done

# reset the demo users so nothing lingers online
node -e "import('$APP/integration_test/demo/host/fixtures.mjs').then(f => f.resetScene())" || true

if [ -z "${KEEP_EMULATOR:-}" ]; then adb -s "$SERIAL" emu kill >/dev/null 2>&1 || true; fi
[ ${#failed[@]} -eq 0 ] || die "failed scenes: ${failed[*]}"
echo "[record-driver] done → $OUT (index: $OUT/INDEX.md)"
