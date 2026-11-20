#!/usr/bin/env bash
# The README demo: run Hookstorm against the buggy receiver (fails) and the fixed receiver (passes).
set -uo pipefail
cd "$(dirname "$0")/.."
RUNS="${RUNS:-5}"
SEED="${SEED:-1}"

[ -f dist/cli.js ] || npm run build >/dev/null

node examples/buggy-receiver/server.mjs >/dev/null & BUGGY=$!
node examples/fixed-receiver/server.mjs >/dev/null & FIXED=$!
trap 'kill $BUGGY $FIXED 2>/dev/null' EXIT
sleep 0.5

echo "━━━ 1/2  buggy receiver ━━━"
node dist/cli.js run -c examples/hookstorm.config.ts --target http://127.0.0.1:3001/webhooks/paystack --seed "$SEED" --runs "$RUNS"
BUGGY_EXIT=$?

echo
echo "━━━ 2/2  fixed receiver ━━━"
node dist/cli.js run -c examples/hookstorm.config.ts --target http://127.0.0.1:3002/webhooks/paystack --seed "$SEED" --runs "$RUNS"
FIXED_EXIT=$?

echo
echo "exit codes: buggy=$BUGGY_EXIT (expected 1), fixed=$FIXED_EXIT (expected 0)"
[ "$BUGGY_EXIT" = 1 ] && [ "$FIXED_EXIT" = 0 ]
