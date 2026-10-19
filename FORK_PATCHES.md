# Wordgard fork patches

This ledger tracks functional source and build changes carried by the Obsidian fork but absent from canonical Wordgard. Fork-operational workflows, Nix files, and maintenance documentation do not need patch IDs.

Each patch uses a sequential `WG-*` ID. Its code-and-tests commit must remain separate from its ledger commit and include these trailers:

```text
Fork-Patch: WG-001
Upstream-Issue: https://code.haverbeke.berlin/wordgard/wordgard/issues/32
```

Statuses:

- `active`: maintained behavior absent from upstream.
- `permanent`: intentionally Obsidian-specific behavior.
- `absorbed`: upstream now provides the behavior; do not revert the historical fork commit.
- `reverted`: the fork intentionally removed the behavior before upstream absorption.

After each upstream sync, run `git cherry -v upstream/main main` as an advisory patch-equivalence check and manually review every active patch against its upstream issue.

| ID | Code commit | Summary | Upstream issue | Status | Upstream commit |
| --- | --- | --- | --- | --- | --- |
| WG-001 | `28fa7554006b0b7a900ca4312dfef4315c1e9690` | Remove invalid `codeBlockLanguage` schema re-export | [follow-up](https://code.haverbeke.berlin/wordgard/wordgard/issues/41) | `absorbed` | `7a6cb5ba526eb4e41e3c11308b2a7fb17acffd26` |
| WG-002 | `c5a77bba8dee910d71d6b4c7f32726b471f3fca9` | Return nonzero when package type checking fails | [report](https://code.haverbeke.berlin/wordgard/wordgard/issues/43) | `absorbed` | `d48f580e9208ab8704a6866d86416edf76f41084` |
| WG-005 | `f551366bdfd684e6160cf8aaee8e8c708ff05292` | Probe one pixel inside the block in `moveToLineBoundary`, so End on a wrapped table cell's line stays on that line | [report](https://code.haverbeke.berlin/wordgard/wordgard/issues/90) | `active` | |
| WG-007 | `f368c568e8fe79d9f4931bfc3553d155d3d23286` | Draw the cursor in a gap between blocks upright, centered in the gap, instead of as a horizontal line | none: Obsidian-specific | `permanent` | |
| WG-008 | `f5fea1d14e8c7b98fbffa505a8cc62b848807671` | Refresh `from`, `to` and `value` in `HeapCursor.goto`, so a cursor over several sets reports where it moved | not filed yet | `active` | |
| WG-009 | `4bc35b117d050ce0b08e81211d350021f8664ddb` | Search the chunk that holds the position, by its relative offsets, in `PointSet.at` | not filed yet | `active` | |
| WG-010 | `3a7f000c37e471c61b63c0fe61ae7622ee4ca442` | Draw a cursor at a textblock's start or end, pointing out of it, at the line's edge when the edge span runs the block's way | not filed yet | `active` | |
