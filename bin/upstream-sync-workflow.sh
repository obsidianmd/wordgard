#!/usr/bin/env bash
set -euo pipefail

emit_output() {
	local name=$1 value=$2
	printf '%s=%s\n' "$name" "$value"
	if [[ -n ${GITHUB_OUTPUT:-} ]]; then
		printf '%s=%s\n' "$name" "$value" >>"$GITHUB_OUTPUT"
	fi
}

check_ci() {
	local trusted_ref=$1 candidate_ref=$2
	local workflow_path=.github/workflows/ci.yml
	local trusted candidate trusted_ci=false
	trusted=$(mktemp)
	candidate=$(mktemp)
	trap 'rm -f "$trusted" "$candidate"' RETURN

	if git show "$trusted_ref:$workflow_path" >"$trusted" 2>/dev/null &&
		git show "$candidate_ref:$workflow_path" >"$candidate" 2>/dev/null &&
		cmp -s "$trusted" "$candidate"; then
		trusted_ci=true
	fi

	emit_output trusted_ci "$trusted_ci"
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
check-ci)
	[[ $# -eq 3 ]] || {
		printf 'Usage: %s check-ci TRUSTED_REF CANDIDATE_REF\n' "$0" >&2
		exit 2
	}
	check_ci "$2" "$3"
	;;
find-issue)
	[[ $# -eq 3 ]] || {
		printf 'Usage: %s find-issue STATE EXACT_TITLE\n' "$0" >&2
		exit 2
	}
	find_issue "$2" "$3"
	;;
*)
	printf 'Usage: %s {check-ci TRUSTED_REF CANDIDATE_REF|find-issue STATE EXACT_TITLE}\n' "$0" >&2
	exit 2
	;;
esac
