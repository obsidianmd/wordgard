#!/usr/bin/env node

import {execFileSync, spawnSync} from "node:child_process"
import {mkdtempSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {
  compareSemVer,
  forkTagName,
  parseForkTag,
  parseSemVerTag,
  selectRelease,
  type CanonicalRelease,
  type ForkReleaseTag,
  type ReleaseSelection,
} from "./release-version.ts"

type CiRun = {
  id: number
  event: string
  head_branch: string
  head_sha: string
  conclusion: string | null
  html_url: string
}

type GitHubRelease = {
  id: number
  tag_name: string
  name: string
  draft: boolean
  prerelease: boolean
  body?: string
}

type GitHubIssue = {
  number: number
  state: "open" | "closed"
  title: string
  pull_request?: unknown
}

type FailureContext = {
  ciRunUrl?: string
  intendedForkTag?: string
  observedRemoteState?: string
  selected?: CanonicalRelease
}

const issueTitle = "Upstream release mirroring requires attention"
const transientStatuses = new Set([500, 502, 503, 504])
const githubAttempts = 3

let failureContext: FailureContext = {}

type TagProvenance = {
  upstreamTag: string
  upstreamCommit: string
  forkCommit: string
  ciRunId: number
  ciRunUrl: string
}

type Discovery = {
  ciRun: CiRun
  forkTags: readonly ForkReleaseTag[]
  selection: ReleaseSelection
}

type DiscoveryOptions = {
  createMissingRelease?: boolean
  collisionRetry?: boolean
}

function run(command: string, args: readonly string[], options: {cwd?: string} = {}): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function parseJson<T>(output: string, endpoint: string): T {
  try {
    return JSON.parse(output) as T
  } catch {
    throw new Error(`GitHub returned invalid JSON for ${endpoint}`)
  }
}

function retryDelayMilliseconds(): number {
  let input = process.env.MIRROR_RELEASE_RETRY_DELAY_SECONDS ?? "1"
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(input))
    throw new Error("MIRROR_RELEASE_RETRY_DELAY_SECONDS must be a non-negative number")
  return Number(input) * 1000
}

function waitBeforeRetry(): void {
  let milliseconds = retryDelayMilliseconds()
  if (milliseconds) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function githubRequest(
  args: readonly string[],
  endpoint: string,
  allowedStatuses: ReadonlySet<number> = new Set(),
): {output: string, status: number} {
  for (let attempt = 1; attempt <= githubAttempts; attempt++) {
    let result = spawnSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (result.error) throw result.error
    if (result.status == 0) return {output: result.stdout.trim(), status: 200}
    let statusMatch = /\bHTTP ([0-9]{3})\b/.exec(result.stderr)
    let status = statusMatch ? Number(statusMatch[1]) : null
    if (status != null && allowedStatuses.has(status))
      return {output: result.stdout.trim(), status}
    let message = `GitHub API request failed for ${endpoint}${result.stderr ? `: ${result.stderr.trim()}` : ""}`
    if (status == null || !transientStatuses.has(status) || attempt == githubAttempts)
      throw new Error(message)
    waitBeforeRetry()
  }
  throw new Error("unreachable GitHub retry state")
}

function githubJson<T>(endpoint: string): T {
  let response = githubRequest(["api", "--method", "GET", endpoint], endpoint)
  return parseJson<T>(response.output, endpoint)
}

function lookupRelease(tag: string): GitHubRelease | null {
  let endpoint = `repos/${requireEnvironment("GITHUB_REPOSITORY")}/releases/tags/${encodeURIComponent(tag)}`
  let response = githubRequest(["api", "--method", "GET", endpoint], endpoint, new Set([404]))
  return response.status == 404 ? null : parseJson<GitHubRelease>(response.output, endpoint)
}

function githubMutation<T>(method: "POST" | "PATCH", endpoint: string, body: object): T {
  let directory = mkdtempSync(join(tmpdir(), "wordgard-github-"))
  let input = join(directory, "input.json")
  try {
    writeFileSync(input, JSON.stringify(body))
    let response = githubRequest(["api", "--method", method, endpoint, "--input", input], endpoint)
    return parseJson<T>(response.output, endpoint)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
}

function createRelease(release: Omit<GitHubRelease, "id">): GitHubRelease {
  let endpoint = `repos/${requireEnvironment("GITHUB_REPOSITORY")}/releases`
  return githubMutation<GitHubRelease>("POST", endpoint, release)
}

function validateCiRun(ciRun: CiRun, candidateSha: string, expectedRunId = cliInputs.ciRunId): void {
  if (!ciRun || typeof ciRun != "object") throw new Error("CI run response must be an object")
  if (typeof ciRun.id != "number" || ciRun.id != expectedRunId)
    throw new Error("CI run ID does not match requested run")
  if (ciRun.event != "push") throw new Error("CI run event must be push")
  if (ciRun.head_branch != "main") throw new Error("CI run head branch must be main")
  if (typeof ciRun.head_sha != "string" || ciRun.head_sha.toLowerCase() != candidateSha)
    throw new Error("CI run head SHA does not match candidate")
  if (ciRun.conclusion != "success") throw new Error("CI run conclusion must be success")
  if (typeof ciRun.html_url != "string" || !ciRun.html_url)
    throw new Error("CI run URL must be a non-empty string")
}

function isAncestor(ancestor: string, descendant: string): boolean {
  let result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.error) throw result.error
  if (result.status == 0) return true
  if (result.status == 1) return false
  throw new Error(`git merge-base failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`)
}

function validateBaselineSyntax(tag: string): void {
  if (!tag.startsWith("obsidian-v"))
    throw new Error("baseline tag must have the form obsidian-v<version>-<positive-suffix>")
  let suffixSeparator = tag.lastIndexOf("-")
  let version = tag.slice("obsidian-v".length, suffixSeparator)
  let suffix = tag.slice(suffixSeparator + 1)
  let parsedVersion = parseSemVerTag(version)
  if (!parsedVersion || parsedVersion.normalized != version || !/^[1-9][0-9]*$/.test(suffix))
    throw new Error("baseline tag must have the form obsidian-v<version>-<positive-suffix>")
}

function listRemoteTags(remote: "upstream" | "origin"): ReadonlyMap<string, string> {
  let output = run("git", ["ls-remote", "--tags", "--refs", remote])
  let tags = new Map<string, string>()
  if (!output) return tags
  for (let line of output.split("\n")) {
    let match = /^([0-9a-fA-F]{40})\trefs\/tags\/(.+)$/.exec(line)
    if (!match) throw new Error(`invalid tag response from ${remote}`)
    let object = match[1].toLowerCase(), tag = match[2]
    let previous = tags.get(tag)
    if (previous && previous != object) throw new Error(`conflicting ${remote} tag refs: ${tag}`)
    tags.set(tag, object)
  }
  return tags
}

function discoverRepositoryState(
  baselineTag: string,
  candidateSha: string,
  options: DiscoveryOptions = {},
): Discovery {
  run("git", ["fetch", "--no-tags", "origin", "main"])
  run("git", ["fetch", "--tags", "upstream"])
  if (!options.collisionRetry) run("git", ["fetch", "--tags", "origin"])

  let upstreamTags = listRemoteTags("upstream")
  let originTags = listRemoteTags("origin")
  for (let [tag, upstreamObject] of upstreamTags) {
    let originObject = originTags.get(tag)
    if (originObject && originObject != upstreamObject)
      throw new Error(`conflicting upstream and origin tag refs: ${tag}`)
  }

  let canonical: CanonicalRelease[] = []
  for (let [tag, object] of upstreamTags) {
    let version = parseSemVerTag(tag)
    if (!version) continue
    canonical.push({
      tag,
      version,
      commit: run("git", ["rev-parse", `${object}^{commit}`]).toLowerCase(),
    })
  }

  let forkTags: ForkReleaseTag[] = []
  for (let [tag, object] of originTags) {
    if (!parseForkTag(tag, "", canonical)) continue
    if (options.collisionRetry)
      run("git", ["fetch", "--no-tags", "origin", `refs/tags/${tag}`])
    let commit = run("git", ["rev-parse", `${object}^{commit}`]).toLowerCase()
    forkTags.push(parseForkTag(tag, commit, canonical)!)
  }
  let baseline = forkTags.find(tag => tag.tag == baselineTag)
  if (!baseline) throw new Error(`baseline tag not found: ${baselineTag}`)

  let originMain = run("git", ["rev-parse", "refs/remotes/origin/main"]).toLowerCase()
  if (candidateSha != originMain) throw new Error("candidate SHA is not origin/main")

  let ciRun = githubJson<CiRun>(
    `repos/${requireEnvironment("GITHUB_REPOSITORY")}/actions/runs/${cliInputs.ciRunId}`,
  )
  validateCiRun(ciRun, candidateSha)
  failureContext.ciRunUrl = ciRun.html_url

  let completedReleaseTags = new Set<string>()
  let incomplete: ForkReleaseTag[] = []
  let observedState: string[] = []
  for (let tag of forkTags) {
    if (compareSemVer(tag.version, baseline.version) <= 0) continue
    let release = lookupRelease(tag.tag)
    if (!release) {
      incomplete.push(tag)
      observedState.push(`${tag.tag}: tag exists, GitHub Release missing`)
      continue
    }
    validateRelease(release, tag)
    completedReleaseTags.add(tag.tag)
    observedState.push(`${tag.tag}: tag and GitHub Release complete`)
  }
  failureContext.observedRemoteState = observedState.length ? observedState.sort().join("; ") :
    "no post-baseline fork tags"
  if (incomplete.length > 1)
    throw new Error(`multiple incomplete post-baseline tags: ${incomplete.map(tag => tag.tag).sort().join(", ")}`)
  if (incomplete.length) {
    let tag = incomplete[0]
    let provenance = validateIncompleteTag(tag, originTags.get(tag.tag)!, canonical, originMain)
    if (options.createMissingRelease) {
      let previous = previousForkTag(baseline, forkTags, completedReleaseTags, tag)
      let canonicalRelease = canonical.find(release => release.tag == provenance.upstreamTag)!
      let superseded = canonical.filter(release =>
        compareSemVer(release.version, previous.version) > 0 &&
        compareSemVer(release.version, tag.version) < 0 &&
        isAncestor(release.commit, tag.commit))
      createReleaseForTag(tag, canonicalRelease, previous.tag, superseded)
      completedReleaseTags.add(tag.tag)
    }
  }

  let reachableCanonicalTags = new Set<string>()
  for (let release of canonical)
    if (isAncestor(release.commit, candidateSha)) reachableCanonicalTags.add(release.tag)

  let baselineCanonical = canonical.filter(release =>
    release.version.normalized == baseline.version.normalized)
  if (!baselineCanonical.some(release => reachableCanonicalTags.has(release.tag)))
    throw new Error("canonical baseline tag is not reachable from candidate")

  let selection = selectRelease({
    canonical,
    reachableCanonicalTags,
    forkTags,
    completedReleaseTags,
    baselineTag,
  })
  return {ciRun, forkTags, selection}
}

function validateRelease(release: GitHubRelease, tag: ForkReleaseTag): void {
  if (!release || typeof release != "object" || typeof release.id != "number" ||
      release.tag_name != tag.tag || release.name != releaseTitle(tag.version.normalized, tag.suffix) ||
      release.draft !== false || release.prerelease !== Boolean(tag.version.prerelease.length))
    throw new Error(`inconsistent GitHub Release for ${tag.tag}`)
}

function parseTagProvenance(object: string, tag: ForkReleaseTag): TagProvenance {
  let raw = run("git", ["cat-file", "-p", object])
  let separator = raw.indexOf("\n\n")
  if (separator < 0 || !raw.startsWith("object ")) throw new Error(`invalid provenance for ${tag.tag}`)
  let message = raw.slice(separator + 2)
  let expectedTitle = releaseTitle(tag.version.normalized, tag.suffix)
  if (message.split("\n", 1)[0] != expectedTitle) throw new Error(`invalid provenance for ${tag.tag}`)
  let values = new Map<string, string>()
  for (let field of ["Upstream-Tag", "Upstream-Commit", "Fork-Commit", "CI-Run-ID", "CI-Run-URL"]) {
    let matches = [...message.matchAll(new RegExp(`^${field}: (.*)$`, "gm"))]
    if (matches.length != 1 || !matches[0][1]) throw new Error(`invalid provenance for ${tag.tag}`)
    values.set(field, matches[0][1])
  }
  let ciRunInput = values.get("CI-Run-ID")!
  if (!/^[1-9][0-9]*$/.test(ciRunInput) || !Number.isSafeInteger(Number(ciRunInput)))
    throw new Error(`invalid provenance for ${tag.tag}`)
  for (let field of ["Upstream-Commit", "Fork-Commit"])
    if (!/^[0-9a-fA-F]{40}$/.test(values.get(field)!))
      throw new Error(`invalid provenance for ${tag.tag}`)
  return {
    upstreamTag: values.get("Upstream-Tag")!,
    upstreamCommit: values.get("Upstream-Commit")!.toLowerCase(),
    forkCommit: values.get("Fork-Commit")!.toLowerCase(),
    ciRunId: Number(ciRunInput),
    ciRunUrl: values.get("CI-Run-URL")!,
  }
}

function validateIncompleteTag(
  tag: ForkReleaseTag,
  object: string,
  canonical: readonly CanonicalRelease[],
  originMain: string,
): TagProvenance {
  let provenance = parseTagProvenance(object, tag)
  if (provenance.forkCommit != tag.commit)
    throw new Error(`Fork-Commit does not match tag target for ${tag.tag}`)
  let upstream = canonical.find(release => release.tag == provenance.upstreamTag)
  if (!upstream || upstream.version.normalized != tag.version.normalized ||
      upstream.commit != provenance.upstreamCommit)
    throw new Error(`invalid provenance for ${tag.tag}`)
  let ciRun = githubJson<CiRun>(
    `repos/${requireEnvironment("GITHUB_REPOSITORY")}/actions/runs/${provenance.ciRunId}`,
  )
  validateCiRun(ciRun, tag.commit, provenance.ciRunId)
  if (ciRun.html_url != provenance.ciRunUrl)
    throw new Error(`CI run URL does not match tag provenance for ${tag.tag}`)
  if (!isAncestor(tag.commit, originMain))
    throw new Error(`tag target is not an ancestor of origin/main: ${tag.tag}`)
  return provenance
}

function previousForkTag(
  baseline: ForkReleaseTag,
  forkTags: readonly ForkReleaseTag[],
  completed: ReadonlySet<string>,
  before: ForkReleaseTag,
): ForkReleaseTag {
  return forkTags.filter(tag =>
    (tag.tag == baseline.tag || completed.has(tag.tag)) &&
    (compareSemVer(tag.version, before.version) < 0 ||
      (compareSemVer(tag.version, before.version) == 0 && tag.suffix < before.suffix)))
    .sort((left, right) => compareSemVer(left.version, right.version) ||
      (left.suffix < right.suffix ? -1 : left.suffix > right.suffix ? 1 : 0))
    .at(-1) ?? baseline
}

function releaseTitle(version: string, suffix: bigint): string {
  return `Obsidian Wordgard ${version} fork release ${suffix}`
}

function releaseNotes(
  selected: CanonicalRelease,
  forkTag: string,
  forkCommit: string,
  previousTag: string,
  superseded: readonly CanonicalRelease[],
): string {
  let repositoryUrl = `${requireEnvironment("GITHUB_SERVER_URL")}/${requireEnvironment("GITHUB_REPOSITORY")}`
  let skipped = superseded.length
    ? superseded.map(release => `\`${release.tag}\``).join(", ")
    : "None"
  return [
    `Canonical tag: \`${selected.tag}\``,
    `Upstream commit: \`${selected.commit}\``,
    `Fork tag: \`${forkTag}\``,
    `Fork commit: \`${forkCommit}\``,
    `Previous fork release: [\`${previousTag}\`](${repositoryUrl}/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(forkTag)})`,
    `Superseded canonical tags: ${skipped}`,
    `Fork patch ledger: [\`FORK_PATCHES.md\`](${repositoryUrl}/blob/${encodeURIComponent(forkTag)}/FORK_PATCHES.md)`,
    "`FORK_PATCHES.md`, not these generated release notes, is authoritative for fork patch status.",
  ].join("\n\n")
}

function createReleaseForTag(
  tag: ForkReleaseTag,
  canonical: CanonicalRelease,
  previousTag: string,
  superseded: readonly CanonicalRelease[],
): GitHubRelease {
  let release = createRelease({
    tag_name: tag.tag,
    name: releaseTitle(tag.version.normalized, tag.suffix),
    draft: false,
    prerelease: Boolean(tag.version.prerelease.length),
    body: releaseNotes(canonical, tag.tag, tag.commit, previousTag, superseded),
  })
  validateRelease(release, tag)
  return release
}

function publish(): Discovery {
  let refreshed = discoverRepositoryState(cliInputs.baselineTag, cliInputs.candidateSha, {
    createMissingRelease: true,
  })
  let selected = refreshed.selection.selected
  if (!selected || refreshed.selection.nextSuffix == null) return refreshed

  let suffix = refreshed.selection.nextSuffix
  let forkTag = forkTagName(selected.version, suffix)
  let title = releaseTitle(selected.version.normalized, suffix)
  failureContext.selected = selected
  failureContext.intendedForkTag = forkTag
  let annotation = [
    title,
    "",
    `Upstream-Tag: ${selected.tag}`,
    `Upstream-Commit: ${selected.commit}`,
    `Fork-Commit: ${cliInputs.candidateSha}`,
    `CI-Run-ID: ${refreshed.ciRun.id}`,
    `CI-Run-URL: ${refreshed.ciRun.html_url}`,
    "",
  ].join("\n")
  let directory = mkdtempSync(join(tmpdir(), "wordgard-tag-"))
  let messageFile = join(directory, "message")
  try {
    writeFileSync(messageFile, annotation)
    run("git", ["tag", "-a", forkTag, cliInputs.candidateSha, "-F", messageFile])
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }

  let pushFailed = false
  try {
    run("git", ["push", "origin", `refs/tags/${forkTag}:refs/tags/${forkTag}`])
  } catch {
    pushFailed = true
  }
  if (pushFailed) {
    let reconciled = discoverRepositoryState(cliInputs.baselineTag, cliInputs.candidateSha, {
      collisionRetry: true,
      createMissingRelease: true,
    })
    let retriedSelection = reconciled.selection
    if (!retriedSelection.selected) return reconciled
    let retriedTag = retriedSelection.nextSuffix == null ? null :
      forkTagName(retriedSelection.selected.version, retriedSelection.nextSuffix)
    if (retriedTag != forkTag)
      throw new Error(`tag push collision left unsafe remote state for ${forkTag}`)
    run("git", ["push", "origin", `refs/tags/${forkTag}:refs/tags/${forkTag}`])
  }

  let remoteTags = listRemoteTags("origin")
  let remoteObject = remoteTags.get(forkTag)
  if (!remoteObject) throw new Error(`pushed tag not found on origin: ${forkTag}`)
  let remoteCommit = run("git", ["rev-parse", `${remoteObject}^{commit}`]).toLowerCase()
  if (remoteCommit != cliInputs.candidateSha)
    throw new Error(`pushed tag target does not match candidate: ${forkTag}`)
  failureContext.observedRemoteState =
    `${forkTag}: tag points to ${remoteCommit}, GitHub Release missing`

  let previous = refreshed.forkTags
    .filter(tag => tag.tag == refreshed.selection.baseline.tag ||
      compareSemVer(tag.version, refreshed.selection.baseline.version) > 0)
    .sort((left, right) => compareSemVer(left.version, right.version) ||
      (left.suffix < right.suffix ? -1 : left.suffix > right.suffix ? 1 : 0))
    .at(-1) ?? refreshed.selection.baseline
  createReleaseForTag({
    tag: forkTag,
    version: selected.version,
    suffix,
    commit: cliInputs.candidateSha,
  }, selected, previous.tag, refreshed.selection.superseded)
  return refreshed
}

function buildPlan(discovery: Discovery): object {
  let selected = discovery.selection.selected
  return {
    baselineTag: discovery.selection.baseline.tag,
    candidateSha: cliInputs.candidateSha,
    ciRun: {id: discovery.ciRun.id, url: discovery.ciRun.html_url},
    watermark: discovery.selection.watermark.normalized,
    selected: selected ? {
      tag: selected.tag,
      version: selected.version.normalized,
      commit: selected.commit,
    } : null,
    supersededTags: discovery.selection.superseded.map(release => release.tag).sort(),
    proposedForkTag: selected && discovery.selection.nextSuffix != null
      ? forkTagName(selected.version, discovery.selection.nextSuffix)
      : null,
  }
}

function findFailureIssue(): GitHubIssue | null {
  let endpoint = `repos/${requireEnvironment("GITHUB_REPOSITORY")}/issues?state=all&per_page=100`
  let response = githubRequest(["api", "--paginate", "--slurp", endpoint], endpoint)
  let pages = parseJson<unknown>(response.output, endpoint)
  if (!Array.isArray(pages) || !pages.every(Array.isArray))
    throw new Error(`GitHub returned invalid issue pages for ${endpoint}`)
  for (let page of pages) for (let value of page) {
    if (!value || typeof value != "object") continue
    let issue = value as Partial<GitHubIssue>
    if (issue.title == issueTitle && issue.pull_request == null &&
        typeof issue.number == "number" && (issue.state == "open" || issue.state == "closed"))
      return issue as GitHubIssue
  }
  return null
}

function failureIssueBody(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  let selected = failureContext.selected
    ? `\`${failureContext.selected.version.normalized}\` at \`${failureContext.selected.commit}\` (canonical tag: \`${failureContext.selected.tag}\`)`
    : "not selected"
  return [
    "The upstream release mirror stopped without bypassing or rewriting remote state.",
    "",
    `Failure: ${message}`,
    `Candidate SHA: \`${cliInputs.candidateSha}\``,
    `CI run: \`${cliInputs.ciRunId}\`${failureContext.ciRunUrl ? ` (${failureContext.ciRunUrl})` : ""}`,
    `Selected upstream: ${selected}`,
    `Intended fork tag: ${failureContext.intendedForkTag ? `\`${failureContext.intendedForkTag}\`` : "not named"}`,
    `Observed remote state: ${failureContext.observedRemoteState ?? "unavailable"}`,
    "",
    "Recover idempotently after correcting the reported state:",
    "```sh",
    `node bin/mirror-release.ts publish ${cliInputs.baselineTag} ${cliInputs.candidateSha} ${cliInputs.ciRunId}`,
    "```",
  ].join("\n")
}

function reportFailure(error: unknown): void {
  let body = failureIssueBody(error)
  let repository = requireEnvironment("GITHUB_REPOSITORY")
  let issue = findFailureIssue()
  if (!issue) {
    githubMutation<GitHubIssue>("POST", `repos/${repository}/issues`, {title: issueTitle, body})
    return
  }
  if (issue.state == "closed")
    githubMutation<GitHubIssue>("PATCH", `repos/${repository}/issues/${issue.number}`, {state: "open"})
  githubMutation<{id: number}>("POST", `repos/${repository}/issues/${issue.number}/comments`, {body})
}

function closeFailureIssue(): void {
  let issue = findFailureIssue()
  if (issue?.state == "open")
    githubMutation<GitHubIssue>("PATCH",
      `repos/${requireEnvironment("GITHUB_REPOSITORY")}/issues/${issue.number}`, {state: "closed"})
}

function requireEnvironment(name: string): string {
  let value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function parseInputs(): {baselineTag: string, candidateSha: string, ciRunId: number} {
  let [command, baselineTag, candidateInput, ciRunInput, ...extra] = process.argv.slice(2)
  if (command != "publish" || !baselineTag || !candidateInput || !ciRunInput || extra.length)
    throw new Error("usage: mirror-release.ts publish BASELINE_TAG CANDIDATE_SHA CI_RUN_ID")
  validateBaselineSyntax(baselineTag)
  if (!/^[0-9a-fA-F]{40}$/.test(candidateInput))
    throw new Error("candidate SHA must be exactly 40 hexadecimal characters")
  if (!/^[1-9][0-9]*$/.test(ciRunInput))
    throw new Error("CI run ID must be a positive decimal integer")
  let ciRunId = Number(ciRunInput)
  if (!Number.isSafeInteger(ciRunId)) throw new Error("CI run ID must be a positive decimal integer")
  requireEnvironment("GITHUB_REPOSITORY")
  requireEnvironment("GITHUB_SERVER_URL")
  if (process.env.MIRROR_RELEASE_DRY_RUN && process.env.MIRROR_RELEASE_DRY_RUN != "1")
    throw new Error("MIRROR_RELEASE_DRY_RUN must be 1 when set")
  return {baselineTag, candidateSha: candidateInput.toLowerCase(), ciRunId}
}

let cliInputs: {baselineTag: string, candidateSha: string, ciRunId: number}
let inputsParsed = false
let dryRun = false

try {
  cliInputs = parseInputs()
  inputsParsed = true
  dryRun = process.env.MIRROR_RELEASE_DRY_RUN == "1"
  let discovery: Discovery
  if (dryRun) {
    discovery = discoverRepositoryState(cliInputs.baselineTag, cliInputs.candidateSha)
  } else {
    discovery = publish()
    closeFailureIssue()
  }
  process.stdout.write(`${JSON.stringify(buildPlan(discovery))}\n`)
} catch (error) {
  let message = error instanceof Error ? error.message : String(error)
  if (inputsParsed && !dryRun) {
    try {
      reportFailure(error)
    } catch (reportingError) {
      let reportingMessage = reportingError instanceof Error ? reportingError.message : String(reportingError)
      message += `; failure reporting also failed: ${reportingMessage}`
    }
  }
  process.stderr.write(`mirror-release: ${message}\n`)
  process.exitCode = 1
}
