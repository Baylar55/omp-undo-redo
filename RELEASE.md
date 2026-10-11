# Release Runbook

`.github/workflows/publish.yml` runs on every `v*.*.*` tag and does the rest: it fails if the tag
does not match `package.json`, runs `npm run verify`, skips publish if the version already exists on
npm, publishes with provenance, and creates the GitHub Release. Your job is the version bump and the
tag.

## Pick the version

Anyone on `^1` or `~1.6` gets minors and patches without asking, so a change that can stop a
working install ships only in a major. Read `## [Unreleased]` before `npm version`:

- **Major** if any entry raises `engines.node` or the `peerDependencies` minimum, removes or renames
  an `OMP_UNDO_REDO_*` variable, command or option without keeping the old name working, changes
  what an existing one does, or removes a feature. Label each such entry **Breaking**; a
  **Breaking** entry never ships in a minor or patch. A security fix that stops honoring something
  the README never documented (an inherited `GIT_DIR`, say) is not Breaking.
- **Minor** if anything was added (a variable, a command, an option).
- **Patch** otherwise.

```bash
awk '/^## \[/{n++} n==1' CHANGELOG.md | grep -n Breaking   # any hit: the version must be X.0.0
```

If the release changes stored data (history schema, a value older versions refuse, where snapshots
or history live), the changelog says whether rolling back to the previous version is safe and what
it loses. A move the new version migrates by itself does not need a major; one the user has to act
on does.

A version already on npm cannot be renumbered. Revert in the next release and mark the bad one:
`npm deprecate @baylarsadigov/omp-undo-redo@<version> "<why>; use <fixed version>"`.

## Release

```bash
git switch -c release/v<version> origin/main
npm version <version> --no-git-tag-version   # updates package.json + package-lock.json
```

Set the top `CHANGELOG.md` heading to `## [<version>] - YYYY-MM-DD` and describe only this release.
Set both pinned install commands in `README.md` to `@<version>`.

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

The GitHub Release lists merged PRs (`--generate-notes`), not the changelog. If this release has a
**Breaking** entry or a rollback note, paste it at the top of the release notes.

## Three rules

- **Merge through a PR.** `main` requires the `Quality checks` status. A `workflow_dispatch` run does
  not satisfy it — only the `pull_request` run counts.
- **Never move or reuse a tag.** Publish skips any version npm already has, so a re-pushed tag
  silently does nothing. A failed or partial publish is corrected with a new patch version.
- **Never `npm publish` locally.** The workflow holds `NPM_TOKEN` and provenance requires its OIDC
  identity.

Failure triage: `gh run view <run-id> --log-failed`.
