#!/usr/bin/env bash
# Verify the whole chain through the real Harness: boot a throwaway dsh profile
# with the Plugin installed, and have tools/e2e/harness.mjs invoke
# `revise-chan/plan` and `revise-chan/revise` through the real Typert Gateway.
#
# Usage: bash tools/verify-e2e.sh
#   Requires `dsh` on PATH (any 0.2.x install) and writes only under .tmp/.
#
# The probe exits the booted process by itself once it has printed its lines, so
# the run never needs a model, a credential, or a network call.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
home="$root/.tmp/e2e/dsh-home"
profile="$home/profiles/revise-chan-e2e"
log="$root/.tmp/e2e/output.log"

if ! command -v dsh >/dev/null 2>&1; then
  echo "✘ dsh is not on PATH; install DeepSeek Harness first" >&2
  exit 1
fi

rm -rf "$root/.tmp/e2e"
mkdir -p "$profile"

# A throwaway DSH_HOME: only dsh-base plus the two root rows below.
cat >"$profile/package.json" <<JSON
{
  "name": "dsh-profile-revise-chan-e2e",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
}
JSON
echo '[]' >"$profile/cordis.yml"

# Absolute paths in a root row are imported as file URLs, so the probe runs the
# working copy under test rather than an installed copy.
cat >"$profile/cordis.patch.yml" <<YAML
- insert:
    - id: revise-chan-under-test
      name: $root/index.js
    - id: revise-chan-e2e-harness
      name: $here/e2e/harness.mjs
YAML

echo "▶ booting a throwaway profile with $root/index.js"
DSH_HOME="$home" dsh --profile revise-chan-e2e >"$log" 2>&1 || true
cat "$log"

fail=0
expect() {
  local needle="$1" label="$2"
  if grep -Fq -- "$needle" "$log"; then
    echo "✔ $label"
  else
    echo "✘ $label — missing: $needle"
    fail=1
  fi
}

expect 'PROBE plan => {"ok":true,"value":{"turn":1,"forkSeq":1' 'the real gateway resolves revise-chan/plan and cuts at the prompt'
expect 'PROBE revise => {"ok":true,"value":{"turn":1' 'the real gateway resolves revise-chan/revise'
expect 'PROBE child before => [["user","probe question?"]]' 'the branch inherits the question without the answer'
expect 'PROBE child after => [["user","probe question?"],["assistant","REVISED answer"]]' 'the branch reads as question + edited answer'
expect 'PROBE child turn boundary => {"openTurnStartSeq":null' 'the branch closes its own turn'
expect '"lastTurn":1' 'the branch keeps the original turn number, so the next turn cannot collide'
expect 'PROBE missing session => {"ok":false,"error":{"code":"session-not-found"' 'business failures reach the caller as structured errors'

if [ "$fail" -ne 0 ]; then
  echo -e "\n✘ end-to-end verification failed (full output: $log)" >&2
  exit 1
fi
echo -e "\n✔ end-to-end verification passed (full output: $log)"
