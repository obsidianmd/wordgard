#!/usr/bin/env node

import {execFileSync, spawnSync} from "node:child_process"
import {
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

type Discovery = {
  ciRun: CiRun
  selection: ReleaseSelection
}

function run(command: string, args: readonly string[], options: {cwd?: string} = {}): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function githubJson<T>(endpoint: string): T {
  let output = run("gh", ["api", endpoint])
  try {
    return JSON.parse(output) as T
  } catch {
    throw new Error(`GitHub returned invalid JSON for ${endpoint}`)
  }
}

function validateCiRun(ciRun: CiRun, candidateSha: string): void {
  if (!ciRun || typeof ciRun != "object") throw new Error("CI run response must be an object")
  if (typeof ciRun.id != "number" || ciRun.id != cliInputs.ciRunId)
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

function listTags(): readonly string[] {
  let output = run("git", ["tag", "--list"])
  return output ? output.split("\n").sort() : []
}

function discoverRepositoryState(baselineTag: string, candidateSha: string): Discovery {
  run("git", ["fetch", "--no-tags", "origin", "main"])
  run("git", ["fetch", "--tags", "upstream"])
  run("git", ["fetch", "--tags", "origin"])

  let originMain = run("git", ["rev-parse", "refs/remotes/origin/main"]).toLowerCase()
  if (candidateSha != originMain) throw new Error("candidate SHA is not origin/main")

  let ciRun = githubJson<CiRun>(
    `repos/${requireEnvironment("GITHUB_REPOSITORY")}/actions/runs/${cliInputs.ciRunId}`,
  )
  validateCiRun(ciRun, candidateSha)

  let tags = listTags()
  let canonical: CanonicalRelease[] = []
  for (let tag of tags) {
    let version = parseSemVerTag(tag)
    if (!version) continue
    canonical.push({tag, version, commit: run("git", ["rev-parse", `${tag}^{commit}`]).toLowerCase()})
  }

  let forkTags: ForkReleaseTag[] = []
  for (let tag of tags) {
    if (!parseForkTag(tag, "", canonical)) continue
    let commit = run("git", ["rev-parse", `${tag}^{commit}`]).toLowerCase()
    forkTags.push(parseForkTag(tag, commit, canonical)!)
  }
  let baseline = forkTags.find(tag => tag.tag == baselineTag)
  if (!baseline) throw new Error(`baseline tag not found: ${baselineTag}`)

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
    completedReleaseTags: new Set(),
    baselineTag,
  })
  return {ciRun, selection}
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
  if (!/^[0-9a-fA-F]{40}$/.test(candidateInput))
    throw new Error("candidate SHA must be exactly 40 hexadecimal characters")
  if (!/^[1-9][0-9]*$/.test(ciRunInput))
    throw new Error("CI run ID must be a positive decimal integer")
  let ciRunId = Number(ciRunInput)
  if (!Number.isSafeInteger(ciRunId)) throw new Error("CI run ID must be a positive decimal integer")
  requireEnvironment("GITHUB_REPOSITORY")
  requireEnvironment("GITHUB_SERVER_URL")
  if (process.env.MIRROR_RELEASE_DRY_RUN != "1")
    throw new Error("publication is not implemented; set MIRROR_RELEASE_DRY_RUN=1")
  return {baselineTag, candidateSha: candidateInput.toLowerCase(), ciRunId}
}

let cliInputs: {baselineTag: string, candidateSha: string, ciRunId: number}

try {
  cliInputs = parseInputs()
  let discovery = discoverRepositoryState(cliInputs.baselineTag, cliInputs.candidateSha)
  let selected = discovery.selection.selected
  let plan = {
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
  process.stdout.write(`${JSON.stringify(plan)}\n`)
} catch (error) {
  let message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`mirror-release: ${message}\n`)
  process.exitCode = 1
}
