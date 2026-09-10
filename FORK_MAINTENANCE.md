# Maintaining the Obsidian Wordgard fork

## Remotes

- `origin`: `git@github.com:obsidianmd/wordgard.git`
- `upstream`: `https://code.haverbeke.berlin/wordgard/wordgard.git`

Verify them with `git remote -v`. Fetch canonical changes with `git fetch upstream main`.

## Automated synchronization

The daily `Sync upstream` workflow and its manual `workflow_dispatch` entry merge canonical `upstream/main` into `automation/upstream-sync` and open or update a pull request into `main`.

## Fork patch lifecycle

Functional source and build changes use sequential `WG-*` IDs. The initial unpublished bootstrap preserves separate code-and-ledger commits locally. After `main` is first published, each patch PR preserves a code-and-tests commit with `Fork-Patch` and `Upstream-Issue` trailers, followed by a separate `FORK_PATCHES.md` ledger commit. Merge patch PRs; never squash or rebase them.

Patch statuses are `active`, `permanent`, `absorbed`, and `reverted`. After every upstream sync:

```sh
git fetch upstream main
git cherry -v upstream/main main
```

Treat `git cherry` as advisory and manually review every active ledger entry against its upstream issue. When upstream supplies equivalent behavior, reconcile toward upstream and mark the patch `absorbed` with the upstream SHA; do not revert the historical fork commit. To remove a patch that upstream has not absorbed, revert only its code commit and update the ledger separately to `reverted`.

## Manual conflict recovery

```sh
git fetch origin main
git fetch upstream main
git switch --create sync-upstream-manual --track origin/main
git merge --no-ff upstream/main
git status
# Resolve each conflict and stage its actual path with `git add`.
git diff --name-only --diff-filter=U
# The preceding command must print nothing before committing.
git status
git commit
git push --set-upstream origin sync-upstream-manual
gh pr create --base main --head sync-upstream-manual
```

Never force-push `main` and never commit unresolved conflict markers.

## Automatic fork releases

Canonical Git tags are the sole upstream release signal. Every valid SemVer tag whose commit is reachable from the exact CI-tested candidate is eligible, including all prereleases. After a push to `main`, `CI / Test` from `.github/workflows/ci.yml` must complete successfully for that candidate SHA. At discovery and again immediately before tag push, the controller fetches `origin/main` and requires the candidate to be its ancestor; equality is not required. Protected `main` prohibits force-push and deletion, so an ordinary concurrent advance preserves that ancestry. The `Mirror upstream release` workflow then selects only the highest eligible SemVer newer than the completed release watermark. Lower eligible versions are recorded as superseded rather than published separately.

`obsidian-v0.3.1-2` is the tag-only historical baseline. It establishes the watermark and is not backfilled with a GitHub Release. For each newly selected canonical release, the workflow publishes an immutable annotated tag named `obsidian-v<upstream-version>-<fork-release>` on the exact CI-tested candidate, then creates the corresponding GitHub Release. The publication push contains only that full tag refspec: it does not force, delete, update `main`, or use a branch lease/atomic no-op guard. The suffix is one greater than the maximum existing origin suffix for that upstream version; local-only tags do not affect naming. Existing tags are never moved, overwritten, or reused; an inconsistent tag or collision stops publication instead of rewriting remote state.

Every GitHub Release is non-draft. A stable canonical version sets the prerelease flag to false; a SemVer prerelease sets it to true. Generated notes identify the canonical tag and commit, the fork commit, the immediately previous fork release, any publication-time superseded canonical tags, and a permalink to `FORK_PATCHES.md` at the immutable fork tag. The annotation persists the previous fork tag and superseded canonical tag names using one required `Previous-Fork-Tag` field and a compact JSON string array in `Superseded-Canonical-Tags`. Existing Release validation and missing-Release recovery reconstruct the exact original body from those immutable inputs, so a canonical maintenance tag discovered later cannot rewrite historical expectations. Missing, malformed, non-deterministically encoded, or duplicate body-input provenance fails closed. The notes do not infer patch statuses: the ledger remains authoritative.

Publication failures create or update one deduplicated issue titled **Upstream release mirroring requires attention**. After correcting the reported state, a maintainer recovers idempotently through the hosted workflow. Dispatch inputs must identify an exact candidate SHA from a successful push-to-`main` CI run and its corresponding run ID. The controller requires the GitHub workflow-run API path to be exactly `.github/workflows/ci.yml@main` (workflow path plus ref), requires the run to be successful and push-triggered on `main`, verifies that its head SHA matches the candidate, and verifies that the candidate remains an ancestor of current `origin/main`.

If an annotated tag was published before GitHub Release creation failed, recovery separately revalidates the original authorization and Release-body inputs recorded in that immutable tag's annotation and creates only the missing exact Release. Recovery remains terminal for that invocation. If rediscovery finds a newer candidate reachable from the supplied CI-tested SHA, the issue stays open with the exact hosted follow-up command; a later invocation publishes that candidate and then closes the issue.

The following is a maintainer-run hosted recovery example. Local repository preparation must not run it:

```bash
gh workflow run mirror-release.yml --repo obsidianmd/wordgard --ref main \
  -f candidate_sha='<40-character-tested-main-commit>' \
  -f ci_run_id='<successful-main-ci-run-id>'
```

Release mirroring does not publish npm packages or release assets and does not update Opal or Link. Consumer dependency bumps remain separate reviewed changes.

## Opal and Link dependencies

Pin an immutable fork tag in each consumer's `package.json` and commit the resulting lockfile. Use the GitHub SSH form when development environments have GitHub SSH access:

```json
"wordgard": "git+ssh://git@github.com/obsidianmd/wordgard.git#obsidian-v<upstream-version>-<fork-release>"
```

Use the HTTPS form where SSH is unavailable:

```json
"wordgard": "git+https://github.com/obsidianmd/wordgard.git#obsidian-v<upstream-version>-<fork-release>"
```

## Repository settings

GitHub Actions must be allowed to create pull requests. Keep the repository's default `GITHUB_TOKEN` permission read-only, then permit the workflows' explicit job-level grants:

- `Sync upstream`: `actions: write`, `contents: write`, `pull-requests: write`, and `issues: write`;
- `Mirror upstream release`: `actions: read`, `contents: write`, and `issues: write`.

Protect `main` by requiring a pull request, one approval, and the strict `CI / Test` status check, and prohibit force-push and deletion. Keep push-triggered `CI` from `.github/workflows/ci.yml` enabled on `main`; release publication accepts only a successful push-triggered run of that exact workflow for the candidate commit and requires that candidate to remain an ancestor of current `origin/main`. Enable merge commits and disable squash and rebase merging so patch commits and trailers survive.

Add tag rules for `obsidian-v*` that prevent tag updates and deletion while allowing GitHub Actions to create new matching tags. Do not grant the release workflow permission to bypass update or deletion protection.

## Initial publication handoff

The repository preparation process leaves all work local. A maintainer performs hosted rollout only after reviewing the local history and verification evidence. Do not push the prepared history directly to `main`:

1. Against the existing remote `main`, keep default workflow permissions read-only, allow `GITHUB_TOKEN` workflows to create pull requests, and confirm the explicit sync and release workflow permissions listed above are permitted.
2. Enable merge commits, disable squash/rebase merging, and enable merged-branch deletion.
3. Protect the existing remote `main` with one approval, strict `CI / Test`, conversation resolution, and no force-pushes or deletion.
4. Configure `obsidian-v*` tag rules to block update and deletion while allowing workflow tag creation. Complete this before release automation can reach `main`.
5. Push the existing synchronization work only to its topic branch, then merge its reviewed synchronization PR after `CI / Test` passes.
6. Keep the WG-001/WG-002 absorbed-state ledger update as its own commit. Push the release-automation work only to a separate topic branch based on the newly synchronized `main`, then merge that reviewed PR after `CI / Test` passes.
7. Confirm the release-automation merge's push to `main` runs `CI / Test`. The automatic release workflow becomes active only now, after immutable-tag rules are already in place.
8. Manually run `Sync upstream` and confirm the expected no-change result or review its PR/issue.
9. Validate hosted release mirroring: with `obsidian-v0.3.1-2` present as the baseline and no newer eligible canonical tag, a successful current-`main` push CI run must produce no backfill Release or replacement tag.
10. Make any Opal or Link dependency bump as a separate reviewed change after the desired immutable fork tag exists.

These maintainer-only commands must not be executed by automated local preparation:

```sh
gh api --method PUT repos/obsidianmd/wordgard/actions/permissions/workflow \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=true

gh api --method PATCH repos/obsidianmd/wordgard \
  -F allow_merge_commit=true \
  -F allow_squash_merge=false \
  -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true
```

After `CI / Test` exists on the current remote, apply branch protection with this payload before pushing rollout topic branches:

```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["CI / Test"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": false
}
```

Save that JSON temporarily, then apply it before any rollout topic branch is merged:

```sh
gh api --method PUT repos/obsidianmd/wordgard/branches/main/protection \
  --input /tmp/wordgard-branch-protection.json
```

Configure the `obsidian-v*` tag rules next. The exact ruleset API payload depends on the repository's ruleset and bypass-actor configuration; review it before applying it as a maintainer. Only after both branch and tag protections exist should maintainers push the synchronization and release-automation topic branches, open or update their PRs, and merge them in that order. After rollout, the maintainer may run:

```sh
gh workflow run sync-upstream.yml --repo obsidianmd/wordgard
```
