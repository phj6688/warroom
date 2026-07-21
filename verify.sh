#!/usr/bin/env bash
# war-room autonomous deploy verification (HLB-798).
# Proves a running war-room deploy is healthy and gated. Exits non-zero on any
# failure so an agent sees red and loops before declaring a deploy done.
#
#   ./verify.sh
#
# Config via env:
#   WARROOM_URL         local app base    (default http://127.0.0.1:8090)
#   WARROOM_PUBLIC_URL  public gated host (default https://warroom.peyman.io)
#
# The public gate probe expects 302/401/403 (Zitadel forwardauth redirects 302).
# It stays red until the public route is gated (WAR_ROOM_TOKEN + CNAME), which is
# the correct signal: an ungated public war-room must fail this script.
set -uo pipefail

WARROOM_URL="${WARROOM_URL:-http://127.0.0.1:8090}"
WARROOM_PUBLIC_URL="${WARROOM_PUBLIC_URL:-https://warroom.peyman.io}"
fail=0
say(){ printf '\n=== %s ===\n' "$1"; }

say "Health (expect 200)"
if curl -fsS -o /dev/null "${WARROOM_URL}/health"; then
  echo "  ok: /health 200"
else
  echo "  FAIL: /health not 200 at ${WARROOM_URL}"; fail=1
fi

say "Metrics (expect 200, no auth)"
if curl -fsS -o /dev/null "${WARROOM_URL}/metrics"; then
  echo "  ok: /metrics 200"
else
  echo "  FAIL: /metrics not 200 at ${WARROOM_URL}"; fail=1
fi

say "files-service-config must not leak a token"
# -s (not -fsS): the route answers 503 when files-service is unconfigured; that
# body is legitimate and carries no token. Fail only if a token field appears.
cfg="$(curl -s --max-time 10 "${WARROOM_URL}/api/files-service-config" 2>/dev/null || true)"
if [ -z "$cfg" ]; then
  echo "  FAIL: /api/files-service-config gave no response at ${WARROOM_URL}"; fail=1
elif printf '%s' "$cfg" | grep -Eiq '"(token|filesServiceToken|files_service_token)"[[:space:]]*:'; then
  echo "  FAIL: config endpoint returned a token field"; fail=1
else
  echo "  ok: no token field in config response"
fi

say "Anonymous gate probe (expect 302/401/403)"
# Plain anonymous request; no spoofed CF-Connecting-IP (that only trips the WAF and masks the real gate).
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${WARROOM_PUBLIC_URL}/" 2>/dev/null || echo 000)"
case "$code" in
  302|401|403) echo "  ok: gated (${code})";;
  *)           echo "  FAIL: gate OPEN or unreachable (${code}) at ${WARROOM_PUBLIC_URL}"; fail=1;;
esac

say "RESULT"
if [ "$fail" -eq 0 ]; then
  echo "ALL GREEN"; exit 0
else
  echo "FAILURES above — fix and re-run, do not ask the operator"; exit 1
fi
