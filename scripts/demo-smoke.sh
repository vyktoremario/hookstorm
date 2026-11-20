#!/usr/bin/env bash
# CI check that the README demo still behaves as documented.
set -euo pipefail
cd "$(dirname "$0")/.."
RUNS=10 SEED=1 bash scripts/demo.sh > demo-output.txt 2>&1 || { cat demo-output.txt; exit 1; }
cat demo-output.txt
rm -f demo-output.txt
