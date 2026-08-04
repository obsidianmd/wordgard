#!/usr/bin/env bash
set -euo pipefail

upstream_ref=${1:-upstream/main}
sync_branch=${2:-automation/upstream-sync}

emit_output() {
	local name=$1 value=$2
	printf '%s=%s\n' "$name" "$value"
	if [[ -n ${GITHUB_OUTPUT:-} ]]; then
		printf '%s=%s\n' "$name" "$value" >>"$GITHUB_OUTPUT"
	fi
}

if ! git diff --quiet || ! git diff --cached --quiet; then
	printf 'The worktree must be clean before preparing an upstream sync.\n' >&2
	exit 1
fi

upstream_sha=$(git rev-parse "$upstream_ref")
emit_output upstream_sha "$upstream_sha"

if git merge-base --is-ancestor "$upstream_ref" HEAD; then
	emit_output status no_changes
	exit 0
fi

git switch --force-create "$sync_branch"
if git merge --no-ff --no-edit "$upstream_ref"; then
	emit_output status merged
	exit 0
fi

git merge --abort
emit_output status conflict
exit 2
