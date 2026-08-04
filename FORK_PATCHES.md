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
