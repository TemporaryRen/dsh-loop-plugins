#!/usr/bin/env bash
# run-verify.sh — one-shot verification run for dsh-loop-manager.
#
#   create/refresh the isolated profile -> boot it on 127.0.0.1:58099 ->
#   wait until the web server answers -> run scripts/smoke.mjs -> tear down.
#
# The server is a foreground child of this script and is always killed by the
# EXIT trap (TERM, then KILL after a short grace). Nothing is left running.
#
# Environment overrides:
#   DSH_HOME     isolated harness home      (default /tmp/dsh-loop-verify-home)
#   PROFILE      custom profile name        (default loopverify)
#   HOST/PORT    bind address / port        (default 127.0.0.1:58099)
#   DSH_BIN      dsh executable             (default: dsh on PATH)
#   SKIP_PROFILE 1 = reuse the profile as-is (skip create-verify-profile.sh)
#   VERIFY_LOG   keep the server log at this path (default: temp file, removed)
#
# Exit codes: 0 = smoke passed, 1 = smoke failed, 2 = setup/boot failure.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-/tmp/dsh-loop-verify-home}"
PROFILE="${PROFILE:-loopverify}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-58099}"
BASE="http://${HOST}:${PORT}"
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"
SKIP_PROFILE="${SKIP_PROFILE:-0}"
READY_TIMEOUT="${READY_TIMEOUT:-60}"

log() { printf 'run-verify: %s\n' "$*" >&2; }
die() { printf 'run-verify: ERROR: %s\n' "$*" >&2; exit 2; }

# ---- safety rails -----------------------------------------------------------
if [ "$PROFILE" = "desktop" ] || [ "$PROFILE" = "web" ]; then
  die "refusing to boot profile '$PROFILE' (the verification run only uses a custom profile such as loopverify)"
fi
case "$DSH_HOME" in
  /Users/*/.dsh | /Users/*/.dsh/ | "$HOME/.dsh" | "$HOME/.dsh/")
    die "refusing to use the live DSH home '$DSH_HOME'; set DSH_HOME to an isolated directory such as /tmp/dsh-loop-verify-home"
    ;;
esac
[ -n "$DSH_BIN" ] || die "dsh not found on PATH (set DSH_BIN=/opt/homebrew/bin/dsh)"

# ---- refuse to fight another process for the port ---------------------------
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "port $PORT is already in use; refusing to touch that listener (the live Electron app is on 58042). Pick another PORT=."
fi

export DSH_HOME

log "building TypeScript sources"
npm --prefix "$SCRIPT_DIR/.." run build

# ---- 1. profile -------------------------------------------------------------
if [ "$SKIP_PROFILE" = "1" ]; then
  log "reusing existing profile $PROFILE (SKIP_PROFILE=1)"
else
  log "creating/refreshing profile $PROFILE in $DSH_HOME"
  if ! "$SCRIPT_DIR/create-verify-profile.sh" >/dev/null; then
    die "create-verify-profile.sh failed"
  fi
fi

# ---- 2. boot ----------------------------------------------------------------
LOG="${VERIFY_LOG:-}"
CLEANUP_LOG=0
if [ -z "$LOG" ]; then
  LOG="$(mktemp -t dsh-loop-verify-log)"
  CLEANUP_LOG=1
fi

SERVER_PID=""
cleanup() {
  local code=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    log "stopping verification server (pid $SERVER_PID)"
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 40); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      log "server did not stop in 10s; sending SIGKILL"
      kill -KILL "$SERVER_PID" 2>/dev/null || true
    fi
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$CLEANUP_LOG" = "1" ] && [ "$code" -ne 0 ]; then
    printf '\n----- server log (tail) -----\n' >&2
    tail -n 60 "$LOG" >&2 || true
  fi
  if [ "$CLEANUP_LOG" = "1" ]; then rm -f "$LOG"; fi
  exit "$code"
}
trap cleanup EXIT INT TERM

log "booting: $DSH_BIN --profile $PROFILE --host $HOST --port $PORT --no-open"
log "server log: $LOG"
"$DSH_BIN" --profile "$PROFILE" --host "$HOST" --port "$PORT" --no-open >"$LOG" 2>&1 &
SERVER_PID=$!

# ---- 3. readiness -----------------------------------------------------------
# The web app prints its authenticated URL once the listener is up. Read that
# line (it carries the launch token required by the browser-auth fence), then
# poll GET / until the shell really answers 200 with the boot graph.
TOKEN=""
URL_LINE=""
deadline=$((SECONDS + READY_TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    log "server exited before becoming ready"
    die "verification server exited during startup (see log)"
  fi
  URL_LINE="$(sed -n 's/^dsh web: \(http[^ ]*\)$/\1/p' "$LOG" | head -n 1)"
  if [ -n "$URL_LINE" ]; then
    TOKEN="$(printf '%s' "$URL_LINE" | sed -n 's/.*[?&]token=\([^&]*\).*/\1/p')"
    break
  fi
  sleep 0.3
done
[ -n "$URL_LINE" ] || die "server did not print its URL within ${READY_TIMEOUT}s"

COOKIE_JAR="$(mktemp -t dsh-loop-verify-cookies)"
READY=0
ready_deadline=$((SECONDS + READY_TIMEOUT))
while [ "$SECONDS" -lt "$ready_deadline" ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    rm -f "$COOKIE_JAR"
    die "verification server exited while waiting for readiness (see log)"
  fi
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 -c "$COOKIE_JAR" "${BASE}/?token=${TOKEN}" 2>/dev/null || true)"
  if [ "$status" = "303" ] || [ "$status" = "302" ]; then
    body="$(curl -sS --max-time 3 -b "$COOKIE_JAR" "${BASE}/" 2>/dev/null || true)"
    case "$body" in
      *__DSH_BOOT__*) READY=1; break ;;
    esac
  fi
  sleep 0.3
done
rm -f "$COOKIE_JAR"
[ "$READY" = "1" ] || die "server did not serve a ready shell at ${BASE} within ${READY_TIMEOUT}s"
log "server ready at $BASE (token captured from startup line)"

# ---- 4. smoke ---------------------------------------------------------------
log "running scripts/smoke.mjs --base $BASE"
SMOKE_ARGS=(--base "$BASE" --token "$TOKEN")
if [ "${SMOKE_VERBOSE:-0}" = "1" ]; then SMOKE_ARGS+=(--verbose); fi
node "$SCRIPT_DIR/../dist/scripts/smoke.mjs" "${SMOKE_ARGS[@]}"
SMOKE_STATUS=$?

# cleanup() (EXIT trap) stops the server and propagates this status.
if [ "$SMOKE_STATUS" -eq 0 ]; then
  log "SMOKE PASS"
else
  log "SMOKE FAIL (exit $SMOKE_STATUS)"
fi
exit "$SMOKE_STATUS"
