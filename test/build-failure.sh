#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fixture="$root/src/schema/__build_failure.ts"
output=$(mktemp)
trap 'rm -f "$fixture" "$output"' EXIT

printf 'const invalidBuildFixture: string = 1\n' >"$fixture"
rm -rf "$root/dist"
set +e
node "$root/bin/build.ts" >"$output" 2>&1
status=$?
set -e

cat "$output"
if [[ $status -eq 0 ]]; then
	printf 'Expected a failed build to return nonzero.\n' >&2
	exit 1
fi
