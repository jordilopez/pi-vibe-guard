#!/usr/bin/env bash
# scripts/smoke.sh — integration smoke test for the vibe-guard extension.
#
# This checks ONLY the pi wiring: that the extension loads, the `input`
# event fires, and it returns a verdict. All the scoring logic is covered
# by the unit suite (`npm test`, ~80 ms) — don't re-test it here.
#
# Two pi invocations, run in parallel (~10 s total):
#   1. a vibe-coded prompt  → a verdict line appears, warn=yes
#   2. a conversational reply → no verdict line (skipped)

set -uo pipefail

cd "$(dirname "$0")/.."

EXT="./.pi/extensions/vibe-guard.ts"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

run() {
  VIBE_GUARD_DEBUG=1 timeout 120 pi -e "$EXT" --no-tools -p "$1" 2>&1 \
    | grep -oE '\[vibe-guard\][^\[]*' || true
}

echo "== vibe-guard smoke (wiring only; run 'npm test' for scoring) =="
echo

VIBE_CODED="Fix the parser. I don't care how, just make it work. You decide the data structures, the dependencies, the naming."

# Case 1: a scored prompt must produce a verdict with warn=yes.
run "$VIBE_CODED" > "$TMP/scored" &
P1=$!
# Case 2: a follow-up must produce no verdict at all.
run "yes go on" > "$TMP/skipped" &
P2=$!
wait "$P1" "$P2"

FAILED=0

scored=$(cat "$TMP/scored")
if echo "$scored" | grep -q 'warn=yes'; then
  printf '✓ scored prompt produced a verdict\n   %s\n' "$(echo "$scored" | head -1)"
else
  printf '✗ expected a verdict with warn=yes\n   got: %s\n' "$scored"
  FAILED=1
fi

skipped=$(cat "$TMP/skipped")
if [ -z "$skipped" ]; then
  printf '✓ conversational reply was skipped\n'
else
  printf '✗ expected no verdict for a follow-up\n   got: %s\n' "$skipped"
  FAILED=1
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "all checks passed"
else
  echo "smoke failed"
  exit 1
fi
