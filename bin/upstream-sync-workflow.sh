#!/usr/bin/env bash
set -euo pipefail

emit_output() {
	local name=$1 value=$2
	printf '%s=%s\n' "$name" "$value"
	if [[ -n ${GITHUB_OUTPUT:-} ]]; then
		printf '%s=%s\n' "$name" "$value" >>"$GITHUB_OUTPUT"
	fi
}

check_trusted_paths() {
	local trusted_ref=$1 candidate_ref=$2 directory trusted candidate path
	local -a changed=()
	local -ra privileged_paths=(
		.github/workflows/ci.yml
		.github/workflows/mirror-release.yml
		bin/mirror-release.ts
		bin/release-version.ts
	)
	directory=$(mktemp -d)
	trap 'rm -rf "$directory"' RETURN

	for path in "${privileged_paths[@]}"; do
		trusted="$directory/trusted"
		candidate="$directory/candidate"
		if ! git show "$trusted_ref:$path" >"$trusted" 2>/dev/null ||
			! git show "$candidate_ref:$path" >"$candidate" 2>/dev/null ||
			! cmp -s "$trusted" "$candidate"; then
			changed+=("$path")
		fi
	done

	local trusted_paths=true changed_paths=
	if ((${#changed[@]})); then
		trusted_paths=false
		changed_paths=$(IFS=,; printf '%s' "${changed[*]}")
	fi
	emit_output trusted_paths "$trusted_paths"
	emit_output changed_privileged_paths "$changed_paths"
}

find_issue() {
	local state=$1 title=$2
	case $state in
	all | open | closed) ;;
	*)
		printf 'Unsupported issue state: %s\n' "$state" >&2
		exit 2
		;;
	esac
	: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must identify the target repository}"

	local issues
	issues=$(gh api --paginate --slurp \
		"repos/$GITHUB_REPOSITORY/issues?state=$state&per_page=100")
	jq -r --arg title "$title" '
		[.[][] | select(.pull_request == null and .title == $title)][0]
		| if . == null then empty else [.number, .state] | @tsv end
	' <<<"$issues"
}

command=${1:-}
case $command in
check-trusted-paths)
	[[ $# -eq 3 ]] || {
		printf 'Usage: %s check-trusted-paths TRUSTED_REF CANDIDATE_REF\n' "$0" >&2
		exit 2
	}
	check_trusted_paths "$2" "$3"
	;;
find-issue)
	[[ $# -eq 3 ]] || {
		printf 'Usage: %s find-issue STATE EXACT_TITLE\n' "$0" >&2
		exit 2
	}
	find_issue "$2" "$3"
	;;
*)
	printf 'Usage: %s {check-trusted-paths TRUSTED_REF CANDIDATE_REF|find-issue STATE EXACT_TITLE}\n' "$0" >&2
	exit 2
	;;
esac
