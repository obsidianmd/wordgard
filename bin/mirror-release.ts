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
  path: string
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

type GitHubReleaseInput = Omit<GitHubRelease, "id" | "body"> & {body: string}

type GitHubIssue = {
  number: number
  state: "open" | "closed"
  title: string
  body?: string
  pull_request?: unknown
}

type GitHubIssueComment = {
  id: number
  body: string
}

type FailureContext = {
  ciRunUrl?: string
  intendedForkTag?: string
  observedRemoteState?: string
  selected?: CanonicalRelease
}

const issueTitle = "Upstream release mirroring requires attention"
const transientStatuses = new Set([500, 502, 503, 504])
const networkAttempts = 3

class GitHubRequestError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null) {
    super(message)
    this.status = status
  }
}

let failureContext: FailureContext = {}

type TagProvenance = {
  upstreamTag: string
  upstreamCommit: string
  forkCommit: string
  ciRunId: number
  ciRunUrl: string
  previousForkTag: string
  supersededCanonicalTags: readonly string[]
}

type RecoveryOutcome = {
  tag: ForkReleaseTag
  performed: boolean
}

type PublicationOutcome = {
  tag: ForkReleaseTag
  performed: true
}

type Discovery = {
  originMain: string
  ciRun: CiRun
  forkTags: readonly ForkReleaseTag[]
  selection: ReleaseSelection
  recovery: RecoveryOutcome | null
  publication?: PublicationOutcome
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

function runGitNetworkRead(args: readonly string[]): string {
  for (let attempt = 1; attempt <= networkAttempts; attempt++) {
    try {
      return run("git", args)
    } catch (error) {
      if (attempt == networkAttempts) throw error
      waitBeforeRetry()
    }
  }
  throw new Error("unreachable Git network retry state")
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

function githubRequestOnce(
  args: readonly string[],
  endpoint: string,
  allowedStatuses: ReadonlySet<number> = new Set(),
): {output: string, status: number} {
  let result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.error)
    throw new GitHubRequestError(`GitHub API request failed for ${endpoint}: ${errorMessage(result.error)}`, null)
  if (result.status == 0) return {output: result.stdout.trim(), status: 200}
  let statusMatch = /\bHTTP ([0-9]{3})\b/.exec(result.stderr)
  let status = statusMatch ? Number(statusMatch[1]) : null
  if (status != null && allowedStatuses.has(status))
    return {output: result.stdout.trim(), status}
  let message = `GitHub API request failed for ${endpoint}${result.stderr ? `: ${result.stderr.trim()}` : ""}`
  throw new GitHubRequestError(message, status)
}

function githubRequest(
  args: readonly string[],
  endpoint: string,
  allowedStatuses: ReadonlySet<number> = new Set(),
): {output: string, status: number} {
  for (let attempt = 1; attempt <= networkAttempts; attempt++) {
    try {
      return githubRequestOnce(args, endpoint, allowedStatuses)
    } catch (error) {
      if (!(error instanceof GitHubRequestError) ||
          (error.status != null && !transientStatuses.has(error.status)) ||
          attempt == networkAttempts)
        throw error
      waitBeforeRetry()
    }
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

function cleanupTemporaryDirectory(directory: string, operationFailed: boolean): void {
  try {
    rmSync(directory, {recursive: true, force: true})
  } catch (error) {
    if (!operationFailed) throw error
  }
}

function githubMutation<T>(method: "POST" | "PATCH", endpoint: string, body: object): T {
  let directory = mkdtempSync(join(tmpdir(), "wordgard-github-"))
  let input = join(directory, "input.json")
  let operationFailed = true
  try {
    writeFileSync(input, JSON.stringify(body))
    let response = githubRequestOnce(
      ["api", "--method", method, endpoint, "--input", input],
      endpoint,
    )
    let parsed = parseJson<T>(response.output, endpoint)
    operationFailed = false
    return parsed
  } finally {
    cleanupTemporaryDirectory(directory, operationFailed)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reconciledMutation<T>(
  method: "POST" | "PATCH",
  endpoint: string,
  body: object,
  reconcile: () => T | null,
): T {
  for (let attempt = 1; attempt <= networkAttempts; attempt++) {
    try {
      return githubMutation<T>(method, endpoint, body)
    } catch (error) {
      let reconciled: T | null
      try {
        reconciled = reconcile()
      } catch (reconciliationError) {
        throw new Error(
          `${errorMessage(error)}; mutation reconciliation also failed: ${errorMessage(reconciliationError)}`,
          {cause: error},
        )
      }
      if (reconciled != null) return reconciled
      if (!(error instanceof GitHubRequestError) || error.status == null ||
          !transientStatuses.has(error.status) || attempt == networkAttempts)
        throw error
      waitBeforeRetry()
    }
  }
  throw new Error("unreachable GitHub mutation retry state")
}

function createRelease(release: GitHubReleaseInput): GitHubRelease {
  let endpoint = `repos/${requireEnvironment("GITHUB_REPOSITORY")}/releases`
  return reconciledMutation<GitHubRelease>("POST", endpoint, release, () => {
    let existing = lookupRelease(release.tag_name)
    if (existing) validateRelease(existing, release)
    return existing
  })
}

function validateCiRun(ciRun: CiRun, candidateSha: string, expectedRunId = cliInputs.ciRunId): void {
  if (!ciRun || typeof ciRun != "object") throw new Error("CI run response must be an object")
  if (typeof ciRun.id != "number" || ciRun.id != expectedRunId)
    throw new Error("CI run ID does not match requested run")
  if (ciRun.event != "push") throw new Error("CI run event must be push")
  if (ciRun.path != ".github/workflows/ci.yml" && ciRun.path != ".github/workflows/ci.yml@main")
    throw new Error("CI run workflow path must be .github/workflows/ci.yml or .github/workflows/ci.yml@main")
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
  let output = runGitNetworkRead(["ls-remote", "--tags", "--refs", remote])
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

function fetchOriginMainForCandidate(candidateSha: string): string {
  runGitNetworkRead(["fetch", "--no-tags", "origin", "main"])
  let originMain = run("git", ["rev-parse", "refs/remotes/origin/main"]).toLowerCase()
  if (!isAncestor(candidateSha, originMain))
    throw new Error("candidate SHA is not an ancestor of origin/main")
  return originMain
}

function discoverRepositoryState(
  baselineTag: string,
  candidateSha: string,
  options: DiscoveryOptions = {},
): Discovery {
  let originMain = fetchOriginMainForCandidate(candidateSha)
  runGitNetworkRead(["fetch", "--tags", "upstream"])
  if (!options.collisionRetry) runGitNetworkRead(["fetch", "--tags", "origin"])

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
      runGitNetworkRead(["fetch", "--no-tags", "origin", `refs/tags/${tag}`])
    let commit = run("git", ["rev-parse", `${object}^{commit}`]).toLowerCase()
    forkTags.push(parseForkTag(tag, commit, canonical)!)
  }
  let baseline = forkTags.find(tag => tag.tag == baselineTag)
  if (!baseline) throw new Error(`baseline tag not found: ${baselineTag}`)

  let ciRun = githubJson<CiRun>(
    `repos/${requireEnvironment("GITHUB_REPOSITORY")}/actions/runs/${cliInputs.ciRunId}`,
  )
  validateCiRun(ciRun, candidateSha)
  failureContext.ciRunUrl = ciRun.html_url

  let reachableCanonicalTags = new Set<string>()
  for (let release of canonical)
    if (isAncestor(release.commit, candidateSha)) reachableCanonicalTags.add(release.tag)

  let baselineCanonical = canonical.filter(release =>
    release.version.normalized == baseline.version.normalized)
  if (!baselineCanonical.some(release => reachableCanonicalTags.has(release.tag)))
    throw new Error("canonical baseline tag is not reachable from candidate")

  let completedReleaseTags = new Set<string>()
  let incomplete: {tag: ForkReleaseTag, provenance: TagProvenance}[] = []
  let observedState: string[] = []
  for (let tag of [...forkTags].sort(compareForkTags)) {
    if (compareSemVer(tag.version, baseline.version) <= 0) continue
    let provenance = validateTagProvenance(
      tag,
      originTags.get(tag.tag)!,
      canonical,
      forkTags,
      originMain,
    )
    let release = lookupRelease(tag.tag)
    if (!release) {
      incomplete.push({tag, provenance})
      observedState.push(`${tag.tag}: tag exists, GitHub Release missing`)
      continue
    }
    let canonicalRelease = canonical.find(release => release.tag == provenance.upstreamTag)!
    validateRelease(release, releaseInputForTag(
      tag,
      canonicalRelease,
      provenance.previousForkTag,
      provenance.supersededCanonicalTags,
    ))
    completedReleaseTags.add(tag.tag)
    observedState.push(`${tag.tag}: tag and GitHub Release complete`)
  }
  failureContext.observedRemoteState = observedState.length ? observedState.sort().join("; ") :
    "no post-baseline fork tags"
  if (incomplete.length > 1)
    throw new Error(`multiple incomplete post-baseline tags: ${incomplete.map(entry => entry.tag.tag).sort().join(", ")}`)
  if (incomplete.length) {
    let {tag, provenance} = incomplete[0]
    let performed = Boolean(options.createMissingRelease)
    if (performed) {
      let canonicalRelease = canonical.find(release => release.tag == provenance.upstreamTag)!
      createReleaseForTag(
        tag,
        canonicalRelease,
        provenance.previousForkTag,
        provenance.supersededCanonicalTags,
      )
      completedReleaseTags.add(tag.tag)
      failureContext.observedRemoteState = `${tag.tag}: tag and GitHub Release complete`
    }
    let selection = selectRelease({
      canonical,
      reachableCanonicalTags: performed ? reachableCanonicalTags : new Set(),
      forkTags,
      completedReleaseTags,
      baselineTag,
    })
    return {originMain, ciRun, forkTags, selection, recovery: {tag, performed}}
  }

  let selection = selectRelease({
    canonical,
    reachableCanonicalTags,
    forkTags,
    completedReleaseTags,
    baselineTag,
  })
  return {originMain, ciRun, forkTags, selection, recovery: null}
}

function validateRelease(release: GitHubRelease, expected: GitHubReleaseInput): void {
  if (!release || typeof release != "object" || typeof release.id != "number" ||
      release.tag_name != expected.tag_name || release.name != expected.name ||
      release.draft !== expected.draft || release.prerelease !== expected.prerelease ||
      release.body !== expected.body)
    throw new Error(`inconsistent GitHub Release for ${expected.tag_name}`)
}

function invalidTagProvenance(tag: ForkReleaseTag): never {
  throw new Error(`invalid provenance for ${tag.tag}`)
}

function parseSupersededCanonicalTags(input: string, tag: ForkReleaseTag): readonly string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return invalidTagProvenance(tag)
  }
  if (!Array.isArray(parsed) || !parsed.every(value => typeof value == "string") ||
      JSON.stringify(parsed) != input)
    return invalidTagProvenance(tag)

  let names = parsed as string[]
  let normalizedVersions = new Set<string>()
  let previousName: string | null = null
  let previousVersion: ReturnType<typeof parseSemVerTag> = null
  for (let name of names) {
    let version = parseSemVerTag(name)
    if (!version || normalizedVersions.has(version.normalized)) return invalidTagProvenance(tag)
    if (previousName != null && previousVersion != null) {
      let order = compareSemVer(previousVersion, version)
      if (order > 0 || (order == 0 && previousName >= name)) return invalidTagProvenance(tag)
    }
    normalizedVersions.add(version.normalized)
    previousName = name
    previousVersion = version
  }
  return names
}

function parseTagProvenance(object: string, tag: ForkReleaseTag): TagProvenance {
  let raw = run("git", ["cat-file", "-p", object])
  let separator = raw.indexOf("\n\n")
  let tagObject = /^object ([0-9a-fA-F]{40})\ntype commit\ntag ([^\n]+)\n/.exec(raw)
  if (separator < 0 || !tagObject || tagObject[1].toLowerCase() != tag.commit ||
      tagObject[2] != tag.tag)
    return invalidTagProvenance(tag)
  let message = raw.slice(separator + 2)
  let expectedTitle = releaseTitle(tag.version.normalized, tag.suffix)
  if (message.split("\n", 1)[0] != expectedTitle) return invalidTagProvenance(tag)
  let values = new Map<string, string>()
  for (let field of [
    "Upstream-Tag",
    "Upstream-Commit",
    "Fork-Commit",
    "CI-Run-ID",
    "CI-Run-URL",
    "Previous-Fork-Tag",
    "Superseded-Canonical-Tags",
  ]) {
    let matches = [...message.matchAll(new RegExp(`^${field}: (.*)$`, "gm"))]
    if (matches.length != 1 || !matches[0][1]) return invalidTagProvenance(tag)
    values.set(field, matches[0][1])
  }
  let ciRunInput = values.get("CI-Run-ID")!
  if (!/^[1-9][0-9]*$/.test(ciRunInput) || !Number.isSafeInteger(Number(ciRunInput)))
    return invalidTagProvenance(tag)
  for (let field of ["Upstream-Commit", "Fork-Commit"])
    if (!/^[0-9a-fA-F]{40}$/.test(values.get(field)!)) return invalidTagProvenance(tag)
  return {
    upstreamTag: values.get("Upstream-Tag")!,
    upstreamCommit: values.get("Upstream-Commit")!.toLowerCase(),
    forkCommit: values.get("Fork-Commit")!.toLowerCase(),
    ciRunId: Number(ciRunInput),
    ciRunUrl: values.get("CI-Run-URL")!,
    previousForkTag: values.get("Previous-Fork-Tag")!,
    supersededCanonicalTags: parseSupersededCanonicalTags(
      values.get("Superseded-Canonical-Tags")!,
      tag,
    ),
  }
}

function validateTagProvenance(
  tag: ForkReleaseTag,
  object: string,
  canonical: readonly CanonicalRelease[],
  forkTags: readonly ForkReleaseTag[],
  originMain: string,
): TagProvenance {
  let provenance = parseTagProvenance(object, tag)
  if (provenance.forkCommit != tag.commit)
    throw new Error(`Fork-Commit does not match tag target for ${tag.tag}`)
  let upstream = canonical.find(release => release.tag == provenance.upstreamTag)
  if (!upstream || upstream.version.normalized != tag.version.normalized ||
      upstream.commit != provenance.upstreamCommit)
    return invalidTagProvenance(tag)
  if (!isAncestor(upstream.commit, tag.commit))
    throw new Error(`canonical upstream commit is not an ancestor of tag target: ${tag.tag}`)

  let previous = forkTags.find(previousTag => previousTag.tag == provenance.previousForkTag)
  if (!previous || compareForkTags(previous, tag) >= 0) return invalidTagProvenance(tag)
  for (let supersededTag of provenance.supersededCanonicalTags) {
    let version = parseSemVerTag(supersededTag)!
    if (compareSemVer(version, previous.version) <= 0 || compareSemVer(version, tag.version) >= 0)
      return invalidTagProvenance(tag)
  }

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

function compareForkTags(left: ForkReleaseTag, right: ForkReleaseTag): number {
  return compareSemVer(left.version, right.version) ||
    (left.suffix < right.suffix ? -1 : left.suffix > right.suffix ? 1 :
      left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0)
}

function previousForkTag(
  baseline: ForkReleaseTag,
  forkTags: readonly ForkReleaseTag[],
  before: ForkReleaseTag,
): ForkReleaseTag {
  return forkTags.filter(tag =>
    (tag.tag == baseline.tag || compareSemVer(tag.version, baseline.version) > 0) &&
    (compareSemVer(tag.version, before.version) < 0 ||
      (compareSemVer(tag.version, before.version) == 0 && tag.suffix < before.suffix)))
    .sort(compareForkTags)
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
  supersededTags: readonly string[],
): string {
  let repositoryUrl = `${requireEnvironment("GITHUB_SERVER_URL")}/${requireEnvironment("GITHUB_REPOSITORY")}`
  let skipped = supersededTags.length
    ? supersededTags.map(tag => `\`${tag}\``).join(", ")
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

function releaseInputForTag(
  tag: ForkReleaseTag,
  canonical: CanonicalRelease,
  previousTag: string,
  supersededTags: readonly string[],
): GitHubReleaseInput {
  return {
    tag_name: tag.tag,
    name: releaseTitle(tag.version.normalized, tag.suffix),
    draft: false,
    prerelease: Boolean(tag.version.prerelease.length),
    body: releaseNotes(canonical, tag.tag, tag.commit, previousTag, supersededTags),
  }
}

function createReleaseForTag(
  tag: ForkReleaseTag,
  canonical: CanonicalRelease,
  previousTag: string,
  supersededTags: readonly string[],
): GitHubRelease {
  let expected = releaseInputForTag(tag, canonical, previousTag, supersededTags)
  let release = createRelease(expected)
  validateRelease(release, expected)
  return release
}

function pushTag(tag: string, candidateSha: string): void {
  fetchOriginMainForCandidate(candidateSha)
  let tagRef = `refs/tags/${tag}`
  run("git", ["push", "origin", `${tagRef}:${tagRef}`])
}

function publish(): Discovery {
  let refreshed = discoverRepositoryState(cliInputs.baselineTag, cliInputs.candidateSha, {
    createMissingRelease: true,
  })
  if (refreshed.recovery) return refreshed
  let selected = refreshed.selection.selected
  if (!selected || refreshed.selection.nextSuffix == null) return refreshed

  let suffix = refreshed.selection.nextSuffix
  let forkTag = forkTagName(selected.version, suffix)
  let publishedTag: ForkReleaseTag = {
    tag: forkTag,
    version: selected.version,
    suffix,
    commit: cliInputs.candidateSha,
  }
  let previous = previousForkTag(refreshed.selection.baseline, refreshed.forkTags, publishedTag)
  let supersededTags = refreshed.selection.superseded.map(release => release.tag)
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
    `Previous-Fork-Tag: ${previous.tag}`,
    `Superseded-Canonical-Tags: ${JSON.stringify(supersededTags)}`,
    "",
  ].join("\n")
  let directory = mkdtempSync(join(tmpdir(), "wordgard-tag-"))
  let messageFile = join(directory, "message")
  let tagCreationFailed = true
  try {
    writeFileSync(messageFile, annotation)
    run("git", ["tag", "-a", forkTag, cliInputs.candidateSha, "-F", messageFile])
    tagCreationFailed = false
  } finally {
    cleanupTemporaryDirectory(directory, tagCreationFailed)
  }

  let pushFailed = false
  try {
    pushTag(forkTag, cliInputs.candidateSha)
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
    pushTag(forkTag, cliInputs.candidateSha)
  }

  let remoteTags = listRemoteTags("origin")
  let remoteObject = remoteTags.get(forkTag)
  if (!remoteObject) throw new Error(`pushed tag not found on origin: ${forkTag}`)
  let remoteCommit = run("git", ["rev-parse", `${remoteObject}^{commit}`]).toLowerCase()
  if (remoteCommit != cliInputs.candidateSha)
    throw new Error(`pushed tag target does not match candidate: ${forkTag}`)
  failureContext.observedRemoteState =
    `${forkTag}: tag points to ${remoteCommit}, GitHub Release missing`

  createReleaseForTag(publishedTag, selected, previous.tag, supersededTags)
  failureContext.observedRemoteState = `${forkTag}: tag and GitHub Release complete`
  return {
    originMain: refreshed.originMain,
    ciRun: refreshed.ciRun,
    forkTags: [...refreshed.forkTags, publishedTag],
    selection: {
      baseline: refreshed.selection.baseline,
      watermark: selected.version,
      selected: null,
      superseded: [],
      nextSuffix: null,
    },
    recovery: null,
    publication: {tag: publishedTag, performed: true},
  }
}

function buildPlan(discovery: Discovery): object {
  let selected = discovery.selection.selected
  return {
    baselineTag: discovery.selection.baseline.tag,
    candidateSha: cliInputs.candidateSha,
    ciRun: {id: discovery.ciRun.id, url: discovery.ciRun.html_url},
    watermark: discovery.selection.watermark.normalized,
    ...(discovery.publication ? {publication: {
      forkTag: discovery.publication.tag.tag,
      action: "create-tag-and-release",
      performed: discovery.publication.performed,
    }} : {}),
    ...(discovery.recovery ? {recovery: {
      forkTag: discovery.recovery.tag.tag,
      action: "create-missing-release",
      performed: discovery.recovery.performed,
    }} : {}),
    ...(discovery.recovery?.performed && selected ? {followUpRequired: true} : {}),
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

function hostedRecoveryCommand(): string {
  return `gh workflow run mirror-release.yml --repo ${requireEnvironment("GITHUB_REPOSITORY")} --ref main -f candidate_sha=${cliInputs.candidateSha} -f ci_run_id=${cliInputs.ciRunId}`
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
    "Recover idempotently through the hosted controller after correcting the reported state:",
    "```sh",
    hostedRecoveryCommand(),
    "```",
    "Dispatch inputs must identify a successful push-to-`main` CI run and its exact tested candidate; that candidate SHA must remain an ancestor of current `origin/main`. A partial tag keeps its original CI authorization in its annotation.",
  ].join("\n")
}

function createFailureIssue(repository: string, body: string): GitHubIssue {
  let endpoint = `repos/${repository}/issues`
  return reconciledMutation<GitHubIssue>("POST", endpoint, {title: issueTitle, body}, findFailureIssue)
}

function setFailureIssueState(
  repository: string,
  issueNumber: number,
  state: "open" | "closed",
): GitHubIssue {
  let endpoint = `repos/${repository}/issues/${issueNumber}`
  return reconciledMutation<GitHubIssue>("PATCH", endpoint, {state}, () => {
    let issue = findFailureIssue()
    return issue?.number == issueNumber && issue.state == state ? issue : null
  })
}

function findFailureIssueComment(
  repository: string,
  issueNumber: number,
  body: string,
): GitHubIssueComment | null {
  let endpoint = `repos/${repository}/issues/${issueNumber}/comments?per_page=100`
  let response = githubRequest(["api", "--paginate", "--slurp", endpoint], endpoint)
  let pages = parseJson<unknown>(response.output, endpoint)
  if (!Array.isArray(pages) || !pages.every(Array.isArray))
    throw new Error(`GitHub returned invalid comment pages for ${endpoint}`)
  for (let page of pages) for (let value of page) {
    if (!value || typeof value != "object") continue
    let comment = value as Partial<GitHubIssueComment>
    if (comment.body == body && typeof comment.id == "number") return comment as GitHubIssueComment
  }
  return null
}

function commentOnFailureIssue(repository: string, issueNumber: number, body: string): void {
  if (findFailureIssueComment(repository, issueNumber, body)) return
  let endpoint = `repos/${repository}/issues/${issueNumber}/comments`
  reconciledMutation<GitHubIssueComment>("POST", endpoint, {body}, () =>
    findFailureIssueComment(repository, issueNumber, body))
}

function ensureFailureIssueOpen(body: string): void {
  let repository = requireEnvironment("GITHUB_REPOSITORY")
  let issue = findFailureIssue()
  if (!issue) {
    issue = createFailureIssue(repository, body)
    if (issue.body == body) return
  }
  if (issue.state == "closed") issue = setFailureIssueState(repository, issue.number, "open")
  commentOnFailureIssue(repository, issue.number, body)
}

function reportFailure(error: unknown): void {
  ensureFailureIssueOpen(failureIssueBody(error))
}

function leaveRecoveryFollowUpIssueOpen(discovery: Discovery): void {
  let recovery = discovery.recovery
  let selected = discovery.selection.selected
  let suffix = discovery.selection.nextSuffix
  if (!recovery?.performed || !selected || suffix == null)
    throw new Error("recovery follow-up requires a recovered tag and selected release")
  let forkTag = forkTagName(selected.version, suffix)
  failureContext.selected = selected
  failureContext.intendedForkTag = forkTag
  ensureFailureIssueOpen([
    `Recovered \`${recovery.tag.tag}\` by creating its missing GitHub Release.`,
    "",
    "Recovery is terminal for this invocation; no second tag was published.",
    `A newer canonical release remains eligible: \`${selected.tag}\` at \`${selected.commit}\`.`,
    `Intended fork tag for the next invocation: \`${forkTag}\`.`,
    "",
    "Run the hosted controller again for the successful push-to-`main` CI candidate:",
    "```sh",
    hostedRecoveryCommand(),
    "```",
    "The candidate must remain an ancestor of current `origin/main`; the recovered partial tag retains its original authorization in its annotation.",
  ].join("\n"))
}

function closeFailureIssue(): void {
  let issue = findFailureIssue()
  if (issue?.state == "open")
    setFailureIssueState(requireEnvironment("GITHUB_REPOSITORY"), issue.number, "closed")
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
    if (discovery.recovery?.performed && discovery.selection.selected)
      leaveRecoveryFollowUpIssueOpen(discovery)
    else if (discovery.originMain == cliInputs.candidateSha)
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
