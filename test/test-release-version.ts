import assert from "node:assert/strict"
import {
  compareSemVer,
  forkTagName,
  nextForkSuffix,
  parseForkTag,
  parseSemVerTag,
  selectRelease,
  type CanonicalRelease,
  type ForkReleaseTag,
} from "../bin/release-version.ts"

function canonical(tag: string, commit = `${tag}-commit`): CanonicalRelease {
  return {tag, commit, version: parseSemVerTag(tag)!}
}

function fork(tag: string, version: string, suffix: bigint, commit = `${tag}-commit`): ForkReleaseTag {
  return {tag, version: parseSemVerTag(version)!, suffix, commit}
}

describe("release versions", () => {
  it("accepts stable and prerelease tags with an optional leading v", () => {
    assert.equal(parseSemVerTag("v1.2.3")?.normalized, "1.2.3")
    assert.equal(parseSemVerTag("1.2.3-rc.1+build.7")?.normalized, "1.2.3-rc.1+build.7")
  })

  it("rejects malformed semantic versions", () => {
    for (let tag of ["1.2", "01.2.3", "1.2.3-01", "release-1.2.3"])
      assert.equal(parseSemVerTag(tag), null)
  })

  it("implements SemVer prerelease precedence and ignores build metadata", () => {
    let alpha = parseSemVerTag("1.0.0-alpha")!
    let rc = parseSemVerTag("1.0.0-rc.1")!
    let stable = parseSemVerTag("1.0.0")!
    assert.equal(compareSemVer(alpha, rc), -1)
    assert.equal(compareSemVer(rc, stable), -1)
    assert.equal(compareSemVer(stable, parseSemVerTag("1.0.0+build.2")!), 0)
  })

  it("uses the configured historical baseline without requiring a Release", () => {
    let baseline = fork("obsidian-v0.3.1-2", "0.3.1", 2n)
    let releases = [canonical("0.4.0"), canonical("0.5.0"), canonical("0.6.0")]
    let selection = selectRelease({
      canonical: releases,
      reachableCanonicalTags: new Set(["0.4.0", "0.5.0"]),
      forkTags: [baseline],
      completedReleaseTags: new Set(),
      baselineTag: baseline.tag,
    })
    assert.equal(selection.baseline, baseline)
    assert.equal(selection.watermark.normalized, "0.3.1")
    assert.equal(selection.selected?.tag, "0.5.0")
    assert.equal(selection.nextSuffix, 1n)
  })

  it("advances the watermark only for completed post-baseline releases", () => {
    let baseline = fork("obsidian-v0.3.1-2", "0.3.1", 2n)
    let completed = fork("obsidian-v0.4.0-1", "0.4.0", 1n)
    let incomplete = fork("obsidian-v0.5.0-1", "0.5.0", 1n)
    let release = canonical("0.5.0")
    let selection = selectRelease({
      canonical: [release],
      reachableCanonicalTags: new Set([release.tag]),
      forkTags: [baseline, incomplete, completed],
      completedReleaseTags: new Set([completed.tag]),
      baselineTag: baseline.tag,
    })
    assert.equal(selection.watermark.normalized, "0.4.0")
    assert.equal(selection.selected, release)
    assert.equal(selection.nextSuffix, 2n)
  })

  it("selects only the highest reachable version and reports lower versions as superseded", () => {
    let baseline = fork("obsidian-v0.3.1-2", "0.3.1", 2n)
    let releases = [canonical("0.5.0-beta.1"), canonical("0.4.0"), canonical("0.5.0")]
    let selection = selectRelease({
      canonical: releases,
      reachableCanonicalTags: new Set(releases.map(release => release.tag)),
      forkTags: [baseline],
      completedReleaseTags: new Set(),
      baselineTag: baseline.tag,
    })
    assert.equal(selection.selected?.tag, "0.5.0")
    assert.deepEqual(selection.superseded.map(release => release.tag), ["0.4.0", "0.5.0-beta.1"])
  })

  it("fails on conflicting normalized aliases and equal-precedence build variants", () => {
    let baseline = fork("obsidian-v0.3.1-2", "0.3.1", 2n)
    for (let releases of [
      [canonical("1.0.0", "one"), canonical("v1.0.0", "two")],
      [canonical("1.0.0+one", "one"), canonical("1.0.0+two", "two")],
    ]) {
      assert.throws(() => selectRelease({
        canonical: releases,
        reachableCanonicalTags: new Set(releases.map(release => release.tag)),
        forkTags: [baseline],
        completedReleaseTags: new Set(),
        baselineTag: baseline.tag,
      }), /ambiguous canonical releases/)
    }
  })

  it("parses numeric prerelease endings against canonical versions", () => {
    let release = canonical("v1.0.0-rc.1", "canonical-commit")
    let parsed = parseForkTag("obsidian-v1.0.0-rc.1-2", "fork-commit", [release])
    assert.equal(parsed?.version, release.version)
    assert.equal(parsed?.suffix, 2n)
    assert.equal(parsed?.commit, "fork-commit")
    assert.equal(parseForkTag("obsidian-v1.0.0-rc.1-0", "fork-commit", [release]), null)
  })

  it("chooses one greater than the maximum existing suffix without filling gaps", () => {
    let version = parseSemVerTag("1.2.0")!
    let tags = [
      fork("obsidian-v1.2.0-1", "1.2.0", 1n),
      fork("obsidian-v1.2.0-3", "1.2.0", 3n),
      fork("obsidian-v1.1.0-8", "1.1.0", 8n),
      fork("obsidian-v1.2.0+other-9", "1.2.0+other", 9n),
    ]
    assert.equal(nextForkSuffix(version, tags), 4n)
    assert.equal(forkTagName(version, 4n), "obsidian-v1.2.0-4")
  })

  it("rejects non-positive fork tag suffixes", () => {
    let version = parseSemVerTag("1.2.0")!
    assert.throws(() => forkTagName(version, 0n), /suffix must be positive/)
    assert.throws(() => forkTagName(version, -1n), /suffix must be positive/)
  })

  it("fails when the configured baseline is missing", () => {
    assert.throws(() => selectRelease({
      canonical: [],
      reachableCanonicalTags: new Set(),
      forkTags: [],
      completedReleaseTags: new Set(),
      baselineTag: "obsidian-v0.3.1-2",
    }), /baseline tag not found/)
  })
})
