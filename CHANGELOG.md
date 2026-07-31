# Changelog

All notable changes to `@baylarsadigov/omp-undo-redo` are recorded here.

## [1.0.27] - 2026-07-31

### Fixed

- Clarify that full-mode `/undo` and `/redo` restore the worktree while leaving the Git index unchanged.
- Add regression coverage for staged-turn worktree/index divergence across undo and redo.
- Document how to inspect preserved staged and unstaged changes before committing.

## [1.0.26] - 2026-07-31

### Fixed

- Ensure clean `dist/` build by removing output directory before emitting compiled files and enforcing exact output path parity with `src/**/*.ts`.
- Automatically trigger clean build before `npm pack` and `npm publish` via `prepack` hook to prevent stale or orphaned generated artifacts from being packaged.
- Add package entry smoke check (`npm run smoke:package`) to verify the compiled extension loads and registers commands correctly without behavior changes to `/undo` or `/redo`.

## [1.0.25] - 2026-07-30

### Fixed

- Prevent temporary-directory allocation and cleanup failures during snapshot creation and patch application from bypassing session fallback or rejecting lifecycle events and commands.
- Catch temporary directory allocation errors in `createSnapshotCommit` and `applyCheckpoint` so before/after snapshot failures record session-only checkpoints and patch allocation failures report standard failure notifications without mutating state.
- Suppress temporary directory cleanup rejections in `finally` blocks so cleanup errors cannot override primary snapshot or patch results.

## [1.0.24] - 2026-07-30

### Fixed

- Treat session-only checkpoints as file-history continuity barriers so older Git patches are never applied across unknown file changes.
- Release invalidated private refs while allowing later Git checkpoints to start a new restorable file-history segment.

## [1.0.23] - 2026-07-29

### Fixed

- Keep every completed turn available for session-only undo/redo when Git file checkpointing is unavailable.
- Support full file checkpoints in initialized unborn Git repositories without changing `HEAD`, branch refs, or the real index.
- Report stable checkpoint-unavailability reasons in `/undo` and `/redo` notifications.

## [1.0.22] - 2026-07-29

### Fixed

- Clear redo history after successful unrelated session-tree, session-switch, or session-branch navigation while preserving undo history.
- Keep redo available for matching extension-generated navigation, no-op navigation, and cancelled navigation.

## [1.0.21] - 2026-07-29

### Fixed

- Allow `/undo` and `/redo` to navigate conversation-only turns whose snapshots have no file delta.
- Allow turns that change only ignored files to navigate without a false worktree-conflict failure.
- Preserve existing conflict handling for non-empty file deltas.

## [1.0.20] - 2026-07-29

### Fixed

- Release active and pending private checkpoint refs during graceful `session_shutdown`, including checkpoints tracked by previously visited sessions and repositories.
- Batch compare-and-delete private refs while preserving unrelated refs and leaving mismatched refs untouched.

## [1.0.19] - 2026-07-29

### Fixed

- Fixed subdirectory sessions using different before/after snapshot scopes, which could cause `/undo` to revert pre-existing changes elsewhere in the repository.

## [1.0.18] - 2026-07-29

### Fixed

- Fixed the critical branch-history rewind: checkpoints no longer use normal commits or `git reset`, so agent commits and branch refs remain unchanged.
- Preserved the user's real Git index during snapshot capture and file restoration.
- Made conflicting worktree changes fail safely instead of partially overwriting files.

## [1.0.17] - 2026-07-29

### Fixed

- Protect active undo/redo checkpoint commits with private refs so reflog expiry and aggressive Git garbage collection cannot invalidate navigation history.

## [1.0.16] - 2026-07-18

### Documentation

- Documented OMP and Pi installation commands, update commands, and project links.

## [1.0.15] - 2026-07-18

### Changed

- Added npm, repository, homepage, and issue-tracker links to package metadata and documentation.
- Documented `omp plugin install` and `omp plugin upgrade` as the supported OMP installation and update commands.

## [1.0.14] - 2026-07-17

### Fixed

- Finalize the file checkpoint on `agent_end` so redo captures the complete user request, including all tool-loop file changes.

## [1.0.13] - 2026-07-17

### Fixed

- Restore file changes with temporary Git checkpoints while keeping the active branch `HEAD` unchanged.
- Preserve local changes as unstaged files after undo and redo.

## [1.0.12] - 2026-07-17

### Fixed

- Removed the `git-undo` and `git-redo` commands.
- Replaced commit-based checkpoints with in-memory workspace file snapshots; undo/redo no longer creates commits or rewrites Git history.
- Bind session-tree navigation from the command context so `/undo` and `/redo` work with current OMP extension contexts.

## [1.0.11] - 2026-07-17

### Fixed

- Add a package-root `index.js` extension entry and `main` metadata for loaders that discover npm extensions through the package root instead of the manifest entry.

## [1.0.10] - 2026-07-17

### Fixed

- Declare the extension entry under both `omp.extensions` and `pi.extensions` so OMP/ Pi plugin loaders across supported releases discover the commands.

## [1.0.7] - 2026-07-16

### Changed

- **Breaking refactor**: undo/redo now creates Git checkpoints at each `turn_end` and uses `git reset --hard` to revert both file changes and session context.
- Added `pi.exec("git", ...)` integration for checkpoint creation (`git add -A`, `git commit`) and restoration (`git reset --hard`).
- Removed the old tree-only navigation approach (`redo-state.ts`, `invalidateIfDiverged`).
- Graceful fallback when Git is unavailable (extension does nothing rather than crashing).

## [1.0.6] - 2026-07-16

### Fixed

- Use per-session navigation state via `Map<string, SessionNavigation>` so undo/redo state is no longer shared and lost across sessions.
- `session_start` and `turn_end` handlers now correctly use the session context to operate on the right session's navigation state.

## [1.0.5] - 2026-07-16

### Fixed

- Track OMP's effective leaf after navigating to a user entry so redo remains available, including when the boundary is the session root.

## [1.0.4] - 2026-07-16

### Fixed

- Make the first completed interaction undoable by navigating to its user-prompt boundary.

## [1.0.3] - 2026-07-16

### Changed

- Published the initial public package version using the first unused npm version.

## [1.0.2] - 2026-07-16

### Changed

- Published the initial public package version after npm permanently reserved earlier attempted versions.

## [1.0.1] - 2026-07-15

### Changed

- Published the initial public package version under a new npm version after the registry permanently reserved the previously unpublished `1.0.0` version.

## [1.0.0] - 2026-07-15

### Added

- `/undo` navigation to the checkpoint before the latest completed user interaction.
- `/redo` navigation through the extension's in-memory redo history.
- OMP plugin-manifest registration through the `omp.extensions` package field.
- TypeScript build, type-check, lint, format-check, and test tooling.

[1.0.26]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.26
[1.0.25]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.25
[1.0.24]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.24
[1.0.23]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.23
[1.0.22]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.22
[1.0.21]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.21
[1.0.19]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.19
[1.0.18]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.18
[1.0.7]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.7
[1.0.6]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.6
[1.0.5]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.5
[1.0.4]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.4
[1.0.3]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.3
[1.0.2]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.2
[1.0.1]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.1
[1.0.0]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.0
