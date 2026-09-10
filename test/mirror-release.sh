#!/usr/bin/env bash
# shellcheck disable=SC2016 # Node snippets intentionally use single-quoted JavaScript.
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
# Fork-shaped tags outside origin must not affect the fork suffix.
"$real_git" -C "$seed" tag -a obsidian-v0.5.0-7 -m 'Upstream-only fork-shaped tag'
"$real_git" -C "$seed" push -q canonical obsidian-v0.5.0-7
"$real_git" -C "$seed" tag -d obsidian-v0.5.0-7 >/dev/null
"$real_git" -C "$seed" tag -a obsidian-v0.3.1-2 "$base_sha" -m 'Fork baseline'
"$real_git" -C "$seed" remote add origin "$origin"
"$real_git" -C "$seed" push -q origin main obsidian-v0.3.1-2
# SemVer tags outside upstream must not become canonical releases.
"$real_git" -C "$seed" tag 9.0.0
"$real_git" -C "$seed" push -q origin 9.0.0
"$real_git" -C "$seed" tag -d 9.0.0 >/dev/null
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
commit_suffix='^{commit}'
case "\${1-}" in
  fetch)
    [[ \$# == 4 && \$2 == --no-tags && \$3 == origin &&
      (\$4 == main || \$4 =~ ^refs/tags/obsidian-v[0-9A-Za-z.+-]+-[1-9][0-9]*\$) ]] ||
      [[ \$# == 3 && \$2 == --tags && (\$3 == upstream || \$3 == origin) ]] || exit 91
    ;;
  ls-remote)
    [[ \$# == 4 && \$2 == --tags && \$3 == --refs && (\$4 == upstream || \$4 == origin) ]] || exit 91
    ;;
  rev-parse)
    [[ \$# == 2 && \$2 == refs/remotes/origin/main ]] ||
      [[ \$# == 2 && \${2:0:40} =~ ^[0-9a-fA-F]{40}\$ && \${2:40} == "\$commit_suffix" ]] || exit 91
    ;;
  merge-base)
    [[ \$# == 4 && \$2 == --is-ancestor && \$3 =~ ^[0-9a-fA-F]{40}\$ && \$4 =~ ^[0-9a-fA-F]{40}\$ ]] || exit 91
    ;;
  cat-file)
    [[ \$# == 3 && \$2 == -p && \$3 =~ ^[0-9a-fA-F]{40}\$ ]] || exit 91
    ;;
  tag)
    [[ \$# == 6 && \$2 == -a && \$3 =~ ^obsidian-v[0-9A-Za-z.+-]+-[1-9][0-9]*\$ &&
      \$4 =~ ^[0-9a-fA-F]{40}\$ && \$5 == -F && -f \$6 ]] || exit 91
    ;;
  push)
    source_ref=\${3%%:*}
    destination_ref=\${3#*:}
    [[ \$# == 3 && \$2 == origin && \$source_ref == \$destination_ref &&
      \$source_ref =~ ^refs/tags/obsidian-v[0-9A-Za-z.+-]+-[1-9][0-9]*\$ ]] || exit 91
    if [[ -n \${MOCK_PUSH_COLLISION_MODE:-} && ! -e \${MOCK_PUSH_COLLISION_STATE:?} ]]; then
      touch "\$MOCK_PUSH_COLLISION_STATE"
      "$real_git" "\$@"
      tag=\${source_ref#refs/tags/}
      if [[ \$MOCK_PUSH_COLLISION_MODE == complete ]]; then
        node -e '
          const fs = require("node:fs"), path = require("node:path")
          const tag = process.argv[1], match = /^obsidian-v(.+)-([1-9][0-9]*)$/.exec(tag)
          const release = {id: 700, tag_name: tag,
            name: "Obsidian Wordgard " + match[1] + " fork release " + match[2],
            draft: false, prerelease: match[1].includes("-"), body: "existing"}
          fs.writeFileSync(path.join(process.env.MOCK_GH_STATE, "releases", encodeURIComponent(tag) + ".json"), JSON.stringify(release))
        ' "\$tag"
      elif [[ \$MOCK_PUSH_COLLISION_MODE == inconsistent ]]; then
        "$real_git" --git-dir="\$("$real_git" remote get-url origin)" update-ref "\$destination_ref" "\${MOCK_COLLISION_WRONG_SHA:?}"
      fi
      echo 'rejected: simulated concurrent tag publication' >&2
      exit 1
    fi
    ;;
  *) exit 91 ;;
esac
exec "$real_git" "\$@"
EOF
chmod +x "$mock_bin/git"
cat > "$mock_bin/gh" <<'EOF'
#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")

const args = process.argv.slice(2)
fs.appendFileSync(process.env.MIRROR_GH_LOG, `${JSON.stringify(args)}\n`)
if (args[0] !== "api") {
  process.stderr.write("only gh api is supported\n")
  process.exit(90)
}
const methodIndex = args.indexOf("--method")
const method = methodIndex < 0 ? "GET" : args[methodIndex + 1]
const endpoint = args.find(arg => arg.startsWith("repos/"))
const failurePattern = process.env.MOCK_FAIL_ENDPOINT_PATTERN
if (failurePattern && new RegExp(failurePattern).test(`${method} ${endpoint}`)) {
  const counterFile = path.join(process.env.MOCK_GH_STATE, "failure-counter")
  const attempt = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0
  const statuses = (process.env.MOCK_FAIL_STATUSES || "").split(",").filter(Boolean).map(Number)
  fs.writeFileSync(counterFile, String(attempt + 1))
  if (attempt < statuses.length) {
    process.stderr.write(`gh: injected failure (HTTP ${statuses[attempt]})\n`)
    process.exit(1)
  }
}
if (process.env.MOCK_FAIL_ISSUES_STATUS && /\/issues(?:\?|\/|$)/.test(endpoint || "")) {
  process.stderr.write(`gh: injected issue failure (HTTP ${process.env.MOCK_FAIL_ISSUES_STATUS})\n`)
  process.exit(1)
}
const inputIndex = args.indexOf("--input")
const input = inputIndex < 0 ? null : JSON.parse(fs.readFileSync(args[inputIndex + 1], "utf8"))
const issuesFile = path.join(process.env.MOCK_GH_STATE, "issues-pages.json")
const loadIssues = () => fs.existsSync(issuesFile) ? JSON.parse(fs.readFileSync(issuesFile, "utf8")) : [[]]
const saveIssues = pages => fs.writeFileSync(issuesFile, JSON.stringify(pages))
const issueListMatch = /^repos\/[^/]+\/[^/]+\/issues\?state=(all|open|closed)&per_page=100$/.exec(endpoint || "")
if (method === "GET" && issueListMatch) {
  const state = issueListMatch[1]
  const pages = loadIssues().map(page => page.filter(issue => state === "all" || issue.state === state))
  process.stdout.write(JSON.stringify(pages))
  process.exit(0)
}
const issueMatch = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(endpoint || "")
if (method === "PATCH" && issueMatch) {
  const pages = loadIssues()
  const issue = pages.flat().find(entry => entry.number === Number(issueMatch[1]))
  if (!issue) process.exit(94)
  Object.assign(issue, input)
  saveIssues(pages)
  process.stdout.write(JSON.stringify(issue))
  process.exit(0)
}
const commentMatch = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(endpoint || "")
if (method === "POST" && commentMatch) {
  const commentsFile = path.join(process.env.MOCK_GH_STATE, "comments.jsonl")
  fs.appendFileSync(commentsFile, `${JSON.stringify({issue: Number(commentMatch[1]), ...input})}\n`)
  process.stdout.write(JSON.stringify({id: 900, ...input}))
  process.exit(0)
}
if (method === "POST" && /^repos\/[^/]+\/[^/]+\/issues$/.test(endpoint || "")) {
  const pages = loadIssues()
  const issue = {number: 88, state: "open", pull_request: null, ...input}
  pages[0].push(issue)
  saveIssues(pages)
  process.stdout.write(JSON.stringify(issue))
  process.exit(0)
}
const runMatch = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)$/.exec(endpoint || "")
if (method === "GET" && runMatch) {
  const savedRun = path.join(process.env.MOCK_GH_STATE, "runs", runMatch[1] + ".json")
  if (fs.existsSync(savedRun)) {
    process.stdout.write(fs.readFileSync(savedRun))
    process.exit(0)
  }
  const id = Number(process.env.MOCK_CI_ID || runMatch[1])
  process.stdout.write(JSON.stringify({
    id,
    event: process.env.MOCK_CI_EVENT || "push",
    head_branch: process.env.MOCK_CI_BRANCH || "main",
    head_sha: process.env.MOCK_CI_SHA,
    conclusion: process.env.MOCK_CI_CONCLUSION || "success",
    html_url: process.env.MOCK_CI_URL || `https://github.example/runs/${id}`,
  }))
  process.exit(0)
}
const releaseMatch = /^repos\/[^/]+\/[^/]+\/releases\/tags\/(.+)$/.exec(endpoint || "")
if (method === "GET" && releaseMatch) {
  const file = path.join(process.env.MOCK_GH_STATE, "releases", releaseMatch[1] + ".json")
  if (!fs.existsSync(file)) {
    process.stderr.write("gh: release not found (HTTP 404)\n")
    process.exit(1)
  }
  process.stdout.write(fs.readFileSync(file))
  process.exit(0)
}
if (method === "POST" && /\/releases$/.test(endpoint || "")) {
  if (!input) process.exit(92)
  const release = input
  release.id = 500
  const directory = path.join(process.env.MOCK_GH_STATE, "releases")
  fs.mkdirSync(directory, {recursive: true})
  fs.writeFileSync(path.join(directory, encodeURIComponent(release.tag_name) + ".json"), JSON.stringify(release))
  process.stdout.write(JSON.stringify(release))
  process.exit(0)
}
process.stderr.write(`unexpected gh api call: ${JSON.stringify(args)}\n`)
process.exit(93)
EOF
chmod +x "$mock_bin/gh"

export PATH="$mock_bin:$PATH"
export MIRROR_GIT_LOG="$tmp/git.log"
export MIRROR_GH_LOG="$tmp/gh.log"
export MOCK_GH_STATE="$tmp/gh-state"
mkdir -p "$MOCK_GH_STATE/releases"
export GITHUB_REPOSITORY='obsidianmd/wordgard'
export GITHUB_SERVER_URL='https://github.example'
export MOCK_CI_SHA="$candidate_sha"

run_mirror() {
  if [[ ${MIRROR_TEST_DRY_RUN:-1} == 1 ]]; then
    (cd "$work" && MIRROR_RELEASE_DRY_RUN=1 MIRROR_RELEASE_RETRY_DELAY_SECONDS=0 \
      node "$root/bin/mirror-release.ts" publish "${3:-obsidian-v0.3.1-2}" \
      "${1:-$candidate_sha}" "${2:-101}")
  else
    (cd "$work" && env -u MIRROR_RELEASE_DRY_RUN MIRROR_RELEASE_RETRY_DELAY_SECONDS=0 \
      node "$root/bin/mirror-release.ts" publish "${3:-obsidian-v0.3.1-2}" \
      "${1:-$candidate_sha}" "${2:-101}")
  fi
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

# Prove the command allowlist rejects anything outside the controller's contract.
if "$mock_bin/git" status >/dev/null 2>&1; then
  echo 'git command allowlist accepted an unexpected command' >&2
  exit 1
fi
: > "$MIRROR_GIT_LOG"

# A stale local SemVer and local fork-shaped tag must not affect discovery.
"$real_git" -C "$work" tag 8.0.0
"$real_git" -C "$work" tag obsidian-v0.5.0-9

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
node -e '
  const assert = require("node:assert/strict")
  assert.equal(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8").trim())[0], "api")
' "$MIRROR_GH_LOG"
# Every recorded controller command has already passed the explicit wrapper allowlist.
[[ -z $("$real_git" --git-dir="$origin" tag --list 'obsidian-v0.5.0-*') ]]

# Initial publication creates exactly one immutable annotated tag and one Release.
: > "$MIRROR_GIT_LOG"
: > "$MIRROR_GH_LOG"
MIRROR_TEST_DRY_RUN=0 run_mirror >/dev/null
stable_tag=obsidian-v0.5.0-1
[[ $("$real_git" --git-dir="$origin" tag --list "$stable_tag") == "$stable_tag" ]]
[[ $("$real_git" --git-dir="$origin" rev-parse "$stable_tag^{commit}") == "$candidate_sha" ]]
stable_message=$("$real_git" --git-dir="$origin" tag -l --format='%(contents)' "$stable_tag")
[[ $stable_message == *"Obsidian Wordgard 0.5.0 fork release 1"* ]]
[[ $stable_message == *"Upstream-Tag: v0.5.0"* ]]
[[ $stable_message == *"Upstream-Commit: $candidate_sha"* ]]
[[ $stable_message == *"Fork-Commit: $candidate_sha"* ]]
[[ $stable_message == *"CI-Run-ID: 101"* ]]
[[ $stable_message == *"CI-Run-URL: https://github.example/runs/101"* ]]
release_file="$MOCK_GH_STATE/releases/$(node -p 'encodeURIComponent(process.argv[1])' "$stable_tag").json"
node -e '
  const assert = require("node:assert/strict")
  const release = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
  assert.equal(release.tag_name, "obsidian-v0.5.0-1")
  assert.equal(release.name, "Obsidian Wordgard 0.5.0 fork release 1")
  assert.equal(release.draft, false)
  assert.equal(release.prerelease, false)
  assert.match(release.body, /Canonical tag: `v0\.5\.0`/)
  assert.match(release.body, /Upstream commit: `[0-9a-f]{40}`/)
  assert.match(release.body, /Fork tag: `obsidian-v0\.5\.0-1`/)
  assert.match(release.body, /Fork commit: `[0-9a-f]{40}`/)
  assert.match(release.body, /compare\/obsidian-v0\.3\.1-2\.\.\.obsidian-v0\.5\.0-1/)
  assert.match(release.body, /Superseded canonical tags: `0\.4\.0`/)
  assert.match(release.body, /blob\/obsidian-v0\.5\.0-1\/FORK_PATCHES\.md/)
  assert.match(release.body, /FORK_PATCHES\.md.*authoritative/)
' "$release_file"
node -e '
  const assert = require("node:assert/strict")
  const calls = require("node:fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse)
  const create = calls.find(call => call.includes("POST") && call.some(arg => /\/releases$/.test(arg)))
  assert(create)
  assert(create.includes("--input"))
  assert(!create.join(" ").includes("$(touch"))
' "$MIRROR_GH_LOG"
[[ $(grep -c '^push origin refs/tags/obsidian-v0.5.0-1:refs/tags/obsidian-v0.5.0-1 $' "$MIRROR_GIT_LOG") -eq 1 ]]
[[ $({ grep '^push ' "$MIRROR_GIT_LOG" || true; }) != *--force* ]]

# Complete state is idempotent and no eligible canonical version is a no-op.
: > "$MIRROR_GIT_LOG"
: > "$MIRROR_GH_LOG"
MIRROR_TEST_DRY_RUN=0 run_mirror >/dev/null
[[ -z $({ grep '^push ' "$MIRROR_GIT_LOG" || true; }) ]]
node -e '
  const calls = require("node:fs").readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  if (calls.some(call => call.includes("POST"))) process.exit(1)
' "$MIRROR_GH_LOG"

# A canonical prerelease is published as a non-draft GitHub prerelease.
printf '0.6.0-rc.1\n' >> "$seed/history"
"$real_git" -C "$seed" commit -qam 'release 0.6.0-rc.1'
prerelease_sha=$("$real_git" -C "$seed" rev-parse HEAD)
"$real_git" -C "$seed" tag -a 0.6.0-rc.1 -m 'Release 0.6.0-rc.1'
"$real_git" -C "$seed" push -q canonical main 0.6.0-rc.1
"$real_git" -C "$seed" push -q origin main
MOCK_CI_SHA="$prerelease_sha" MIRROR_TEST_DRY_RUN=0 run_mirror "$prerelease_sha" 102 >/dev/null
prerelease_tag=obsidian-v0.6.0-rc.1-1
prerelease_file="$MOCK_GH_STATE/releases/$(node -p 'encodeURIComponent(process.argv[1])' "$prerelease_tag").json"
node -e '
  const assert = require("node:assert/strict")
  const release = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
  assert.equal(release.draft, false)
  assert.equal(release.prerelease, true)
' "$prerelease_file"
candidate_sha=$prerelease_sha
export MOCK_CI_SHA="$candidate_sha"
[[ ! -e "$MOCK_GH_STATE/releases/$(node -p 'encodeURIComponent(process.argv[1])' obsidian-v0.3.1-2).json" ]]

# Preserve the completed fixture so each partial-state and collision case uses
# isolated real remotes and cannot hide state left by an earlier case.
original_origin=$origin
original_canonical=$canonical
original_work=$work
original_gh_state=$MOCK_GH_STATE
base_origin="$tmp/recovery-base-origin.git"
base_canonical="$tmp/recovery-base-canonical.git"
base_gh_state="$tmp/recovery-base-gh-state"
cp -a "$origin" "$base_origin"
cp -a "$canonical" "$base_canonical"
cp -a "$MOCK_GH_STATE" "$base_gh_state"

activate_case() {
  local name=$1
  origin="$tmp/$name-origin.git"
  canonical="$tmp/$name-canonical.git"
  work="$tmp/$name-work"
  export MOCK_GH_STATE="$tmp/$name-gh-state"
  cp -a "$base_origin" "$origin"
  cp -a "$base_canonical" "$canonical"
  cp -a "$base_gh_state" "$MOCK_GH_STATE"
  "$real_git" clone -q "$origin" "$work"
  "$real_git" -C "$work" remote add upstream "$canonical"
  "$real_git" -C "$work" fetch -q --tags upstream
  candidate_sha=$("$real_git" -C "$work" rev-parse HEAD)
  export MOCK_CI_SHA="$candidate_sha" MOCK_CI_ID=200
  unset MOCK_PUSH_COLLISION_MODE MOCK_PUSH_COLLISION_STATE MOCK_COLLISION_WRONG_SHA
  unset MOCK_FAIL_ENDPOINT_PATTERN MOCK_FAIL_STATUSES MOCK_FAIL_ISSUES_STATUS MOCK_CI_URL
  : > "$MIRROR_GIT_LOG"
  : > "$MIRROR_GH_LOG"
}

write_ci_run() {
  local id=$1 sha=$2
  mkdir -p "$MOCK_GH_STATE/runs"
  node -e '
    const fs = require("node:fs")
    const [file, id, sha] = process.argv.slice(1)
    fs.writeFileSync(file, JSON.stringify({id: Number(id), event: "push", head_branch: "main",
      head_sha: sha, conclusion: "success", html_url: `https://github.example/runs/${id}`}))
  ' "$MOCK_GH_STATE/runs/$id.json" "$id" "$sha"
}

create_fork_tag() {
  local tag=$1 target=$2 message=$3
  local message_file="$tmp/tag-message"
  printf '%s\n' "$message" > "$message_file"
  "$real_git" -C "$work" tag -a "$tag" "$target" -F "$message_file"
  "$real_git" -C "$work" push -q origin "refs/tags/$tag:refs/tags/$tag"
}

valid_annotation() {
  local tag=$1 target=$2 run_id=$3 upstream_tag=${4:-0.6.0-rc.1}
  local version=${tag#obsidian-v} suffix
  suffix=${version##*-}
  version=${version%-"$suffix"}
  local upstream_commit
  upstream_commit=$("$real_git" -C "$work" rev-parse "$upstream_tag^{commit}")
  printf '%s\n\n%s\n%s\n%s\n%s\n%s' \
    "Obsidian Wordgard $version fork release $suffix" \
    "Upstream-Tag: $upstream_tag" \
    "Upstream-Commit: $upstream_commit" \
    "Fork-Commit: $target" \
    "CI-Run-ID: $run_id" \
    "CI-Run-URL: https://github.example/runs/$run_id"
}

# One valid post-baseline tag without a Release resumes only that Release.
activate_case recover-partial
partial_tag=obsidian-v0.6.0-rc.1-2
write_ci_run 201 "$candidate_sha"
create_fork_tag "$partial_tag" "$candidate_sha" "$(valid_annotation "$partial_tag" "$candidate_sha" 201)"
MOCK_CI_ID=202 MIRROR_TEST_DRY_RUN=0 run_mirror "$candidate_sha" 202 >/dev/null
[[ -f "$MOCK_GH_STATE/releases/$(node -p 'encodeURIComponent(process.argv[1])' "$partial_tag").json" ]]
[[ -z $("$real_git" --git-dir="$origin" tag --list 'obsidian-v0.6.0-rc.1-3') ]]

# Recovery remains authorized after main advances when the tag target stays an ancestor.
activate_case recover-ancestor
old_tip=$candidate_sha
write_ci_run 211 "$old_tip"
create_fork_tag "$partial_tag" "$old_tip" "$(valid_annotation "$partial_tag" "$old_tip" 211)"
printf 'main advanced\n' >> "$work/history"
"$real_git" -C "$work" commit -qam 'advance main after partial publication'
"$real_git" -C "$work" push -q origin main
candidate_sha=$("$real_git" -C "$work" rev-parse HEAD)
export MOCK_CI_SHA="$candidate_sha" MOCK_CI_ID=212
MIRROR_TEST_DRY_RUN=0 run_mirror "$candidate_sha" 212 >/dev/null
[[ -f "$MOCK_GH_STATE/releases/$(node -p 'encodeURIComponent(process.argv[1])' "$partial_tag").json" ]]
[[ $("$real_git" --git-dir="$origin" rev-parse "$partial_tag^{commit}") == "$old_tip" ]]

# Missing provenance and a Fork-Commit mismatch are unsafe.
activate_case invalid-provenance
create_fork_tag "$partial_tag" "$candidate_sha" $'Obsidian Wordgard 0.6.0-rc.1 fork release 2\n\nFork-Commit: missing-fields'
MIRROR_TEST_DRY_RUN=0 expect_failure 'invalid provenance' run_mirror "$candidate_sha" 200
[[ ! -f "$MOCK_GH_STATE/releases/$(node -p 'encodeURIComponent(process.argv[1])' "$partial_tag").json" ]]

activate_case mismatched-target
write_ci_run 221 "$candidate_sha"
wrong_commit=$base_sha
message=$(valid_annotation "$partial_tag" "$candidate_sha" 221)
message=${message/Fork-Commit: $candidate_sha/Fork-Commit: $wrong_commit}
create_fork_tag "$partial_tag" "$candidate_sha" "$message"
MIRROR_TEST_DRY_RUN=0 expect_failure 'Fork-Commit does not match tag target' run_mirror "$candidate_sha" 200

# More than one incomplete post-baseline publication is ambiguous.
activate_case multiple-partials
write_ci_run 231 "$candidate_sha"
create_fork_tag "$partial_tag" "$candidate_sha" "$(valid_annotation "$partial_tag" "$candidate_sha" 231)"
second_partial=obsidian-v0.6.0-rc.1-3
create_fork_tag "$second_partial" "$candidate_sha" "$(valid_annotation "$second_partial" "$candidate_sha" 231)"
MIRROR_TEST_DRY_RUN=0 expect_failure 'multiple incomplete post-baseline tags' run_mirror "$candidate_sha" 200

add_new_canonical_release() {
  printf '0.7.0\n' >> "$work/history"
  "$real_git" -C "$work" commit -qam 'release 0.7.0'
  candidate_sha=$("$real_git" -C "$work" rev-parse HEAD)
  "$real_git" -C "$work" tag -a 0.7.0 -m 'Release 0.7.0'
  "$real_git" -C "$work" push -q origin main
  "$real_git" -C "$work" push -q upstream main 0.7.0
  export MOCK_CI_SHA="$candidate_sha" MOCK_CI_ID=240
}

# A rejected push is reconciled exactly once. It may become a complete no-op,
# resume one valid missing Release, or fail without selecting the next suffix.
for collision_mode in complete partial; do
  activate_case "collision-$collision_mode"
  add_new_canonical_release
  export MOCK_PUSH_COLLISION_MODE=$collision_mode
  export MOCK_PUSH_COLLISION_STATE="$tmp/collision-$collision_mode-fired"
  MIRROR_TEST_DRY_RUN=0 run_mirror "$candidate_sha" 240 >/dev/null
  [[ $("$real_git" --git-dir="$origin" tag --list 'obsidian-v0.7.0-*') == obsidian-v0.7.0-1 ]]
  [[ -f "$MOCK_GH_STATE/releases/obsidian-v0.7.0-1.json" ]]
done

activate_case collision-inconsistent
add_new_canonical_release
export MOCK_PUSH_COLLISION_MODE=inconsistent
export MOCK_PUSH_COLLISION_STATE="$tmp/collision-inconsistent-fired"
export MOCK_COLLISION_WRONG_SHA=$base_sha
MIRROR_TEST_DRY_RUN=0 expect_failure 'invalid provenance' run_mirror "$candidate_sha" 240
[[ $("$real_git" --git-dir="$origin" tag --list 'obsidian-v0.7.0-*') == obsidian-v0.7.0-1 ]]

# Each explicitly transient API status is retried and then succeeds.
for transient_status in 500 502 503 504; do
  activate_case "retry-$transient_status"
  export MOCK_FAIL_ENDPOINT_PATTERN='GET repos/.*/actions/runs/'
  export MOCK_FAIL_STATUSES=$transient_status
  MIRROR_TEST_DRY_RUN=0 run_mirror "$candidate_sha" 200 >/dev/null
  node -e '
    const calls = require("node:fs").readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    const runs = calls.filter(call => call.some(arg => /\/actions\/runs\//.test(arg)))
    if (runs.length !== 2) throw new Error(`expected one retry before success, got ${runs.length}`)
  ' "$MIRROR_GH_LOG"
done

# Retry exhaustion creates one actionable issue with complete known context.
activate_case retry-exhausted
add_new_canonical_release
export MOCK_FAIL_ENDPOINT_PATTERN='POST repos/.*/releases$'
export MOCK_FAIL_STATUSES='500,502,503'
MIRROR_TEST_DRY_RUN=0 expect_failure 'HTTP 503' run_mirror "$candidate_sha" 240
node -e '
  const assert = require("node:assert/strict"), fs = require("node:fs")
  const calls = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  assert.equal(calls.filter(call => call.includes("POST") && call.some(arg => /\/releases$/.test(arg))).length, 3)
  const issue = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))[0][0]
  assert.equal(issue.title, "Upstream release mirroring requires attention")
  assert.equal(issue.state, "open")
  assert.equal(issue.pull_request, null)
  assert.match(issue.body, /Candidate SHA: `[0-9a-f]{40}`/)
  assert.match(issue.body, /Selected upstream: `0\.7\.0` at `[0-9a-f]{40}`/)
  assert.match(issue.body, /Intended fork tag: `obsidian-v0\.7\.0-1`/)
' "$MIRROR_GH_LOG" "$MOCK_GH_STATE/issues-pages.json"

# A permanent 4xx is not retried. Exact-title lookup is paginated, ignores an
# exact-title pull request, reopens the real closed issue, and comments on it.
activate_case permanent-and-reopen
add_new_canonical_release
node -e '
  const fs = require("node:fs")
  const title = "Upstream release mirroring requires attention"
  fs.writeFileSync(process.argv[1], JSON.stringify([
    [{number: 1, state: "open", title, pull_request: {url: "pr"}}],
    [{number: 42, state: "closed", title, pull_request: null}],
  ]))
' "$MOCK_GH_STATE/issues-pages.json"
export MOCK_FAIL_ENDPOINT_PATTERN='POST repos/.*/releases$'
export MOCK_FAIL_STATUSES=422
sentinel="$tmp/issue-shell-interpolation-ran"
export MOCK_CI_URL="https://github.example/runs/240/\$(touch $sentinel)"
MIRROR_TEST_DRY_RUN=0 expect_failure 'HTTP 422' run_mirror "$candidate_sha" 240
[[ ! -e $sentinel ]]
node -e '
  const assert = require("node:assert/strict"), fs = require("node:fs")
  const calls = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  assert.equal(calls.filter(call => call.includes("POST") && call.some(arg => /\/releases$/.test(arg))).length, 1)
  assert(!calls.some(call => call.includes("POST") && call.some(arg => /\/issues$/.test(arg))))
  const issue = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).flat().find(item => item.number === 42)
  assert.equal(issue.state, "open")
  const comment = JSON.parse(fs.readFileSync(process.argv[3], "utf8").trim())
  assert.equal(comment.issue, 42)
  assert.match(comment.body, /Candidate SHA: `[0-9a-f]{40}`/)
  assert.match(comment.body, /CI run: `240`/)
  assert.match(comment.body, /Selected upstream: `0\.7\.0` at `[0-9a-f]{40}`/)
  assert.match(comment.body, /Intended fork tag: `obsidian-v0\.7\.0-1`/)
  assert.match(comment.body, /Observed remote state:/)
  assert.match(comment.body, /node bin\/mirror-release\.ts publish obsidian-v0\.3\.1-2 [0-9a-f]{40} 240/)
' "$MIRROR_GH_LOG" "$MOCK_GH_STATE/issues-pages.json" "$MOCK_GH_STATE/comments.jsonl"

# Successful partial recovery closes the issue that reported the interruption.
unset MOCK_FAIL_ENDPOINT_PATTERN MOCK_FAIL_STATUSES
rm -f "$MOCK_GH_STATE/failure-counter"
MIRROR_TEST_DRY_RUN=0 run_mirror "$candidate_sha" 240 >/dev/null
unset MOCK_CI_URL
node -e '
  const issue = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).flat().find(item => item.number === 42)
  if (issue.state !== "closed") process.exit(1)
' "$MOCK_GH_STATE/issues-pages.json"

# A fully consistent no-candidate run also closes a stale exact-title issue.
activate_case close-on-noop
node -e '
  const fs = require("node:fs")
  fs.writeFileSync(process.argv[1], JSON.stringify([[{number: 55, state: "open",
    title: "Upstream release mirroring requires attention", pull_request: null}]]))
' "$MOCK_GH_STATE/issues-pages.json"
MIRROR_TEST_DRY_RUN=0 run_mirror "$candidate_sha" 200 >/dev/null
node -e '
  const issue = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[0][0]
  if (issue.state !== "closed") process.exit(1)
' "$MOCK_GH_STATE/issues-pages.json"

# Failure reporting never hides the publication error that caused it.
activate_case issue-error-precedence
add_new_canonical_release
export MOCK_FAIL_ENDPOINT_PATTERN='POST repos/.*/releases$'
export MOCK_FAIL_STATUSES=422
export MOCK_FAIL_ISSUES_STATUS=503
output=''
if output=$(MIRROR_TEST_DRY_RUN=0 run_mirror "$candidate_sha" 240 2>&1); then
  echo 'expected publication and issue reporting failure' >&2
  exit 1
fi
[[ $output == *'HTTP 422'* ]]
[[ $output == *'failure reporting also failed'*'HTTP 503'* ]]

origin=$original_origin
canonical=$original_canonical
work=$original_work
export MOCK_GH_STATE=$original_gh_state
candidate_sha=$prerelease_sha
export MOCK_CI_SHA="$candidate_sha" MOCK_CI_ID=101
unset MOCK_PUSH_COLLISION_MODE MOCK_PUSH_COLLISION_STATE MOCK_COLLISION_WRONG_SHA

MOCK_CI_EVENT=pull_request expect_failure 'CI run event must be push' run_mirror
MOCK_CI_BRANCH=feature expect_failure 'CI run head branch must be main' run_mirror
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

: > "$MIRROR_GIT_LOG"
: > "$MIRROR_GH_LOG"
expect_failure 'baseline tag must have the form obsidian-v<version>-<positive-suffix>' \
  run_mirror "$stale_tip" 101 malformed
expect_failure 'baseline tag must have the form obsidian-v<version>-<positive-suffix>' \
  run_mirror "$stale_tip" 101 obsidian-vv0.3.1-2
[[ ! -s $MIRROR_GIT_LOG ]]
[[ ! -s $MIRROR_GH_LOG ]]

# The mandatory tag fetch must fail closed when remotes disagree on one name.
"$real_git" -C "$seed" push -q canonical "$candidate_sha:refs/tags/source-conflict"
"$real_git" -C "$seed" push -q origin "$stale_tip:refs/tags/source-conflict"
expect_failure 'git fetch --tags origin' run_mirror "$stale_tip"

[[ $("$real_git" --git-dir="$origin" tag --list 'obsidian-v0.5.0-*') == obsidian-v0.5.0-1 ]]
[[ $("$real_git" --git-dir="$origin" tag --list 'obsidian-v0.6.0-rc.1-*') == obsidian-v0.6.0-rc.1-1 ]]
echo 'mirror-release publication tests passed'
