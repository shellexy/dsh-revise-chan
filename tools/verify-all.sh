#!/usr/bin/env bash
# Run the offline verifications; add --e2e to also boot a throwaway dsh profile
# and drive the real Typert Gateway.
#
# Usage: bash tools/verify-all.sh [--e2e]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
status=0

for tool in verify-host verify-engine verify-client; do
  echo "▶ $tool"
  node "$here/$tool.mjs" || status=1
  echo
done

if [ "${1:-}" = "--e2e" ]; then
  echo "▶ verify-e2e"
  bash "$here/verify-e2e.sh" || status=1
fi

if [ "$status" -ne 0 ]; then
  echo "✘ some verifications failed" >&2
  exit 1
fi
echo "✔ all verifications passed"
