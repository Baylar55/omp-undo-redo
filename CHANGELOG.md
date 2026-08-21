# Changelog

All notable changes to `@baylarsadigov/omp-undo-redo` are recorded here.

## [1.5.1] - 2026-08-21

### Performance

- Persist the Git alternate index across turns instead of deleting it after each `after` snapshot (`src/core/checkpoints.ts:21-37,172-183,448-540`, `src/index.ts:34,1007`). The first turn seeds the index with a full `git add -A` to populate the stat cache; all later `before`/`after` snapshots reuse the warm index and skip re-hashing unchanged tracked and previously-added untracked files via git's stat-dance. `HEAD^{tree}` changes, `.gitignore` updates (normalization via `diff-index --diff-filter=ADT` + `reset`), and aborted-turn cleanup correctly invalidate the cached index and fall back to a fresh seed.

### Fixed

- Avoid a full cold re-hash on every `before` turn for Git workspaces with large untracked trees: cross-turn persistence eliminates the per-turn `read-tree HEAD^{tree}` + cold `add -A` that previously made each turn pay full-index cost twice.

## [1.5.0] - 2026-08-19

### Added

- Snapshot non-Git workspaces through a private per-workspace Git repository (opencode parity): the repository lives under the store root, snapshots use the same alternate-index machinery as regular Git mode, and the private repo is excluded from its own snapshots. Set `OMP_UNDO_REDO_PRIVATE_GIT=0` to force the previous blob-store behavior for non-Git workspaces.
- Private-Git repositories seed the blob store's built-in ignore list (`node_modules`, `dist`, `.omp`, and similar) into `info/exclude`, so dependency/build/state directories are skipped on non-Git workspaces just like they are in blob mode.
- Private-repo housekeeping: a background `git gc --prune=now` runs after every 20 captured snapshots per private repo (and at shutdown, when a gc is due), so unreferenced snapshot objects are reclaimed promptly; stale private repositories are evicted when their workspace disappears.

### Fixed

- Bound checkpoint capture: `before_agent_start`, `agent_end`, and the undo/redo commands now wait at most ~3 s for an in-flight capture and finalize an overrunning capture in the background, so extension handlers can never hit the host's 30 s handler timeout on huge non-Git workspaces (previously the whole workspace walk ran inside the handler).
- Keep a deferred (overrunning) capture's finalize bound to its own turn: it records the checkpoint captured at that turn's start with the leaf captured at that turn's end, and a later turn that starts while the capture is still settling gets no new capture instead of stacking overlapping `git add` runs — so a slow capture can never be recorded against the wrong turn's leaf or pre-turn state.

### Changed

- Non-Git workspaces silently switch from the blob store to the private per-workspace Git repository on upgrade. Existing blob-mode session history (and blob-mode checkpoints held by the 2-day retention) is not visible through the new backend; the blob store fallback remains available via `OMP_UNDO_REDO_PRIVATE_GIT=0`.

## [1.4.1] - 2026-08-18

### Fixed

- Restore the undo/redo cursor on resume when the session was left at an undone turn or at a tree position browsed away from the cursor. Previously, resuming such a session silently discarded the whole durable file history and fell back to conversation-only undo. Completed Git and non-Git checkpoints plus the undo/redo cursor now survive a normal terminal restart in every multi-turn case, matching the README guarantee.
- Treat the persisted history state as authoritative when all of its checkpoints still exist in the session tree, instead of re-deriving the cursor from the current tree leaf. Browsing the tree does not move the undo/redo cursor or the file state, so a leaf-based cursor guess conflicted with the workspace snapshot state.

### Changed

- Remove the now-unused leaf-matching load scan and the dead `expectedLeaf`/`matchesEffectiveLeaf` helpers from the history stores.

## [1.4.0] - 2026-08-17

### Changed

- Internal refactor: split the 1756-line `BlobStore` class into a facade plus single-concern modules under `src/core/blob-store/` (locking, liveness/leases, workspace walking, apply/rollback, refs, manifest codec, size accounting, garbage collection). No behavior change; the public API surface is unchanged.
- Note for deep importers: the module previously at `src/core/blob-store.ts` (built to `dist/core/blob-store.js`) now lives at `src/core/blob-store/index.ts` (built to `dist/core/blob-store/index.js`). Imports from the package root are unaffected.
- Declare the public entry points explicitly with a `package.json` `exports` map (the package root and `./package.json`). Deep imports into `dist/` were never documented; they now fail with Node's standard `ERR_PACKAGE_PATH_NOT_EXPORTED` instead of silently depending on internal file layout.

## [1.3.3] - 2026-08-14

### Performance

- Scope non-Git snapshot captures and applies to a per-workspace filesystem lock instead of the single global store lock, so a slow capture in one workspace, session, or process no longer blocks snapshots, applies, or garbage collection in another.
- Hold the store lock only around tree-manifest and ref publication; workspace walks (reads, content-addressed blob writes, and journal recovery) run outside it. GC defers its sweep while any capture is in flight — tracked by heartbeat markers in the shared store — so blobs a walk just wrote are never collected before the ref that references them is published, and captures still reclaim unreferenced data immediately when no capture is running.

## [1.3.2] - 2026-08-13

### Performance

- Defer the store-wide expiration and garbage-collection sweep to a background run shortly after extension startup so session initialization and the first undo/redo no longer block on a scan of the entire shared store.
- Skip the O(store) tree-manifest and blob sweep when nothing was actually expired or evicted; stale active-ref cleanup for crashed owners still runs on every pass.
- Track blob store size incrementally (exact bytes for writes, deletion-adjusted after GC) so storage-cap eviction checks are O(1) instead of re-walking every blob and tree file per evicted session.

## [1.3.1] - 2026-08-13

### Performance

- Drop the per-entry `realpath` from non-Git workspace walks; storage-root containment is now a normalized string-prefix comparison against canonical roots, with `realpath` retained only for the rare symbolic-link entries whose true target can diverge from their name path.
- Replace per-directory stat batches with a single global concurrency limit (`walkConcurrency` option on `BlobStore`, default `16`, capped at `64`), overlapping directory reads and per-file metadata stats across the whole tree without multiplying through depth.
- Skip the tree-manifest rewrite and its `exists` probe when the captured tree ID matches the validated workspace cache, and write the on-disk manifest from the already-hashed canonical string instead of serializing the entries a second time.
- Add `npm run bench:walk` (`scripts/bench-walk.mjs`) to measure cold, warm, and incremental non-Git captures on a synthetic workspace.

## [1.3.0] - 2026-08-12

### Added

- Add snapshot history retention: dormant session histories untouched for longer than `OMP_UNDO_REDO_RETENTION_DAYS` (default `2`) are expired automatically at startup, so Git refs, blob objects, and history files no longer grow without bound. Expired sessions resume with a warning and session-only undo/redo.
- Add a storage cap for the non-Git blob store via `OMP_UNDO_REDO_MAX_STORE_MB` (default `1024`, i.e., 1 GiB): when the store exceeds the cap, the oldest inactive session histories are evicted iteratively until it drops back below.
- Track history access with `lastAccessedAt` (history schema v2, backward compatible with v1) and write expiration tombstones so expired history is reported distinctly from missing or corrupt history.
- Verify candidate sessions against a live active-session set during expiration so sessions that start concurrently are never expired by their own startup.

### Changed

- Bump history store schema to v2; readers accept v1 and v2, and re-saving writes v2 with a refreshed `lastAccessedAt`.
- Delete both resumable and stale active refs during expiration and always run garbage collection after cleanup, keeping the blob store consistent.
- Default retention and storage cap are each `0`-disablable; setting both to `0` disables automatic cleanup entirely (indefinite retention).

### Documentation

- Document retention and storage-cap configuration, the interaction rules between the two variables, how to set them per platform, and the expiration behavior and user-visible messages.

## [1.2.5] - 2026-08-10

### Changed

- Add `peerDependenciesMeta` for `@oh-my-pi/pi-coding-agent` in `package.json` to mark the peer dependency as optional, preventing package managers from installing duplicate OMP package instances in plugin directories.

### Performance

- Optimize non-Git snapshot restoration and history verification by validating blob existence only for changed paths in `BlobStore` and deduplicating shared tree checks per history load in `BlobHistoryStore`.

## [1.2.4] - 2026-08-10

### Performance

- Cache unchanged non-Git workspace files in `BlobStore` using file fingerprints (size, mtime, ctime, birthtime, dev) and a racily-clean guard to avoid unnecessary disk re-reads.

## [1.2.3] - 2026-08-07

### Changed

- Reuse and safely normalize the private Git snapshot index between turn boundaries, avoiding repeated content hashing for unchanged tracked files while preserving fresh-index ignore and type semantics.

## [1.2.2] - 2026-08-07

### Fixed

- Keep skipped non-Git snapshot paths and overlapping parents or descendants untouched during partial undo and redo, preventing uncaptured files from being deleted.
- Reject pre-upgrade in-flight journals whose recorded mutations overlap skipped paths rather than replaying an unsafe deletion.

## [1.2.1] - 2026-08-06

### Changed

- Add Pi catalog discovery keywords and publish metadata for the package gallery.
- Update pinned installation examples to version 1.2.1.

## [1.2.0] - 2026-08-04

### Added

- Add file undo/redo for non-Git workspaces through a content-addressed snapshot store.

## [1.1.0] - 2026-08-01

### Added

- Publish authoritative schema-2 Undo/Redo action state for Git and non-Git sessions.
- Publish selected session leaf, navigation revision, action availability, and exact action results for external clients.
- Isolate runtime state by extension PID and runtime ID with atomic private files and best-effort cleanup.
- Add regression coverage for runtime-store ordering, isolation, stale cleanup, shutdown, filesystem failures, and lifecycle publication.

### Changed

- Reset stale action results when a session starts or resumes.

## [1.0.32] - 2026-07-31

### Added

- Preserve full undo and redo history across terminal restarts when the same session and worktree are resumed.
- Reconstruct session-only undo boundaries when durable Git checkpoint metadata is unavailable.

### Changed

- Retain completed checkpoints on graceful shutdown while continuing to release interrupted pending checkpoints.
- Replace the misleading pre-turn warning with state-specific empty-history and closing-session messages.

### Fixed

- Ignore OMP's trailing `session_exit` diagnostic entry when validating resumed history, so quitting with Ctrl+C does not downgrade a valid Git checkpoint to session-only undo.

## [1.0.30] - 2026-07-31

### Fixed

- Serialize overlapping undo and redo operations so each command advances exactly one checkpoint without corrupting the history position.

## [1.0.29] - 2026-07-31

### Added

- Add conservative owner-scoped checkpoint leases and automatic cleanup for provably stale same-host runtimes, with runtime-scope protection for Linux PID namespaces.

### Fixed

- Preserve full undo/redo through legacy ownerless fallback when lease publication is unavailable.
- Bound maintenance Git operations and keep stale cleanup asynchronous, compare-and-delete based, and safe under concurrent runtimes.

## [1.0.28] - 2026-07-31

### Fixed

- Make staged-state regression assertions stable across Git platforms by separating extension apply checks from Git index stat refreshes.
- Add conservative owner-scoped v2 checkpoint refs with repository-local leases and asynchronous cleanup for only provably stale same-host owners. Linux cleanup is additionally bound to kernel boot and PID namespace identity; unresolved runtime scope, existing ownerless refs, and uncertain ownership cases remain manual-cleanup paths.
- Make the Prettier verification gate honor the checked-out platform line endings so Windows CRLF worktrees do not fail on otherwise formatted files.

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

[1.3.0]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.3.0
[1.2.5]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.2.5
[1.0.30]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.0.30
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
