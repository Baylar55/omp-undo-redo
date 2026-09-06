# Release Runbook

`.github/workflows/publish.yml` runs on every `v*.*.*` tag and does the rest: it fails if the tag
does not match `package.json`, runs `npm run verify`, skips publish if the version already exists on
npm, publishes with provenance, and creates the GitHub Release. Your job is the version bump and the
tag.

## Release

```bash
git switch -c release/v<version> origin/main
npm version <version> --no-git-tag-version   # updates package.json + package-lock.json
```

Set the top `CHANGELOG.md` heading to `## [<version>] - YYYY-MM-DD` and describe only this release.

```bash
npm run verify                               # optional locally; publish.yml runs it anyway
git commit -am "release: v<version>"
git push -u origin HEAD
gh pr create --base main --fill
gh pr checks --watch --interval 10
gh pr merge --merge --delete-branch
```

Tag the merged commit:

```bash
git switch main && git pull --ff-only
git tag -a v<version> -m "Release v<version>"
git push origin v<version>
gh run list --workflow publish.yml -b v<version>   # a tag run takes a few seconds to appear
gh run watch <run-id> --exit-status
```

## Three rules

- **Merge through a PR.** `main` requires the `Quality checks` status. A `workflow_dispatch` run does
  not satisfy it — only the `pull_request` run counts.
- **Never move or reuse a tag.** Publish skips any version npm already has, so a re-pushed tag
  silently does nothing. A failed or partial publish is corrected with a new patch version.
- **Never `npm publish` locally.** The workflow holds `NPM_TOKEN` and provenance requires its OIDC
  identity.

Failure triage: `gh run view <run-id> --log-failed`.
