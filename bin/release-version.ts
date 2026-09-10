export type SemVer = {
  source: string
  normalized: string
  major: bigint
  minor: bigint
  patch: bigint
  prerelease: readonly (string | bigint)[]
  build: readonly string[]
}

export type CanonicalRelease = {
  tag: string
  commit: string
  version: SemVer
}

export type ForkReleaseTag = {
  tag: string
  version: SemVer
  suffix: bigint
  commit: string
}

export type ReleaseSelection = {
  baseline: ForkReleaseTag
  watermark: SemVer
  selected: CanonicalRelease | null
  superseded: readonly CanonicalRelease[]
  nextSuffix: bigint | null
}

const numericIdentifier = "(?:0|[1-9][0-9]*)"
const prereleaseIdentifier = `(?:${numericIdentifier}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`
const semVerPattern = new RegExp(
  `^v?(${numericIdentifier})\\.(${numericIdentifier})\\.(${numericIdentifier})` +
  `(?:-(${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*))?` +
  `(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`,
)

export function parseSemVerTag(tag: string): SemVer | null {
  let match = semVerPattern.exec(tag)
  if (!match) return null
  let prerelease = match[4] ? match[4].split(".").map(identifier =>
    /^[0-9]+$/.test(identifier) ? BigInt(identifier) : identifier) : []
  return {
    source: tag,
    normalized: tag.startsWith("v") ? tag.slice(1) : tag,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
    build: match[5] ? match[5].split(".") : [],
  }
}

function compareBigInt(a: bigint, b: bigint): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0
}

export function compareSemVer(a: SemVer, b: SemVer): -1 | 0 | 1 {
  for (let [left, right] of [[a.major, b.major], [a.minor, b.minor], [a.patch, b.patch]] as const) {
    let result = compareBigInt(left, right)
    if (result) return result
  }
  if (!a.prerelease.length || !b.prerelease.length)
    return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index++) {
    let left = a.prerelease[index], right = b.prerelease[index]
    if (left === right) continue
    if (typeof left == "bigint") return typeof right == "bigint" ? compareBigInt(left, right) : -1
    if (typeof right == "bigint") return 1
    return left < right ? -1 : 1
  }
  return compareBigInt(BigInt(a.prerelease.length), BigInt(b.prerelease.length))
}

export function parseForkTag(
  tag: string,
  commit: string,
  canonical: readonly CanonicalRelease[],
): ForkReleaseTag | null {
  for (let release of canonical) {
    let prefix = `obsidian-v${release.version.normalized}-`
    if (!tag.startsWith(prefix)) continue
    let suffix = tag.slice(prefix.length)
    if (!/^[1-9][0-9]*$/.test(suffix)) continue
    return {tag, version: release.version, suffix: BigInt(suffix), commit}
  }
  return null
}

export function nextForkSuffix(version: SemVer, forkTags: readonly ForkReleaseTag[]): bigint {
  let maximum = 0n
  for (let tag of forkTags)
    if (version.normalized == tag.version.normalized && tag.suffix > maximum) maximum = tag.suffix
  return maximum + 1n
}

export function forkTagName(version: SemVer, suffix: bigint): string {
  if (suffix <= 0n) throw new Error("fork tag suffix must be positive")
  return `obsidian-v${version.normalized}-${suffix}`
}

function compareString(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareCanonical(a: CanonicalRelease, b: CanonicalRelease): number {
  return compareSemVer(a.version, b.version) || compareString(a.tag, b.tag) || compareString(a.commit, b.commit)
}

export function selectRelease(input: {
  canonical: readonly CanonicalRelease[]
  reachableCanonicalTags: ReadonlySet<string>
  forkTags: readonly ForkReleaseTag[]
  completedReleaseTags: ReadonlySet<string>
  baselineTag: string
}): ReleaseSelection {
  let baseline = input.forkTags.find(tag => tag.tag == input.baselineTag)
  if (!baseline) throw new Error(`baseline tag not found: ${input.baselineTag}`)

  let watermark = baseline.version
  for (let tag of input.forkTags)
    if (tag.tag != baseline.tag && input.completedReleaseTags.has(tag.tag) &&
        compareSemVer(tag.version, watermark) > 0)
      watermark = tag.version

  let candidates = input.canonical.filter(release =>
    input.reachableCanonicalTags.has(release.tag) && compareSemVer(release.version, watermark) > 0)
  let normalized = new Map<string, CanonicalRelease>()
  for (let release of candidates) {
    let previous = normalized.get(release.version.normalized)
    if (previous && previous.commit != release.commit)
      throw new Error(`ambiguous canonical releases: ${previous.tag} and ${release.tag}`)
    if (!previous || compareCanonical(release, previous) < 0) normalized.set(release.version.normalized, release)
  }
  candidates = [...normalized.values()].sort(compareCanonical)
  let selected = candidates.length ? candidates[candidates.length - 1] : null
  if (selected) {
    let tied = candidates.filter(release => compareSemVer(release.version, selected.version) == 0)
    if (tied.length > 1)
      throw new Error(`ambiguous canonical releases: ${tied.map(release => release.tag).join(", ")}`)
  }
  return {
    baseline,
    watermark,
    selected,
    superseded: selected ? candidates.slice(0, -1) : [],
    nextSuffix: selected ? nextForkSuffix(selected.version, input.forkTags) : null,
  }
}
