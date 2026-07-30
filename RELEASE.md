# Release Runbook

This runbook defines the release process for `@baylarsadigov/omp-undo-redo`. It is written for maintainers and AI agents.

Use this process for each fix or feature release. Replace values such as `<version>`, `<branch>`, `<pr-number>`, and `<run-id>` before you run a command.

## Release rules

- Make all changes on a fix or feature branch.
- Merge the branch through a pull request.
- Do not push directly to `main`. A repository rule requires the `Quality checks` status.
- Create the release tag only after the pull request is merged into `main`.
- The tag, `package.json` version, and `package-lock.json` version must match.
- Use a new npm version for each release. Never reuse a version that npm already contains.
- Do not force-push `main` or a release tag.
- Do not commit credentials, npm tokens, or local configuration.
- Preserve unrelated worktree changes. Stage only the intended release files.
- Use the GitHub Actions publish workflow. Do not use a local `npm publish` command unless the maintainer explicitly requests it.

## Repository automation

Two workflows control integration and publication:

- `.github/workflows/ci.yml` runs `Quality checks` for pull requests into `main`.
- `.github/workflows/publish.yml` runs when a tag matches `v*.*.*`.

The publish workflow performs these actions:

1. It verifies that the tag matches the package version.
2. It runs `npm run verify`.
3. It checks whether npm already contains the version.
4. It publishes the public package with provenance.
5. It creates the GitHub Release.

The publish workflow uses the `NPM_TOKEN` GitHub Actions secret. Local npm authentication is not required for the normal release process.

## Step 1: Select the version and branch

Use semantic versioning:

- Patch: a backward-compatible bug fix, for example `1.0.23` to `1.0.24`.
- Minor: a backward-compatible feature, for example `1.0.24` to `1.1.0`.
- Major: an incompatible behavior or API change, for example `1.1.0` to `2.0.0`.

Use a descriptive branch name:

```text
fix/<short-description>-v<version>
feature/<short-description>-v<version>
```

Example:

```text
fix/session-file-history-gap-v1.0.24
```

## Step 2: Check the local and remote state

Start from the current remote `main` branch:

```bash
git switch main
git fetch origin main --tags
git pull --ff-only origin main
git status --short --branch
```

The worktree must be clean before you start. If it is not clean, identify the owner of each change. Do not discard, format, stage, or commit unrelated changes.

Check the current releases:

```bash
git tag --sort=-version:refname
npm view @baylarsadigov/omp-undo-redo version
```

Check GitHub access and the npm secret:

```bash
gh auth status
gh secret list --app actions
```

The secret list must contain `NPM_TOKEN`. Do not print the secret value.

A local `npm whoami` failure does not block this process. The GitHub workflow publishes the package.

## Step 3: Create the work branch

Create the branch before you change release metadata:

```bash
git switch -c <branch>
```

Make the source, test, and documentation changes on this branch.

## Step 4: Update release metadata

Update both npm metadata files without creating a tag or commit:

```bash
npm version <version> --no-git-tag-version
```

Change the top `CHANGELOG.md` heading to this form:

```text
## [<version>] - YYYY-MM-DD
```

Describe only the changes in this release. Keep `README.md` consistent with user-visible behavior.

Confirm the metadata:

```bash
node -p "require('./package.json').version"
npm view @baylarsadigov/omp-undo-redo@<version> version
```

The second command must return a not-found error before publication. If it returns the version, select a new version.

## Step 5: Verify the release candidate

Run the complete project validation:

```bash
npm run verify
```

The command must pass formatting, lint, type checking, tests, build, and package checks.

On Windows, Prettier can report line-ending differences in unchanged files. Do not format the entire repository without review. First, inspect the changed-file list:

```bash
git status --short
git diff --stat
```

Format only intended files. If a formatter changes an initially clean unrelated file, restore only that formatter-created change.

Run `npm run verify` again after each release-candidate change.

## Step 6: Commit and push the branch

Review the intended change set:

```bash
git status --short --branch
git diff --stat
```

Stage explicit paths. Do not use `git add .` when unrelated worktree changes exist.

```bash
git add <intended-paths>
git commit -m "<type>: <release change>"
git push -u origin <branch>
```

Confirm that the pushed branch contains the release metadata and all tests.

## Step 7: Open and merge the pull request

Create a pull request into `main`:

```bash
gh pr create --base main --head <branch> --title "<title>" --body "<summary and verification>"
```

Get the pull request number from the command output. Then inspect its checks:

```bash
gh pr checks <pr-number>
```

GitHub can take a short time to attach the pull-request workflow. If the command reports no checks, wait and inspect the workflow runs:

```bash
gh run list --workflow ci.yml --branch <branch> --limit 5
```

Do not use a manual `workflow_dispatch` run to satisfy branch protection. A manual run does not provide the required pull-request status.

After GitHub attaches the check, wait for it:

```bash
gh pr checks <pr-number> --watch --interval 10
```

Merge only after `Quality checks` succeeds:

```bash
gh pr merge <pr-number> --merge --delete-branch
```

Do not merge locally and push `main`. GitHub rejects a direct push when the required status is missing.

## Step 8: Synchronize local `main`

After the pull request is merged, update the local branch:

```bash
git switch main
git fetch origin main --prune
git pull --ff-only origin main
```

Confirm the state:

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
```

The worktree must be clean. The two commit hashes must match.

## Step 9: Create and push the tag

Confirm that `package.json` contains `<version>`. Then create an annotated tag on the merged `main` commit:

```bash
git tag -a v<version> -m "Release v<version>"
git push origin v<version>
```

Do not move or reuse an existing release tag. The tag push starts the publish workflow.

## Step 10: Monitor publication

Find the publish run:

```bash
gh run list --workflow publish.yml --limit 5
```

Copy the run ID for `v<version>`. Wait for completion:

```bash
gh run watch <run-id> --exit-status --interval 10
```

If the workflow fails, inspect only the failed steps:

```bash
gh run view <run-id> --log-failed
```

Do not retry by moving the tag. Check npm first. If publication state is uncertain, use a new patch version for the correction.

## Step 11: Verify the public release

Verify npm:

```bash
npm view @baylarsadigov/omp-undo-redo@<version> version
npm view @baylarsadigov/omp-undo-redo version dist-tags.latest
```

The exact version must exist. For a normal stable release, `latest` must equal `<version>`.

Verify the GitHub Release:

```bash
gh release view v<version> --json tagName,isDraft,isPrerelease,url,targetCommitish
```

Verify that the tag points to the remote `main` commit:

```bash
git rev-parse origin/main
git rev-parse v<version>^{}
```

The two commit hashes must match.

Verify the final repository state:

```bash
git status --short --branch
gh pr view <pr-number> --json state,mergedAt,url
```

The pull request must be merged. The worktree must be clean.

## Common failures

### Direct push to `main` returns `GH013`

Cause: The repository requires the `Quality checks` status.

Action: Push the fix or feature branch. Open a pull request. Wait for its required check. Merge through GitHub.

### `gh pr checks` reports no checks

Cause: GitHub has not attached the pull-request workflow yet.

Action: Wait briefly. Use `gh run list --workflow ci.yml --branch <branch> --limit 5`. Watch the pull-request run after it appears.

### A manual CI run succeeds, but merge remains blocked

Cause: A `workflow_dispatch` run does not satisfy the required pull-request status.

Action: Wait for the run whose event is `pull_request`.

### `npm whoami` returns `ENEEDAUTH`

Cause: The local machine has no npm login.

Action: Use the tag-triggered GitHub workflow. Confirm that the repository contains the `NPM_TOKEN` Actions secret.

### The publish workflow fails

Action: Run `gh run view <run-id> --log-failed`. Check npm before any retry. Never publish the same npm version twice. Never force-move a public release tag.

### The npm version exists, but the GitHub Release does not exist

Action: Do not republish npm. Inspect the publish workflow. Create the missing GitHub Release for the existing tag only after you confirm that the tag and npm package match.

## Final report

Report these facts after a successful release:

- Branch name
- Pull request URL and merged state
- Merge commit hash
- Tag and GitHub Release URL
- GitHub Actions publish-run URL and result
- npm package URL and published version
- `latest` distribution tag
- Validation results
- Final worktree state
