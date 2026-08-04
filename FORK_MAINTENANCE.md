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
# Resolve files, then:
git add schema/code.ts
git commit
git push --set-upstream origin sync-upstream-manual
gh pr create --base main --head sync-upstream-manual
```

Never force-push `main` and never commit unresolved conflict markers.

## Fork releases

After merging and testing a release candidate:

```sh
git switch main
git pull --ff-only origin main
git tag -a obsidian-v0.3.1-1 -m "Obsidian Wordgard 0.3.1 fork release 1"
git push origin obsidian-v0.3.1-1
```

Use `obsidian-v<upstream-version>-<fork-release>`. Increment the final number for another release based on the same upstream package version. Never move or reuse a published tag.

## Opal and Link dependencies

Pin an immutable tag in each consumer's `package.json` and commit the resulting lockfile. Use the GitHub SSH form when development environments have GitHub SSH access:

```json
"wordgard": "git+ssh://git@github.com/obsidianmd/wordgard.git#obsidian-v0.3.1-1"
```

Use the HTTPS form where SSH is unavailable:

```json
"wordgard": "git+https://github.com/obsidianmd/wordgard.git#obsidian-v0.3.1-1"
```

## Repository settings

GitHub Actions must be allowed to create pull requests. Protect `main` by requiring a pull request, one approval, and the `CI / Test` status check. Enable merge commits and disable squash and rebase merging so patch commits and trailers survive.

## Initial publication handoff

The repository preparation process leaves all work local. A maintainer performs publication only after reviewing the local history and verification evidence:

1. Push local `main` and set it to track `origin/main`.
2. Allow `GITHUB_TOKEN` workflows to create pull requests.
3. Enable merge commits, disable squash/rebase merging, and enable merged-branch deletion.
4. Manually run `CI` and confirm `CI / Test` passes.
5. Protect `main` with one approval, strict `CI / Test`, conversation resolution, and no force-pushes or deletion.
6. Manually run `Sync upstream` and confirm the expected no-change result or review its PR/issue.
7. Create and push `obsidian-v0.3.1-1` only after every check passes; never move it afterward.

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

gh workflow run ci.yml --repo obsidianmd/wordgard
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

git tag -a obsidian-v0.3.1-1 -m "Obsidian Wordgard 0.3.1 fork release 1"
git push origin obsidian-v0.3.1-1
```
