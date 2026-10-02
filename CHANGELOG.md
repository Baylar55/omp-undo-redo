# Changelog

All notable changes to `@baylarsadigov/omp-undo-redo` are recorded here.

## [Unreleased]

### Fixed

- **Every untracked file was re-hashed on each reused-index snapshot in a repository with commits.** The retained alternate index was normalized with `diff-index --diff-filter=ADT` against HEAD, so every untracked (non-ignored) file showed as `A`, `reset` dropped it from the index, and `add -A` read and hashed it again: on both the before- and after-snapshot of every turn. Normalization now resets only `D`/`T` entries and added gitlinks, so untracked files keep their stat cache. The two cases `A` covered are handled explicitly: an untracked path that became ignored after it was staged is pruned (ignored paths HEAD tracks stay, as in a fresh snapshot), and an untracked nested repository whose `.git` was later removed has its gitlink reset, since `add -A` would otherwise keep the stale gitlink and leave the folder's files, and any edit to them, out of every snapshot. That gitlink fix also applies to unborn-HEAD sessions, which had the bug already.
- **Startup could run one full `git gc` per snapshot store at the same time.** The retention sweep expires stores one by one, but each expiry started its store's gc in the background without waiting, so a launch with many expired stores ran that many repacks at once (each allowed 15 minutes), with matching CPU, memory and disk spikes. Every gc trigger (retention sweep, capture threshold, shutdown) now goes through one process-wide queue, so at most one gc runs at a time. A failed gc still does not block the ones queued behind it.
- **A large workspace could stay without file checkpoints indefinitely.** When the before-snapshot finished after a tool call had given up waiting for it (25 s, `toolCallDeadlineMs`), the turn correctly became session-only, but discarding the snapshot also deleted its warmed index lease. The next turn re-hashed the whole workspace from an empty index, overran again, and the cycle repeated: no checkpoint, a full re-hash and a 25 s wait on the first tool call every turn. This path now deletes only the before-ref and returns the index to the pool, so the next turn reuses the stat cache (its baseline is still re-checked on reuse).
- **`agent_end` could hit OMP's 30 s handler timeout** (`handler timed out after 30000ms`). Only the wait for the before-snapshot was bounded; once it settled, the after-snapshot and history write ran inside the handler with no limit, which a large workspace on Windows can exceed. `agent_end` now returns after at most 25 s (`finalizeDeadlineMs`); the finalize keeps running in the background and `/undo`/`/redo` still wait for it, as they already did for an overrunning capture.
- **Sessions left via `/new`, `/resume`, fork or handoff stayed active for the process's lifetime.** Only `session_shutdown` cleared `navigations` and `explicitActiveHashes`, so every session switched away from kept its navigation in memory, had its `.active.<hash>` marker refreshed every 10 minutes, and was skipped by every local and foreign retention sweep. After a switch, the source session is now released once its deferred finalize, initialization and in-flight capture have settled (so its last turn still lands in its persisted history): its navigation is suspended, its unowned pending checkpoint released, and it leaves the active set. Resuming it reloads its history from disk, as after a restart. A same-session reload is not a release, and a switch whose source was clobbered by an interleaved navigation releases nothing.
- **A snapshot store left half-initialized by a crash or a held `config.lock` was trusted forever.** `git init` writes HEAD before the `git config` calls that follow it (11 for a Private-Git store, 3 for a Git-mode store), and older gits also write HEAD before `git init`'s own config and `objects/`. A store counted as initialized as soon as HEAD existed, so every later launch used it as it was. A Private-Git store that never got `core.bare=false` made `git rev-parse --show-toplevel` fail ("this operation must be run in a work tree"), so every turn of that workspace was recorded session-only ("the working directory is not a Git repository"). A store that never got `core.worktree` (Private-Git) or `omp-undo-redo.commondir` (Git mode), the keys the retention and eviction sweeps read to find its workspace or repository, was skipped by both sweeps and never expired. A store now also needs its last config key and an `objects/` directory; one missing them whose config, HEAD and `config.lock` have sat untouched for 10 s is completed on the next launch: a `config.lock` that old is debris from a killed git (git never removes it) and is deleted, the config calls are redone, and `git init` is repeated only when it never reached `objects/`, because a second one resets `core.bare`. The wait leaves alone a store another launch is still setting up, which finishing concurrently would make collide on `config.lock` and fall back to session-only; such a store also no longer gets the per-launch `core.sharedRepository` write, which collided the same way. A store that already existed and still cannot be completed is used as found, as before, and retried on the next launch; a new store whose setup fails is still session-only. The eviction sweep now also evicts, to the usual `.evicted-<ts>` trash, an unfinished store idle for 24 h that holds no refs, so one whose workspace is never reopened no longer stays forever; an unfinished Git-mode store that already holds snapshots is still kept until its repository is reopened. Whether setup finished is read from the store's config file, so a finished store pays no extra git process per launch.
- **A long session saved history that `load()` then refused, silently losing it on resume.** `load()` rejects history files over 4 MiB but `save()` had no cap, so once the checkpoint list outgrew it every save succeeded and the next resume came back session-only. `save()` now stays under the cap: it drops the checkpoints older than the current one first, then the newest redo entries, and never the checkpoint at `currentIndex`. Dropped checkpoints' refs stay until the session expires. A file already over the cap still fails to load (the resume warning is unchanged) until the next save replaces it. History schema is now 3: git checkpoints no longer store a full `repository` object (four absolute paths per row) that `load()` overwrote anyway; schema 1 and 2 files still load and are rewritten as 3. Older versions of the extension cannot read schema 3 files.
- **A history JSON that could not be parsed never expired.** The retention sweep skipped any `<hash>.json` that failed to read or parse, was not an object, or had an unparseable `lastAccessedAt`, so its snapshot refs (and their contents, including `.env` files) stayed forever. Such files now age by file mtime, as a missing `lastAccessedAt` already did. A file that cannot be stat'ed is still kept.
- **History refs with no `<hash>.json` were never expired.** The retention sweep discovered sessions only through their history JSON, so refs left by a crash, a failed save, or a `save()` with zero checkpoints stayed forever, keeping their snapshot contents (including `.env` files) alive. The sweep now lists `refs/omp-undo-redo/history/` once and groups it by session; a session with no JSON has its refs deleted when every ref's snapshot commit is older than the retention window, it is not active, and its heartbeat is stale. A newer ref, an undated ref, a malformed listing line, or an unusable listing keeps them. The single listing replaces the sweep's per-session `for-each-ref` calls (`load()` still lists one session's refs).
- **`git gc --prune=now` could delete another process's in-flight objects in a Private-Git store.** The store is keyed only by `sha256(cwd)`, so two OMP processes in the same folder share it, and the in-process `pendingCaptures` check cannot see the other process or any finalize/restore. The capture-threshold and shutdown gcs now prune with `--prune=1.hour.ago` like the retention sweep; the removed `capturePrune` special case was the only `now` path. Unreferenced objects are reclaimed up to an hour later.
- **Retention sweep could delete a history that was just saved.** When a session's expiration tombstone existed, the sweep removed `<hash>.json` without checking the active set or the cross-process heartbeat, and `save()` wrote the JSON before clearing the tombstone. A session resumed after expiry could lose its first new turns to a sweep landing between the write and the clear, leaving neither JSON nor tombstone. `save()` now beats the heartbeat, clears the tombstone, and writes the JSON last; the sweep skips a tombstoned history whose session is active or has a fresh heartbeat, and re-checks the tombstone immediately before the `rm`. The residual window is a single syscall wide; the normal expiry path's final `rm` is not re-checked after `update-ref` and is unchanged.
- **A turn whose finalize outlived a `/new` or `/resume` was recorded in the wrong session.** A capture that overran its deadline deferred `finalizeTurn`, which re-read the session id from the live session manager. After a session switch it released or wrote session A's checkpoint into session B's history and pointed `navigations[A]` at B's navigation. The id captured when the turn ended is now passed through and the navigation is looked up by that id; if it is gone and the live session is a different one, the checkpoint is released instead of recorded.
- **Git-mode snapshots were exported by all-refs operations.** Snapshot refs lived under `refs/omp-undo-redo/` in the user's repository, so `git push --mirror`, `git clone --mirror` and `git bundle create --all` shipped every snapshot — including untracked, non-ignored files such as `.env.local` — and `git log --all` listed them. Git-mode snapshots now live in a bare snapshot store, `<storeRoot>/repos/<sha256(commonDir)>.git`: snapshot commands still run against the user's repository (HEAD, config, ignore rules), but objects are written to the store through `GIT_OBJECT_DIRECTORY`, the user's objects are borrowed through `GIT_ALTERNATE_OBJECT_DIRECTORIES`, and refs, history files and owner leases are written only to the store. Each capture copies into the store the snapshot objects the user's `HEAD` does not reach, so the user's own `reflog expire --expire=now` + `gc --prune=now` still cannot break a checkpoint, as the in-repository refs used to guarantee; content `HEAD` reached at capture stays shared, so capture never copies the repository. A capture whose runner is not bound to a store fails closed (session-only) instead of falling back to the repository. On the first session start in a repository, snapshots left by earlier versions are moved: objects only they reach are packed into the store, their refs are recreated there and deleted from the repository, and `.git/omp-undo-redo/` moves with them, so resumable history survives the upgrade. Git stores get the private repositories' retention sweep, capture-threshold `git gc` (with `--prune=1.hour.ago`, since processes in the same repository share the store) and eviction once the repository is gone; the repository's `.git` no longer grows from snapshots, and store refs are no longer bound by the repository path's Windows MAX_PATH budget.
- **Private-Git snapshots (`.env`, keys) outlived the retention window.** Expiry ran only for the repository of a session being opened, and deleting its refs did not delete the objects: `git gc` ran only after 20 captures or at shutdown when captures were due. A workspace that still existed but was never reopened kept its snapshots in `<storeRoot>/repos/<hash>.git` forever, and a reopened workspace with no new capture kept its expired objects. The first session start of each process now sweeps every private repository with the same liveness guards (local active set, cross-process heartbeats), and any private repository that lost refs gets a background `git gc --prune=1.hour.ago`; the hour spares objects a concurrent capture has written but not yet referenced. Cruft packs left inside that window are reclaimed by the next sweep.
- **A failed restore could leave files deleted.** `git apply` without an index deletes every path it modifies before writing any of them, so a write failure (file locked by an editor or antivirus, full disk, the 10-minute timeout kill) left those paths missing and returned `failed` with no rollback. A failed apply now rolls back through a scratch index seeded from the source snapshot: paths apply removed are checked out again, paths it already wrote (content equal to the target blob) are reverted, and files it created are removed. A path holding any other content, such as an edit outside the patch hunks, is left untouched.
- **Two overlapping turns could share one alternate index file.** The persistent index lease stayed published for reuse while the previous turn's after-snapshot was still running, and a turn starting meanwhile only waited on in-flight captures, not finalizations. Both runs then drove `add -A`, `reset --pathspec-from-file` and `write-tree` against the same `GIT_INDEX_FILE`, so the next turn's before-snapshot could miss new files or resurrect deleted ones, and undo would restore a wrong baseline and still report success. A lease is now checked out for the whole before→after span and returned to the idle pool only when the after-snapshot succeeds; a turn that starts while it is checked out seeds its own index (one cold `add -A`). Leases checked out at shutdown are released with the idle ones.

## [1.6.4] - 2026-09-28

### Fixed

- **A slow before-snapshot could absorb the turn's own edits and undo reported success.** `before_agent_start` stops waiting for the before-snapshot after 3 s so the prompt is not held, but the capture kept reading the worktree while the agent's first tools ran. A cold capture (large Git repository, first Private-Git capture of a process) could therefore snapshot the agent's edits as the pre-turn baseline, and `/undo` "restored" them with "file snapshot restored" — uncommitted content the turn overwrote was lost. Every tool call now waits (up to 25 s, under the host's 30 s `tool_call` cap) for the turn's before-snapshot; if it is still running when a tool is released, the snapshot is discarded and the turn is recorded session-only, so undo reports that files were not restored instead of restoring a wrong baseline.
- **Undo deleted pre-existing ignored files that the turn un-ignored.** Snapshots omit ignored paths, so when a turn removed an ignore rule (e.g. rewrote `.gitignore` without `.env`), the untouched `.env` appeared only in the after-snapshot and `/undo` deleted it as a file the turn had created; once the redo tail was discarded the content was unrecoverable. Restores now evaluate each tree's own ignore rules (`check-ignore --no-index` against that tree's `.gitignore` files) and leave alone any path absent from a snapshot because that snapshot ignored it: no deletion on undo, no "already exists" collision on redo. Restores that change no `.gitignore` pay one extra `diff-tree`.
- **Git timeouts did nothing on Windows.** `git` on `PATH` is the Git for Windows launcher (`Git\cmd\git.exe`), which runs the real `mingw64\bin\git.exe` with inherited pipes; `kill()` ended only the launcher, the pipes stayed open, and `close` never fired. The 120 s / 10 min deadlines therefore never settled a wedged git: `/undo` and `/redo` answered "still being captured" forever and an orphaned `git apply` could keep writing to the worktree. Timeouts now kill the whole tree on Windows (`taskkill /T /F`, issued while the launcher is still alive so the tree is walkable), and on every platform the runner destroys the child's stdio once it has exited after the force-kill, so a surviving descendant (hook, alias shell) can no longer hold the result open.
- **Eviction deleted live history for workspaces whose path contains `#` or `;`.** Git writes such `core.worktree` values quoted with doubled backslashes (`worktree = "C:\\…\\C# Projects"`), and the eviction sweep read the raw config line, so the workspace `stat` always failed with ENOENT. Once idle 24 h, the private repo of a live workspace (`C# Projects`, `F# app`, `Music #2`) was renamed to `.evicted-<ts>` by any OMP boot or shutdown, resume fell back to session-only, and the bytes were purged 7 days later. The sweep now reads the value through `git config --file <gitDir>/config --get core.worktree` and skips the repo when that fails.
- **`/undo` issued mid-stream could undo the previous turn instead of the current one.** The host runs commands during streaming, and the handler read the capture/finalize guards before waiting for idle, when the current turn's finalize was not registered yet. Once the host's per-handler cap let idle resolve with the finalize still running, undo navigated a history missing that turn: it undid the earlier turn, the late `recordTurnEnd` then dropped that undo's redo, and session and worktree drifted apart. The guards are now read after the idle wait.
- **Undo to a user or custom message hung for 30 s and destroyed its own redo.** Hosts never leave the leaf on a user message or a (non-skill) `custom_message`: they land on its parent. The own-navigation check compared the `session_tree` event against the requested target, so the undo's own event looked foreign, queued a redo invalidation behind the running undo, and deadlocked until the host's per-handler cap; the invalidation then spliced off the just-undone checkpoint and released its refs. Every resumed session without usable history hit this (reconstructed checkpoints target the prompt), as did any live turn started on a `custom_message` (e.g. `pi.sendMessage` while idle). The check now also accepts the target's parent for those entry types.
- **Git-mode file undo failed on Windows once the repository path exceeded about 79 characters.** v2 checkpoint refs (`v2/<uuid>/<sha256>/<uuid>/before`) produced a 177-character `.git\refs\…\before.lock` path, so `update-ref` hit MAX_PATH, the turn was recorded without a file checkpoint, and the user only found out at `/undo`. Paths such as `C:\Users\first.last\OneDrive - Company\Documents\Projects\…` were affected. v2 refs now omit the session hash and use 16-hex checkpoint ids (`v2/<ownerId>/<id>/before`), and history refs use the same ids. The limits are now about 164 characters for capture and about 131 for resumable history (measured with Git for Windows 2.52). `core.longpaths` is intentionally not forced: a ref written past MAX_PATH is invisible to the user's own Git, whose `gc` would prune the snapshot and then make `for-each-ref` fail on the dangling ref. No migration is needed. Old-layout v2 refs are still reaped, and stored histories keep their existing refs.
- **Undo claimed "file snapshot restored" for changes inside submodules and nested repositories.** `git add -A` records a submodule or committed nested repository as a gitlink (its HEAD commit only), and `git apply` without an index skips gitlink hunks, so a turn's uncommitted edits — or commits — inside `mod/` or `app/` were never restored while the message reported success. Restores now read the gitlinks of both snapshots and report them: "…file snapshot restored, but files inside nested Git repositories are outside the snapshot and were not restored: mod." (warning level). A nested repository with no commit (`git init` in a subfolder, common when Private-Git snapshots `~/projects`) made every `git add -A` fail, silently disabling file capture for the whole workspace; it is now left out of the snapshot, named in the snapshot commit message, and reported the same way. Any other `add` error still fails the snapshot.

## [1.6.3] - 2026-09-22

### Fixed

- **One session-only turn no longer destroys the whole session's file history.** `recordTurnEnd` rewrote _every_ earlier Git checkpoint to `file_history_gap` and released its refs, irreversibly — on a trigger as cheap as a turn starting while the previous turn's capture was still in flight, a transient git failure, a timeout, or an invalid HEAD. A session-only turn no longer converts anything. The one genuinely unrestorable case is now detected where it happens instead of guessed at: when a turn's finalize is deferred past the next turn's start, its after-snapshot also contains that turn's edits (restoring from it would revert two turns while moving one session boundary), so that turn — and only that turn — is recorded as `file_history_gap` and its refs released together. Checkpoints on either side of a gap stay restorable: `applyCheckpoint` patches instead of checking out, so an un-snapshotted turn's edits survive when they are disjoint and produce a `conflict` instead of being clobbered when they are not.

### Performance

- **Unborn HEAD re-hashed the whole workspace twice per turn.** The index lease was retained only when `HEAD^{tree}` resolved, and a Private-Git repository never commits to `HEAD`, so every non-Git workspace (and every Git repository before its first commit) took the cold path forever: a fresh empty index plus a full `git add -A` for both the before- and after-snapshot, with no stat cache. Unborn HEAD now normalizes against the seeding snapshot's own tree, keeps the lease until `HEAD` is born, and prunes newly ignored index entries (`ls-files --cached --ignored` + `update-index --force-remove`) so reused-index trees still match a fresh `read-tree --empty` + `add -A`. Measured on a 4,000-file workspace: ~2.9 s per snapshot before, ~0.6 s after.

## [1.6.2] - 2026-09-08

### Fixed

- **`git gc --prune=now` ran against the user's own repository.** `isPrivateRepository()` scanned the same map `resolveBackend()` populates with the user's repository, so every Git-mode checkpoint counted as private and 20 before-captures triggered `gc --prune=now` with `GIT_DIR` pointing at the workspace's `.git` — pruning unreachable objects with no grace period (a concurrent rebase, another agent, or `fsck --lost-found` recovery could lose objects) and repacking a repository the extension does not own. Ownership is now stamped at construction (`GitRepository.private`, set only by `ensurePrivateGitRepository`) and required by both the capture-threshold trigger and the shutdown sweep.
- **User diff configuration silently killed all file restoration.** The restore patch was generated with the user's presentation config in effect, so `diff.noprefix` (widely recommended in dotfile guides), `diff.external`, `color.diff=always`, `diff.submodule=log`, `diff.context=0`, `diff.relative` or `apply.whitespace=error` each made `git apply` reject the patch — reported as "Worktree changed; nothing was undone" on every `/undo`, forever, on that machine. The diff now pins `--no-color --no-ext-diff --no-textconv --submodule=short -U3 --src-prefix=a/ --dst-prefix=b/` and both applies pass `--whitespace=nowarn`.
- **A failed patch is no longer blamed on the worktree.** When `apply --check` fails, the worktree is compared against the source snapshot through an index the probe seeds itself (the repository's own index is never written in Private-Git mode, and a user's staged changes are not worktree drift), including untracked collisions. A clean worktree now reports a restore failure instead of a phantom conflict.
- **A single hung git child no longer disables capture and `/undo`//`redo` permanently.** `runGit` armed its deadline only when a caller passed `timeoutMs`, and no capture or apply invocation did: a child that never exited (stalled network mount, AV handle, contended `.git` lock) left the capture unsettled for the process lifetime, so `/undo` answered "still being captured" forever and every later turn skipped its capture. Every invocation now has a 120 s default ceiling, with 10 min for restores and 15 min for private-repo `gc`; a timeout degrades the turn to session-only and the next turn retries.
- **A restore killed by its deadline is never reported as applied.** A killed `git diff` exits 1, which is also `--exit-code`'s "there were differences", so the truncated patch `--output` had already written was applied and reported as a complete restore.
- **Turns skipped by the in-flight-capture guard were recorded nowhere.** A turn starting while the previous turn's capture was still in flight produced no checkpoint at all: its boundary vanished, one `/undo` reverted two turns of file changes while moving one session boundary, and `/redo` could restore one turn's files at another turn's session leaf. The guard now records a session-only boundary (which also raises the existing file-history-gap barrier), `agent_end` prefers the current turn's boundary over an alien in-flight capture, and a turn's finalize waits for the previous turn's so recorded order matches turn order.
- **Restores from a subdirectory only restored that subdirectory.** `git apply` ignores patched paths outside its working directory, so a session started in a subdirectory of a repository restored just that subtree and still reported success. Git-mode runners are now rooted at the worktree.
- **Git runners and index leases isolated between linked worktrees.** Linked worktrees share `repository.commonDir`, so caching git-mode runners by commonDir caused a session in a linked worktree to execute git operations inside the main worktree's directory. Cached runners and persistent alternate index leases are now keyed by `repository.worktree`.

### Changed

- **Restored Node.js >=20 compatibility.** Reverted the v1.6.1 Node 22 engine requirement (`engines.node: ">=20"`), polyfilling `Promise.withResolvers` transparently on Node 20 runtimes so users on Node 20 LTS are not locked out while Node 22+ continues to use the native V8 implementation.

### Security

- **Private snapshot store is created owner-only.** `<storeRoot>` and `<storeRoot>/repos` were created with the process umask (0755 by default) and git then wrote loose objects world-readable. Because a non-Git workspace usually has no `.gitignore`, those snapshots contain everything outside the built-in ignore list — `.env`, private keys, credential files — so on a shared POSIX host any local user could read the whole workspace out of `<storeRoot>/repos/<sha256>.git/objects/`. Both directories are now created with mode `0700` (plus an explicit `chmod` for a store root created earlier), and fresh private repositories set `core.sharedRepository=0600`. README and SECURITY.md now document what these snapshots contain; a store created by an earlier version keeps its original object modes, so remove `<storeRoot>/repos` once on a shared host.

## [1.6.1] - 2026-09-07

### Fixed

- **Repository resolution from a subdirectory.** `git rev-parse --git-dir`/`--git-common-dir` print paths relative to the process working directory, but both were resolved against the worktree root. Starting the agent in a subdirectory of a Git repository therefore produced a `commonDir` outside the repository, sending `GIT_DIR`, session history (`<commonDir>/omp-undo-redo/history`), and checkpoint ownership records to a path that does not exist. Now resolved against the working directory, so all cwd positions agree.
- **History checkpoint validation accepted prototype keys.** `isSessionCheckpoint` tested the reason with `in` against an object map, so a persisted checkpoint carrying `reason: "toString"` (or `constructor`, `__proto__`, `hasOwnProperty`) passed validation and reached the UI as a generic fallback message. The reason set is now a single `as const` array checked with `includes`, and the `FileCheckpointUnavailableReason` union is derived from it.

### Changed

- Repository resolution issues one `git rev-parse` instead of three, removing two process spawns per turn.
- **Breaking: requires Node.js >= 22** (`package.json` `engines`, CI). Node 20 reached end of life in April 2026; the extension now uses the built-in `Promise.withResolvers()` instead of a hand-rolled equivalent.
- Internal cleanup with no behavior change: `/undo` and `/redo` share one `runNavigation`/`makeHandler` path (`src/commands/navigate.ts`), repeated atomic JSON writes and ref helpers moved into `src/core/atomic-write.ts` and `src/core/git-refs.ts`, test scaffolding shared through `test/helpers.ts`, and dead exports, unreachable branches, `.npmignore`, and `scripts/check-dist.mjs` removed (~1,200 net lines deleted).

## [1.6.0] - 2026-09-05

### Changed

- **Breaking: Consolidated to Git-only snapshot engine.** The custom JavaScript BlobStore and all associated code have been retired. All workspaces now run on native Git snapshotting:
  - Git workspaces snapshot into custom refs (`refs/omp-undo-redo/history/`) inside the existing repository without touching `HEAD` or index.
  - Non-Git workspaces unconditionally use Private-Git under `<storeRoot>/repos/<sha256(cwd)>.git` with the workspace as worktree and built-in ignore seeding.
- **Breaking: Removed `OMP_UNDO_REDO_PRIVATE_GIT`.** Non-Git workspaces always use Private-Git. Setting `OMP_UNDO_REDO_PRIVATE_GIT=0` no longer activates a fallback blob store.
- **Breaking: Removed `OMP_UNDO_REDO_MAX_STORE_MB`.** Retention-by-age (`OMP_UNDO_REDO_RETENTION_DAYS`, default 2 days) is now the sole storage limit; there is no byte cap.
- **Breaking: Missing Git binary degrades to session-only navigation.** Environments without a `git` executable no longer restore files; `/undo` and `/redo` navigate the agent session context only, with one clear warning notification per session.
- **Breaking: Removed 16 MiB per-file capture limit.** Git captures all non-ignored files without a size cap.
- **Renamed `OMP_UNDO_REDO_BLOB_DIR` to `OMP_UNDO_REDO_STORE_DIR`.** The old environment variable name remains supported indefinitely as a fallback alias.
- **Downgrade-safe:** History files written by 1.6.0 use the unchanged v2 schema and reason set; rolling back to 1.5.x reads them normally.
- **Legacy disk storage auto-reclaimed:** Existing `<storeRoot>/blobs`, `trees`, `refs`, `locks`, `leases`, `journals`, and `history` directories from pre-1.6 blob-mode sessions are automatically removed once the store has been untouched for 7 days, reclaiming up to ~1 GiB of legacy disk space with no manual action required.

### Removed

- Deleted custom JavaScript BlobStore implementation (`src/core/blob-store/`, `src/core/blob-checkpoints.ts`, `src/core/blob-history-store.ts`, benchmark scripts, and associated tests — ~5,270 LOC removed).

## [1.5.6] - 2026-08-27

### Fixed

- **Blob-store lock & lease protocol hardening (scope canonicalization & liveness heartbeats):**
  - **Textual path aliasing / split-brain prevention:** `BlobStore`, `StoreLocks`, `StoreLiveness`, `captureSnapshot`, `applySnapshot`, and `invalidateCache` now canonicalize store and workspace roots via native `realpath` (`canonicalPath`/`canonicalPathSync` in `src/core/blob-store/fs.ts`), ensuring symlinks, Windows 8.3 short paths, casing differences, and relative path spellings hash to identical lock keys (`src/core/blob-store/locks.ts`, `src/core/blob-store/index.ts`, `src/core/blob-store/liveness.ts`).
  - **Lock heartbeats & PID recycling protection:** lock holders write `{ pid, hostname, ownerId, startedAt }` atomically via temp file and maintain a 5s heartbeat (`utimes`). Same-host contenders reap dead processes instantly on `ESRCH` and reclaim hung/recycled PIDs when heartbeat is stale (>30s) (`src/core/blob-store/locks.ts`).
  - **Cross-host split-brain protection:** foreign-host locks are never reaped on short heartbeats, preventing clock-skew lock theft on shared network mounts (NFS/SMB); an abandoned foreign lock is reclaimed only after a conservative 24h fallback window (`src/core/blob-store/locks.ts`).
  - **Release-after-reap fencing:** lock release closure verifies `owner.json` still matches `ownerId` before deleting, ensuring a stalled holder that wakes up after being reaped never deletes a new holder's active lock (`src/core/blob-store/locks.ts`).
  - **Lease liveness refresh:** repeat `publishLease()` calls refresh lease `mtime` via `utimes`, keeping long-running active sessions fresh (`src/core/blob-store/liveness.ts`).

## [1.5.5] - 2026-08-26

### Changed

- **Private-repo eviction is now multi-gated and recoverable.** A vanished workspace alone no longer destroys a snapshot repository at the next sweep: eviction requires the workspace `stat` to fail with ENOENT/ENOTDIR twice (200ms apart, so a single mount/AV/lock hiccup cannot trigger it), the repo to be idle ≥24h, no captures/finalizations/operations in flight, and no live `git gc` (`gc.pid`). Qualifying repos are renamed to `<hash>.git.evicted-<ts>` and their bytes removed only after 7 days, so a false positive stays recoverable — previously a single failed `stat` of any error kind irreversibly `rm -rf`'d the repo and every snapshot in it.
- Shutdown private-GCs now sequence strictly after the eviction sweep finishes instead of racing it (a concurrent `gc --prune=now` both held handles through the rename and bumped mtimes past the idle gate); they skip repos eviction renamed away. Housekeeping remains off the shutdown latency path.

## [1.5.4] - 2026-08-25

### Fixed

- **Cross-process expiration no longer destroys live session history (per-process active-set blindness):** retention sweeps filtered candidates only against the local process's in-memory active set, so a sweeper in one process could delete git refs / blob refs and tombstone a session that another process (same repo `commonDir` or shared blob store) was actively resuming. A resume racing the ref deletion then re-persisted the degraded state, durably converting file-restorable checkpoints into navigation-only rows. Fixes: history stores never persist runtime-downgraded checkpoints — `load()` rewrites the stored document with the original coordinates and a fresh timestamp only (`src/core/history-store.ts`, `src/core/blob-history-store.ts`); every load/save touches a cross-process heartbeat marker (`<historyDir>/.active.<sessionHash>`, TTL 24h) that both sweepers honor alongside the local active set, with a pre-deletion re-check (`src/core/history-liveness.ts`, `src/core/history-store.ts`, `src/core/blob-store/gc.ts`, `src/core/prune-tombstones.ts`); a 10-minute unref'd interval re-asserts liveness for all locally tracked sessions so idle-but-open sessions stay protected (`src/index.ts`).
- Tombstones are now authoritative until superseded: a live owner's `save()` clears its own expiration marker so post-expiry sessions recover undo capability on their next turn instead of reporting "expired" until tombstone pruning; sweeps remove any history JSON that coexists with a standing tombstone (residue from a concurrent load rewriting the file mid-sweep), keeping the marker authoritative without resurrecting data.
- Storage-cap eviction keeps its hard oldest-first guarantee: liveness is enforced purely by heartbeat markers (a live session in any process is never evicted), while unprotected stale sessions remain ordinary candidates — the cap is met as before instead of being soft-floored.

## [1.5.3] - 2026-08-25

### Fixed

- Serialize turn finalization against undo/redo: `recordTurnEnd` and redo invalidation now run through the same navigation chain as `undo()`/`redo()` (`src/core/session-navigation.ts`), so a turn recorded while an undo was still applying its patch can no longer leave a persisted cursor claiming the wrong checkpoint state — previously the durable history survived with a cursor that pointed past the actual worktree position, and the next redo applied the wrong delta.
- `/undo` and `/redo` now bounded-wait (same `captureDeadlineMs` budget as the capture guard) for an in-flight turn finalization before navigating (`src/index.ts`), including the deferred finalize of an overrunning capture; previously a fast command could run against an empty or stale history while the last turn's checkpoint was still being written, reporting "Nothing to undo" for the turn the user meant to revert.
- Recognize undo/redo's own session-tree navigation synchronously before queuing invalidation (`src/core/session-navigation.ts`), so the host's awaited `session_tree` dispatch cannot queue an invalidation behind the very navigation that triggered it.

### Changed

- History stores now distinguish a never-recorded session (`missing`) from existing-but-unloadable metadata (`unusable`) in `HistoryLoadResult` (`src/core/types.ts`, `src/core/history-store.ts`, `src/core/blob-history-store.ts`). Resuming over corrupt durable history warns once and continues session-only; fresh sessions stay silent.
- Diagnostics: a failed turn finalization is logged to stderr instead of vanishing silently.

### Documentation

- README/SECURITY accuracy pass: rollback scope limited to workspace files (not shell/network/editor effects), per-mode symlink behavior (blob-store fallback skips them, Private-Git restores them), blob-mode walker does not parse workspace `.gitignore`, plaintext retention of sensitive files and the 4 MiB per-path ceiling, journal-quarantine semantics (`journals/failed/`, partial restore possible, mutation refused), host-ID sharing consequence for live remote sessions, 64 KiB runtime state-write cap, concurrency claims scoped to a single agent process. `SECURITY.md` added to the published tarball (`package.json`).

## [1.5.2] - 2026-08-21

### Fixed

- **Store leak remediation (6 channels):** background `reapStaleRuntimes` for `~/.omp/omp-undo-redo/runtime/<pid>/` with `hostname` guard + `kill(pid,0)` + 24h `mtime` fallback against PID recycling (`src/core/runtime-action-state-store.ts:14,122,139-235`), `reapStaleLeases` for `~/.omp/omp-undo-redo/leases/*.json` after active-ref sweep (`src/core/blob-store/liveness.ts:118-183`, `src/core/blob-store/gc.ts:43-49`, `src/core/blob-store/index.ts:118`), `*.expired.json` tombstone pruning at `retentionDays*2` (shared `src/core/prune-tombstones.ts:6`, `src/core/history-store.ts:4,318`, `src/core/blob-store/gc.ts:164`), `host-id.*.tmp` cleanup on `resolvePersistentHostId` (`src/core/checkpoint-owners.ts:183`), one-time `~/.omp/omp-undo-redo/git-indexes/` removal and `%TEMP%/omp-undo-redo-index|patch-*` orphan sweep >24h preserving warm `SnapshotIndexLease` (`src/index.ts:373-397`). All sweeps deferred `setTimeout(2000).unref()` — zero handler latency.
- **Short-form (8.3) path canonicalization:** `canonicalCwdSync`/`canonicalCwd` now walk to nearest existing ancestor when `realpath` fails (`src/core/private-repo.ts:34-74`), and `ensureExclude` canonicalizes both `storeRoot` and `worktree` before `relative()` (`src/core/private-repo.ts:117-120`) — fixes mismatched `privateRepositoryPath` and `isPrivateRepository` string compares on Windows 8.3 store roots.
- **Flaky-test hardening:** `bounded-capture` now waits for `write-tree`/`commit-tree` chain and retries `undo` on `still being captured` (`test/bounded-capture.test.ts:360`), `private-gc` window 50→80 polls + 60s timeout (`test/private-gc.test.ts:149`), `private-repo` asserts against canonical store root (`test/private-repo.test.ts:99`), `runtime-action-state-store` expects `hostname` in `RuntimeMarker` (`test/runtime-action-state-store.test.ts:76`), and `blob-store` stale-ref test preserves lease-file lifetime ordering.

### Changed

- `RuntimeMarker` now includes `hostname` (`src/core/runtime-action-state-store.ts:14-21`) — cross-host `/runtime` shares no longer risk remote PID reaping.
- Deduplicate `*.expired.json` pruning into `src/core/prune-tombstones.ts` and single-parse lease JSON in `reapStaleLeases` (`src/core/blob-store/liveness.ts:143-166`).

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

- **`info/exclude` growth:** `ensureExclude` (`src/core/private-repo.ts`) re-appended the full entry set on every launch (12 defaults × N launches). It now appends only missing entries, skips the write when nothing changed, dedupes existing bloated files (unless they contain `!` negations), and writes via temp file + rename.

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
- Verify candidate sessions against a live active-session set during expiration so sessions that start concurrently within the same agent process are never expired by their own startup.

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

[1.6.4]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.6.4
[1.6.3]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.6.3
[1.6.2]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.6.2
[1.6.1]: https://github.com/Baylar55/omp-undo-redo/releases/tag/v1.6.1
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
