#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
real_git=$(command -v git)

export GIT_AUTHOR_NAME='Mirror Test'
export GIT_AUTHOR_EMAIL='mirror@example.com'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

canonical="$tmp/canonical.git"
origin="$tmp/origin.git"
seed="$tmp/seed"
work="$tmp/work"
mkdir -p "$seed"
"$real_git" init -q --bare "$canonical"
"$real_git" init -q --bare "$origin"
"$real_git" -C "$seed" init -q -b main
printf 'base\n' > "$seed/history"
"$real_git" -C "$seed" add history
"$real_git" -C "$seed" commit -q -m base
base_sha=$("$real_git" -C "$seed" rev-parse HEAD)
"$real_git" -C "$seed" tag -a 0.3.1 -m 'Release 0.3.1'
printf '0.4.0\n' >> "$seed/history"
"$real_git" -C "$seed" commit -qam 'release 0.4.0'
"$real_git" -C "$seed" tag 0.4.0
printf '0.5.0\n' >> "$seed/history"
"$real_git" -C "$seed" commit -qam 'release 0.5.0'
"$real_git" -C "$seed" tag -a v0.5.0 -m 'Release 0.5.0'
"$real_git" -C "$seed" remote add canonical "$canonical"
"$real_git" -C "$seed" push -q canonical main --tags
"$real_git" -C "$seed" tag -a obsidian-v0.3.1-2 "$base_sha" -m 'Fork baseline'
"$real_git" -C "$seed" remote add origin "$origin"
"$real_git" -C "$seed" push -q origin main obsidian-v0.3.1-2
"$real_git" --git-dir="$origin" symbolic-ref HEAD refs/heads/main
candidate_sha=$("$real_git" -C "$seed" rev-parse HEAD)

"$real_git" clone -q "$origin" "$work"
"$real_git" -C "$work" remote add upstream "$canonical"

mock_bin="$tmp/bin"
mkdir -p "$mock_bin"
cat > "$mock_bin/git" <<EOF
#!/usr/bin/env bash
printf '%q ' "\$@" >> "\${MIRROR_GIT_LOG:?}"
printf '\n' >> "\$MIRROR_GIT_LOG"
exec "$real_git" "\$@"
EOF
chmod +x "$mock_bin/git"
cat > "$mock_bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%q ' "$@" >> "${MIRROR_GH_LOG:?}"
printf '\n' >> "$MIRROR_GH_LOG"
[[ ${1-} == api ]] || { echo 'mutating gh call rejected' >&2; exit 90; }
cat <<JSON
{"id":${MOCK_CI_ID:-101},"event":"${MOCK_CI_EVENT:-push}","head_branch":"${MOCK_CI_BRANCH:-main}","head_sha":"${MOCK_CI_SHA:?}","conclusion":"${MOCK_CI_CONCLUSION:-success}","html_url":"https://github.example/runs/${MOCK_CI_ID:-101}"}
JSON
EOF
chmod +x "$mock_bin/gh"

export PATH="$mock_bin:$PATH"
export MIRROR_GIT_LOG="$tmp/git.log"
export MIRROR_GH_LOG="$tmp/gh.log"
export GITHUB_REPOSITORY='obsidianmd/wordgard'
export GITHUB_SERVER_URL='https://github.example'
export MOCK_CI_SHA="$candidate_sha"

run_mirror() {
  (cd "$work" && MIRROR_RELEASE_DRY_RUN=1 node "$root/bin/mirror-release.ts" \
    publish obsidian-v0.3.1-2 "${1:-$candidate_sha}" "${2:-101}")
}

expect_failure() {
  local expected=$1
  shift
  local output
  if output=$("$@" 2>&1); then
    echo "expected failure containing: $expected" >&2
    exit 1
  fi
  [[ $output == *"$expected"* ]] || {
    printf 'missing expected error %q in:\n%s\n' "$expected" "$output" >&2
    exit 1
  }
}

output=$(run_mirror)
node -e '
  const assert = require("node:assert/strict")
  const plan = JSON.parse(process.argv[1])
  assert.deepEqual(plan, {
    baselineTag: "obsidian-v0.3.1-2",
    candidateSha: process.argv[2],
    ciRun: {id: 101, url: "https://github.example/runs/101"},
    watermark: "0.3.1",
    selected: {tag: "v0.5.0", version: "0.5.0", commit: process.argv[2]},
    supersededTags: ["0.4.0"],
    proposedForkTag: "obsidian-v0.5.0-1",
  })
' "$output" "$candidate_sha"

[[ $(wc -l < "$MIRROR_GH_LOG") -eq 1 ]]
[[ $(cut -d' ' -f1 "$MIRROR_GH_LOG") == api ]]
if awk '$1 == "push" || ($1 == "tag" && $2 != "--list") { found = 1 } END { exit !found }' \
  "$MIRROR_GIT_LOG"; then
  echo 'controller attempted a mutating git command' >&2
  exit 1
fi
[[ -z $("$real_git" --git-dir="$origin" tag --list 'obsidian-v0.5.0-*') ]]

MOCK_CI_EVENT=pull_request expect_failure 'CI run event must be push' run_mirror
MOCK_CI_CONCLUSION=failure expect_failure 'CI run conclusion must be success' run_mirror
MOCK_CI_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  expect_failure 'CI run head SHA does not match candidate' run_mirror

printf 'stale\n' >> "$seed/history"
"$real_git" -C "$seed" commit -qam stale
stale_tip=$("$real_git" -C "$seed" rev-parse HEAD)
"$real_git" -C "$seed" push -q origin main
MOCK_CI_SHA="$candidate_sha" expect_failure 'candidate SHA is not origin/main' run_mirror

# Move the canonical baseline version to a disconnected history. A configured
# baseline whose canonical release is unreachable cannot establish a watermark.
side="$tmp/side"
mkdir -p "$side"
"$real_git" -C "$side" init -q -b main
printf 'side\n' > "$side/history"
"$real_git" -C "$side" add history
"$real_git" -C "$side" commit -q -m side
"$real_git" -C "$side" tag -f 0.3.1
"$real_git" -C "$side" remote add canonical "$canonical"
"$real_git" -C "$side" push -q --force canonical 0.3.1
"$real_git" -C "$work" tag -d 0.3.1 >/dev/null
MOCK_CI_SHA="$stale_tip" expect_failure 'canonical baseline tag is not reachable' run_mirror "$stale_tip"

expect_failure 'candidate SHA must be exactly 40 hexadecimal characters' run_mirror deadbeef
expect_failure 'CI run ID must be a positive decimal integer' run_mirror "$stale_tip" 0

[[ -z $("$real_git" --git-dir="$origin" tag --list 'obsidian-v0.5.0-*') ]]
echo 'mirror-release discovery tests passed'
