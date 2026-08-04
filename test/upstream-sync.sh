#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
sync_script="$root/bin/prepare-upstream-sync.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

new_fixture() {
	local name=$1
	bare="$tmp/$name-canonical.git"
	author="$tmp/$name-author"
	fork="$tmp/$name-fork"

	git init --bare --initial-branch=main "$bare" >/dev/null
	git clone "$bare" "$author" >/dev/null 2>&1
	git -C "$author" config user.name "Canonical Author"
	git -C "$author" config user.email "canonical@example.com"
	printf 'base\n' >"$author/document.txt"
	git -C "$author" add document.txt
	git -C "$author" commit -m "Add base" >/dev/null
	git -C "$author" push origin main >/dev/null 2>&1

	git clone "$bare" "$fork" >/dev/null 2>&1
	git -C "$fork" remote rename origin upstream
	git -C "$fork" config user.name "Fork Maintainer"
	git -C "$fork" config user.email "fork@example.com"
	git -C "$fork" config core.hooksPath /dev/null
}

new_fixture no-change
cd "$fork"
output=$("$sync_script" upstream/main automation/upstream-sync)
[[ "$output" == *"status=no_changes"* ]]
[[ "$(git branch --show-current)" == "main" ]]

new_fixture clean-update
printf 'upstream update\n' >>"$author/document.txt"
git -C "$author" add document.txt
git -C "$author" commit -m "Update canonical document" >/dev/null
git -C "$author" push origin main >/dev/null 2>&1
git -C "$fork" fetch upstream main >/dev/null 2>&1
cd "$fork"
output=$("$sync_script" upstream/main automation/upstream-sync)
[[ "$output" == *"status=merged"* ]]
[[ "$(git branch --show-current)" == "automation/upstream-sync" ]]
git merge-base --is-ancestor upstream/main HEAD
[[ "$(git rev-list --parents -n 1 HEAD | awk '{print NF}')" -eq 3 ]]

new_fixture conflict
printf 'fork version\n' >"$fork/document.txt"
git -C "$fork" add document.txt
git -C "$fork" commit -m "Change fork document" >/dev/null
printf 'upstream version\n' >"$author/document.txt"
git -C "$author" add document.txt
git -C "$author" commit -m "Change canonical document" >/dev/null
git -C "$author" push origin main >/dev/null 2>&1
git -C "$fork" fetch upstream main >/dev/null 2>&1
cd "$fork"
set +e
output=$("$sync_script" upstream/main automation/upstream-sync 2>&1)
status=$?
set -e
[[ "$status" -eq 2 ]]
[[ "$output" == *"status=conflict"* ]]
[[ ! -e .git/MERGE_HEAD ]]
[[ -z "$(git status --porcelain)" ]]
