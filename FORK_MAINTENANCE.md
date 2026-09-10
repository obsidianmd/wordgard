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

Canonical Git tags are the sole upstream release signal. Every valid SemVer tag whose commit is reachable from the validated current `main` is eligible, including all prereleases. After a push to `main`, `CI / Test` from `.github/workflows/ci.yml` must complete successfully for that exact current `origin/main` commit. The `Mirror upstream release` workflow then selects only the highest eligible SemVer newer than the completed release watermark. Lower eligible versions are recorded as superseded rather than published separately.

`obsidian-v0.3.1-2` is the tag-only historical baseline. It establishes the watermark and is not backfilled with a GitHub Release. For each newly selected canonical release, the workflow publishes an immutable annotated tag named `obsidian-v<upstream-version>-<fork-release>` on the validated `main` commit, then creates the corresponding GitHub Release. The suffix is one greater than the maximum existing suffix for that upstream version. Existing tags are never moved, overwritten, or reused; an inconsistent tag or collision stops publication instead of rewriting remote state.

Every GitHub Release is non-draft. A stable canonical version sets the prerelease flag to false; a SemVer prerelease sets it to true. Generated notes identify the canonical tag and commit, the fork commit, any superseded canonical tags, and a permalink to `FORK_PATCHES.md` at the immutable fork tag. The notes do not infer patch statuses: the ledger remains authoritative.

Publication failures create or update one deduplicated issue titled **Upstream release mirroring requires attention**. After correcting the reported state, a maintainer can recover idempotently with the same candidate SHA and successful CI run ID. The controller validates that the run path is exactly `.github/workflows/ci.yml`, that it was successful and push-triggered on `main`, that its head SHA matches the candidate, and that the candidate is still current `origin/main`. Recovery applies the same exact workflow-path check when revalidating tag provenance. If an annotated tag was published before GitHub Release creation failed, recovery validates its provenance and creates only the missing Release.

The following is a maintainer-run hosted recovery example. Local repository preparation must not run it:

```bash
gh workflow run mirror-release.yml --repo obsidianmd/wordgard \
  -f candidate_sha='<40-character-main-commit>' \
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

Protect `main` by requiring a pull request, one approval, and the strict `CI / Test` status check. Keep push-triggered `CI` from `.github/workflows/ci.yml` enabled on `main`; release publication accepts only a successful push-triggered run of that exact workflow for the exact current `main` commit. Enable merge commits and disable squash and rebase merging so patch commits and trailers survive.

Add tag rules for `obsidian-v*` that prevent tag updates and deletion while allowing GitHub Actions to create new matching tags. Do not grant the release workflow permission to bypass update or deletion protection.

## Initial publication handoff

The repository preparation process leaves all work local. A maintainer performs hosted rollout only after reviewing the local history and verification evidence:

1. Push local `main` and set it to track `origin/main`.
2. Keep default workflow permissions read-only and allow `GITHUB_TOKEN` workflows to create pull requests; confirm the explicit sync and release workflow permissions listed above are permitted.
3. Enable merge commits, disable squash/rebase merging, and enable merged-branch deletion.
4. Confirm a push to `main` runs `CI` and that `CI / Test` passes.
5. Protect `main` with one approval, strict `CI / Test`, conversation resolution, and no force-pushes or deletion.
6. Configure `obsidian-v*` tag rules to block update and deletion while allowing workflow tag creation.
7. Manually run `Sync upstream` and confirm the expected no-change result or review its PR/issue.
8. Validate hosted release mirroring: with `obsidian-v0.3.1-2` present as the baseline and no newer eligible canonical tag, a successful current-`main` push CI run must produce no backfill Release or replacement tag.
9. Make any Opal or Link dependency bump as a separate reviewed change after the desired immutable fork tag exists.

These maintainer-only commands must not be executed by automated local preparation:

```sh
git push --set-upstream origin main

gh api --method PUT repos/obsidianmd/wordgard/actions/permissions/workflow \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=true

gh api --method PATCH repos/obsidianmd/wordgard \
  -F allow_merge_commit=true \
  -F allow_squash_merge=false \
  -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true
```

After `CI / Test` exists, apply branch protection with this payload:

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

Save that JSON temporarily, then run:

```sh
gh api --method PUT repos/obsidianmd/wordgard/branches/main/protection \
  --input /tmp/wordgard-branch-protection.json

gh workflow run sync-upstream.yml --repo obsidianmd/wordgard
```

Configure the `obsidian-v*` tag rules in the hosted repository before relying on automatic release publication. The exact ruleset API payload depends on the repository's ruleset and bypass-actor configuration; review it before applying it as a maintainer.
