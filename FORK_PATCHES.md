# Wordgard fork patches

## This branch: `maintenance/v0.5.2`

A maintenance line: the fork release `obsidian-v0.5.2-1` plus WG-006, cherry-picked from its pull request to `main` (#13), and nothing else. It exists so that Opal, Link and Obsidian can take WG-006 while `main` carries upstream changes they cannot take yet. Its tags are named `opal-v<release>-wg<patch>`, starting with `opal-v0.5.2-1-wg006`, outside the `obsidian-v*` names the release automation publishes and reads. Drop this line, and move its consumers back to `obsidian-v*` tags, once a normal fork release carries WG-006.

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
| WG-006 | `a85f7f673be32e82ed495a3ecd3e4dd7b7ac9e1c` on this branch, from `e690dba1a610dd758aac302d1f0072bd8ad9cfb4` | Draw the line after a newline that ends a whitespace-preserving textblock, and the cursor after a newline on the line it starts | not yet filed | `active` | |
