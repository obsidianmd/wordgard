#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
sync_script="$root/bin/prepare-upstream-sync.sh"
workflow_script="$root/bin/upstream-sync-workflow.sh"
workflow="$root/.github/workflows/sync-upstream.yml"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

assert_contract() {
	local expected=$1
	if ! grep -Fq -- "$expected" "$workflow"; then
		printf 'Workflow contract is missing: %s\n' "$expected" >&2
		exit 1
	fi
}

contract_line() {
	local expected=$1
	grep -nF -- "$expected" "$workflow" | head -n 1 | cut -d: -f1
}

assert_step_output() {
	local expected_sha=$1 expected_status=$2
	diff -u \
		<(printf 'upstream_sha=%s\nstatus=%s\n' "$expected_sha" "$expected_status") \
		"$step_output"
}

run_sync() {
	local name=$1
	shift
	step_output="$tmp/$name-github-output"
	: >"$step_output"
	set +e
	output=$(GITHUB_OUTPUT="$step_output" "$sync_script" "$@" 2>&1)
	sync_status=$?
	set -e
}

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

# These assertions protect the workflow wiring, not just the helper behavior.
trusted_install="install -m 700 bin/upstream-sync-workflow.sh \"\$RUNNER_TEMP/upstream-sync-workflow.sh\""
prepare_run="run: bin/prepare-upstream-sync.sh upstream/main \"\$SYNC_BRANCH\""
assert_contract "$trusted_install"
assert_contract 'id: trust'
assert_contract "\"\$RUNNER_TEMP/upstream-sync-workflow.sh\" check-trusted-paths main HEAD"
assert_contract '- name: Dispatch trusted CI'
assert_contract "if: steps.prepare.outputs.status == 'merged' && steps.trust.outputs.trusted_paths == 'true'"
assert_contract "run: gh workflow run ci.yml --ref \"\$SYNC_BRANCH\""
assert_contract "if: steps.prepare.outputs.status == 'merged' && steps.trust.outputs.trusted_paths == 'false'"
assert_contract "CHANGED_PRIVILEGED_PATHS: \${{ steps.trust.outputs.changed_privileged_paths }}"
assert_contract 'Privileged release-controller or CI changes require manual review; automatic CI dispatch is disabled.'
assert_contract "Changed privileged paths: \$changed_privileged_paths"
assert_contract "\"\$RUNNER_TEMP/upstream-sync-workflow.sh\" find-issue all \"\$CONFLICT_ISSUE_TITLE\""
assert_contract "\"\$RUNNER_TEMP/upstream-sync-workflow.sh\" find-issue open \"\$CONFLICT_ISSUE_TITLE\""
assert_contract "gh issue create --title \"\$CONFLICT_ISSUE_TITLE\""
assert_contract "gh issue reopen \"\$issue_number\""
assert_contract "gh issue comment \"\$issue_number\""
assert_contract "gh issue close \"\$issue_number\""
[[ $(contract_line "$trusted_install") -lt $(contract_line "$prepare_run") ]]

# Every helper invocation gets a private step-output file. The sentinel proves
# this test never writes to an inherited Actions GITHUB_OUTPUT.
inherited_output="$tmp/inherited-github-output"
printf 'inherited-sentinel\n' >"$inherited_output"
export GITHUB_OUTPUT=$inherited_output

new_fixture no-change
cd "$fork"
no_change_sha=$(git rev-parse upstream/main)
run_sync no-change upstream/main automation/upstream-sync
[[ $sync_status -eq 0 ]]
[[ "$output" == *"upstream_sha=$no_change_sha"* ]]
[[ "$output" == *"status=no_changes"* ]]
assert_step_output "$no_change_sha" no_changes
[[ "$(git branch --show-current)" == "main" ]]

new_fixture clean-update
printf 'upstream update\n' >>"$author/document.txt"
git -C "$author" add document.txt
git -C "$author" commit -m "Update canonical document" >/dev/null
git -C "$author" push origin main >/dev/null 2>&1
git -C "$fork" fetch upstream main >/dev/null 2>&1
cd "$fork"
clean_update_sha=$(git rev-parse upstream/main)
run_sync clean-update upstream/main automation/upstream-sync
[[ $sync_status -eq 0 ]]
[[ "$output" == *"upstream_sha=$clean_update_sha"* ]]
[[ "$output" == *"status=merged"* ]]
assert_step_output "$clean_update_sha" merged
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
conflict_sha=$(git rev-parse upstream/main)
run_sync conflict upstream/main automation/upstream-sync
[[ $sync_status -eq 2 ]]
[[ "$output" == *"upstream_sha=$conflict_sha"* ]]
[[ "$output" == *"status=conflict"* ]]
assert_step_output "$conflict_sha" conflict
[[ ! -e .git/MERGE_HEAD ]]
[[ -z "$(git status --porcelain)" ]]
[[ $(<"$inherited_output") == inherited-sentinel ]]

trust_repo="$tmp/trust-repo"
git init --initial-branch=main "$trust_repo" >/dev/null
git -C "$trust_repo" config user.name "Fork Maintainer"
git -C "$trust_repo" config user.email "fork@example.com"
mkdir -p "$trust_repo/.github/workflows" "$trust_repo/bin"
printf 'name: CI\n' >"$trust_repo/.github/workflows/ci.yml"
printf 'name: Mirror upstream release\n' >"$trust_repo/.github/workflows/mirror-release.yml"
printf 'console.log("mirror")\n' >"$trust_repo/bin/mirror-release.ts"
printf 'export {}\n' >"$trust_repo/bin/release-version.ts"
git -C "$trust_repo" add .github/workflows/ci.yml .github/workflows/mirror-release.yml \
	bin/mirror-release.ts bin/release-version.ts
git -C "$trust_repo" commit -m "Add trusted release controller" >/dev/null

cd "$trust_repo"
staged_workflow_script="$tmp/staged-upstream-sync-workflow.sh"
install -m 700 "$workflow_script" "$staged_workflow_script"
trusted_output="$tmp/trusted-paths-output"
trusted_stdout=$(GITHUB_OUTPUT="$trusted_output" \
	"$staged_workflow_script" check-trusted-paths main HEAD)
expected_trusted=$'trusted_paths=true\nchanged_privileged_paths='
[[ $trusted_stdout == "$expected_trusted" ]]
[[ $(<"$trusted_output") == "$expected_trusted" ]]

privileged_paths=(
	.github/workflows/ci.yml
	.github/workflows/mirror-release.yml
	bin/mirror-release.ts
	bin/release-version.ts
)
for index in "${!privileged_paths[@]}"; do
	path=${privileged_paths[$index]}
	git switch -C "changed-privileged-$index" main >/dev/null 2>&1
	printf '\nchanged\n' >>"$path"
	git add "$path"
	git commit -m "Change privileged path $index" >/dev/null
	changed_output="$tmp/changed-privileged-$index-output"
	changed_stdout=$(GITHUB_OUTPUT="$changed_output" \
		"$staged_workflow_script" check-trusted-paths main HEAD)
	expected_changed=$(printf 'trusted_paths=false\nchanged_privileged_paths=%s' "$path")
	[[ $changed_stdout == "$expected_changed" ]]
	[[ $(<"$changed_output") == "$expected_changed" ]]
done

git switch -C changed-multiple-privileged main >/dev/null 2>&1
printf '\nchanged\n' >>.github/workflows/mirror-release.yml
printf '\nchanged\n' >>bin/release-version.ts
git add .github/workflows/mirror-release.yml bin/release-version.ts
git commit -m "Change multiple privileged paths" >/dev/null
multiple_output="$tmp/changed-multiple-privileged-output"
multiple_stdout=$(GITHUB_OUTPUT="$multiple_output" \
	"$staged_workflow_script" check-trusted-paths main HEAD)
expected_multiple=$'trusted_paths=false\nchanged_privileged_paths=.github/workflows/mirror-release.yml,bin/release-version.ts'
[[ $multiple_stdout == "$expected_multiple" ]]
[[ $(<"$multiple_output") == "$expected_multiple" ]]

mock_bin="$tmp/mock-bin"
mkdir -p "$mock_bin"
cat >"$mock_bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 4 ]]
[[ $1 == api ]]
[[ $2 == --paginate ]]
[[ $3 == --slurp ]]
printf '%s\n' "$*" >>"$GH_MOCK_LOG"
cat "$GH_MOCK_RESPONSE"
MOCK
chmod +x "$mock_bin/gh"

issue_title='Upstream synchronization requires manual conflict resolution'
issue_response="$tmp/issues.json"
cat >"$issue_response" <<EOF
[[{"number": 11, "state": "open", "title": "$issue_title", "pull_request": {"url": "https://example.test/pr/11"}},
  {"number": 12, "state": "open", "title": "Not the exact title"}],
 [{"number": 205, "state": "closed", "title": "$issue_title"}]]
EOF
mock_log="$tmp/gh.log"
issue_result=$(PATH="$mock_bin:$PATH" \
	GH_MOCK_LOG="$mock_log" \
	GH_MOCK_RESPONSE="$issue_response" \
	GITHUB_REPOSITORY=obsidianmd/wordgard \
	"$workflow_script" find-issue all "$issue_title")
[[ $issue_result == $'205\tclosed' ]]
[[ $(<"$mock_log") == 'api --paginate --slurp repos/obsidianmd/wordgard/issues?state=all&per_page=100' ]]
