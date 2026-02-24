#!/bin/bash
# War Room — End-to-End Test Suite
# Tests: HTTP, WebSocket, File Upload, LLM API call
set -e

HOST="http://100.115.215.121:8090"
WS_HOST="ws://100.115.215.121:8090"
PASS=0
FAIL=0
ERRORS=""

pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); ERRORS="$ERRORS\n  ❌ $1"; echo "  ❌ $1"; }

echo "═══════════════════════════════════════"
echo "  WAR ROOM — Test Suite"
echo "═══════════════════════════════════════"
echo ""

# ─── 1. Health / HTTP ─────────────────────────────────────
echo "▸ HTTP Tests"

# Static page loads
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HOST/")
[ "$STATUS" = "200" ] && pass "GET / → 200" || fail "GET / → $STATUS (expected 200)"

# Health endpoint
HEALTH=$(curl -s "$HOST/api/health")
echo "$HEALTH" | grep -q '"status":"ok"' && pass "GET /api/health → ok" || fail "GET /api/health → bad response: $HEALTH"

# Agents endpoint
AGENTS=$(curl -s "$HOST/api/agents")
COUNT=$(echo "$AGENTS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
[ "$COUNT" = "8" ] && pass "GET /api/agents → 8 agents" || fail "GET /api/agents → $COUNT agents (expected 8)"

# Check all 8 roles present
for role in "Process Architect" "Systems Synthesizer" "Divergent Generator" "Convergent Evaluator" "Red Teamer" "Quantitative Expert" "Qualitative Expert" "Research Scout"; do
  echo "$AGENTS" | grep -q "$role" && pass "Agent: $role present" || fail "Agent: $role MISSING"
done

echo ""

# ─── 2. File Upload ──────────────────────────────────────
echo "▸ File Upload Tests"

# Create a test file
echo "This is a test document about insurance tariff structures." > /tmp/wr-test-file.txt

UPLOAD=$(curl -s -X POST "$HOST/api/upload" -F "files=@/tmp/wr-test-file.txt")
echo "$UPLOAD" | grep -q '"ok":true' && pass "POST /api/upload → ok" || fail "POST /api/upload → $UPLOAD"
echo "$UPLOAD" | grep -q '"content"' && pass "File content extracted" || fail "File content not extracted"
echo "$UPLOAD" | grep -q 'insurance tariff' && pass "File content readable" || fail "File content not readable"

# Test multiple files
echo '{"key": "value"}' > /tmp/wr-test2.json
UPLOAD2=$(curl -s -X POST "$HOST/api/upload" -F "files=@/tmp/wr-test-file.txt" -F "files=@/tmp/wr-test2.json")
FILE_COUNT=$(echo "$UPLOAD2" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('files',[])))" 2>/dev/null || echo "0")
[ "$FILE_COUNT" = "2" ] && pass "Multi-file upload → $FILE_COUNT files" || fail "Multi-file upload → $FILE_COUNT (expected 2)"

rm -f /tmp/wr-test-file.txt /tmp/wr-test2.json
echo ""

# ─── 3. WebSocket ────────────────────────────────────────
echo "▸ WebSocket Tests"

# Install wscat if not available
which wscat >/dev/null 2>&1 || npm install -g wscat >/dev/null 2>&1

# Test WS connection and initial messages
WS_OUT=$(timeout 5 wscat -c "$WS_HOST" -x '{"type":"ping"}' --wait 3 2>/dev/null || true)
echo "$WS_OUT" | grep -q '"type":"agents"' && pass "WS: received agents" || fail "WS: no agents message"
echo "$WS_OUT" | grep -q '"type":"phases"' && pass "WS: received phases" || fail "WS: no phases message"
echo "$WS_OUT" | grep -q '"type":"sessions"' && pass "WS: received sessions" || fail "WS: no sessions message"

echo ""

# ─── 4. LLM API Call (real Anthropic request) ────────────
echo "▸ LLM Integration Test (live API call)"

# Create a session via WS and check if the first agent responds
# We'll use a small test problem to minimize token usage
WS_FULL=$(timeout 60 wscat -c "$WS_HOST" -x '{"type":"new-session","problem":"In one sentence, what is 2+2? This is a test.","files":[]}' --wait 55 2>/dev/null || true)

echo "$WS_FULL" | grep -q '"type":"session-created"' && pass "WS: session created" || fail "WS: session not created"
echo "$WS_FULL" | grep -q '"type":"phase-change"' && pass "WS: phase change received" || fail "WS: no phase change"
echo "$WS_FULL" | grep -q '"type":"agent-state"' && pass "WS: agent state updates" || fail "WS: no agent state updates"

# Check for actual LLM response (type: message with content)
if echo "$WS_FULL" | grep -q '"type":"message"'; then
  pass "LLM: Agent responded with content ✨"
  # Extract first agent's response snippet
  FIRST_MSG=$(echo "$WS_FULL" | grep '"type":"message"' | head -1 | python3 -c "import sys,json; m=json.loads(sys.stdin.readline()); print(f'  → {m[\"agentName\"]}: {m[\"content\"][:100]}...')" 2>/dev/null || echo "  → (could not parse)")
  echo "$FIRST_MSG"
else
  # Check for errors
  if echo "$WS_FULL" | grep -q '"type":"error"'; then
    ERR_MSG=$(echo "$WS_FULL" | grep '"type":"error"' | head -1)
    fail "LLM: API error — $ERR_MSG"
  else
    fail "LLM: No agent message received (timeout?)"
  fi
fi

echo ""

# ─── 5. Container Health ────────────────────────────────
echo "▸ Container Health"

ssh -i /root/.ssh/id_lumo_homelab lumo@100.115.215.121 "docker inspect war-room --format='{{.State.Status}}'" 2>/dev/null | grep -q "running" && pass "Container: running" || fail "Container: not running"
ssh -i /root/.ssh/id_lumo_homelab lumo@100.115.215.121 "docker inspect war-room --format='{{.State.Restarting}}'" 2>/dev/null | grep -q "false" && pass "Container: not restarting" || fail "Container: restart loop"

# Check logs for errors
RECENT_LOGS=$(ssh -i /root/.ssh/id_lumo_homelab lumo@100.115.215.121 "docker logs --since 5m war-room 2>&1")
echo "$RECENT_LOGS" | grep -qi "error\|crash\|uncaught\|EACCES" && fail "Container: errors in logs" || pass "Container: no errors in logs"
echo "$RECENT_LOGS" | grep -q "API Key: ✅ configured" && pass "Container: API key configured" || fail "Container: API key not configured"

echo ""

# ─── Summary ─────────────────────────────────────────────
echo "═══════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════"
if [ $FAIL -gt 0 ]; then
  echo -e "\nFailures:$ERRORS"
  exit 1
else
  echo "  🎉 All tests passed!"
  exit 0
fi
