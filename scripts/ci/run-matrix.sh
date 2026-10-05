#!/usr/bin/env bash
# Read-only source clone; test fixtures only. No live path, service or credentials.
set -euo pipefail
if [[ ${1:-} != --confirm-isolated-ci || $# != 1 ]]; then
  echo 'Pass --confirm-isolated-ci from an isolated CI checkout, never a live installation.' >&2; exit 2
fi
: "${NODE22:?Set NODE22 to the verified absolute Node 22.18+ binary}"
: "${NODE24:?Set NODE24 to the verified absolute Node 24 binary}"
[[ $NODE22 = /* && $NODE24 = /* ]]
[[ $("$NODE22" --version) = v22.* && $("$NODE24" --version) = v24.* ]]
repo=$(git rev-parse --show-toplevel)
head=$(git rev-parse HEAD)
[[ -z $(git status --porcelain --untracked-files=no) ]]
base=$(mktemp -d "${WALLET_CI_ROOT:-$(dirname "$repo")}/8415wallet-full-ci.XXXXXXXX")
printf 'Exact commit: %s\nIsolated outputs: %s\n' "$head" "$base"
status=0
for major in 22 24; do
  checkout="$base/node-$major/source"
  mkdir -p "$(dirname "$checkout")"
  git clone --quiet --no-hardlinks --no-checkout "$repo" "$checkout"
  git -C "$checkout" checkout --quiet --detach "$head"
  if [[ $major = 22 ]]; then node=$NODE22; else node=$NODE24; fi
  mkdir -p "$base/node-$major/bin"
  # A standalone exact-byte runtime avoids package-manager hardlinks and keeps
  # the same executable identity for all commands in this isolated leg.
  original_node=$node
  cp -- "$original_node" "$base/node-$major/bin/node"
  chmod 0755 "$base/node-$major/bin/node"
  cmp -- "$original_node" "$base/node-$major/bin/node"
  node="$base/node-$major/bin/node"
  (
    cd "$checkout"
    export PATH="$base/node-$major/bin:$PATH"
    export WALLET_CI_OUTPUT="$base/node-$major/evidence"
    "$node" scripts/ci/run-linux.mjs --confirm-isolated-ci
  ) || status=1
 done
printf 'Matrix exit: %s; evidence retained at %s\n' "$status" "$base"
exit "$status"
