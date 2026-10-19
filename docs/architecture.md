# Architecture

The source is split into layers. A file imports only from its own folder and from the layers
below it; `npm run lint` enforces this (`eslint.config.mjs`: the `layer(...)` entries, plus the
type-only rule for `host/`).

## Layers

```
            src/index.ts  (package entry: re-exports only)
                  │
            src/extension.ts  (wires everything together)
                  │
   L5  host/      (OMP/Pi event + command adapters, command texts)
                  │
   L4  session/   (per-session turn state machine, undo/redo cursor, housekeeping orchestration)
                  │
        ┌─────────┼──────────┐
   L3  snapshot/  history/   runtime/      (siblings: they never import each other)
        └─────────┼──────────┘
                  │
   L2  store/     (snapshot stores, refs, owners, maintenance)
                  │
   L1  infra/     (git process, paths, fs, async, logging, parsers)

   L0  src/types.ts, src/host-contract.ts   (types and constants only; importable by every layer)
```

## Allowed imports

A file may import only from its own folder, from the folders listed for it, and from Node / the
host package types.

| Importing folder / file                | May import from                                                            |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `src/types.ts`, `src/host-contract.ts` | `@oh-my-pi/pi-coding-agent` (type-only), each other                        |
| `src/infra/`                           | L0                                                                         |
| `src/store/` (incl. `maintenance/`)    | `infra/`, L0                                                               |
| `src/snapshot/`                        | `store/`, `infra/`, L0                                                     |
| `src/history/`                         | `store/`, `infra/`, L0                                                     |
| `src/runtime/`                         | `infra/`, L0                                                               |
| `src/session/`                         | `snapshot/`, `history/`, `runtime/`, `store/`, `infra/`, L0                |
| `src/host/`                            | `session/registry.ts` (+ `services`, `navigation` types), below `session/` |
| `src/extension.ts`                     | everything except `src/index.ts`                                           |
| `src/index.ts`                         | everything                                                                 |

## Files

```
src/
├── index.ts                     package entry: default + type + deprecated re-exports
├── extension.ts                 ompUndoRedo(): builds services, registry, registers events/commands
├── types.ts                     shared domain types
├── host-contract.ts             host assumptions: deadlines, AnyContext, landing rule, session_exit
│
├── infra/
│   ├── compat.ts                Promise.withResolvers polyfill (Node 20)
│   ├── async.ts                 timedOutAfter, track
│   ├── fs.ts                    writeFileAtomic, writeJsonAtomic, writeExclusive, removeDirWithRetry
│   ├── paths.ts                 canonicalCwd, store/runtime root resolution, checkpointNamespace
│   ├── debug-log.ts             debugLog (OMP_UNDO_REDO_DEBUG)
│   ├── git-parse.ts             parseRefLines
│   └── git-runner.ts            createGitRunner (spawn, timeouts, env sanitizing, Windows), invoke, run
│
├── store/
│   ├── refs.ts                  ref namespace, gc-pending mark, batched/loose ref deletion
│   ├── discovery.ts             resolveRepository (rev-parse → DiscoveredRepository)
│   ├── setup.ts                 store creation shared by both kinds (concurrent setup, retries)
│   ├── git-store.ts             Git-mode store: ensureGitSnapshotStore, runner env (alternates)
│   ├── private-store.ts         Private-Git store: config, excludes, refused workspaces
│   ├── pinning.ts               copy/keep borrowed objects safe from gc
│   ├── host-identity.ts         persistent host id, Linux runtime scope
│   ├── owners.ts                CheckpointOwnerRegistry: leases, liveness, stale-owner cleanup
│   ├── backend.ts               resolveBackend: git / private / session-only
│   └── maintenance/
│       ├── gc.ts                runPrivateGc, runCaptureGc, storeNeedsGc, GcQueue
│       ├── eviction.ts          evictStalePrivateRepos, storeSource
│       ├── temp-sweep.ts        sweepOrphanTempIndexes
│       └── legacy.ts            legacy snapshot migration (refs an earlier version left in .git)
│
├── snapshot/
│   ├── markers.ts               commit-message markers, autocrlf helpers, OutsideSnapshot
│   ├── index-leases.ts          alternate-index lease pool (IndexLeasePool, one per extension copy)
│   ├── tree.ts                  build one snapshot commit (fresh or from a lease)
│   ├── checkpoint-refs.ts       checkpoint ref names, promotion, release
│   ├── capture.ts               prepareBeforeTurn, finishAfterTurn
│   ├── restore-scope.ts         which paths a restore may touch
│   └── restore.ts               applyCheckpoint (patch, check, apply, rollback)
│
├── history/
│   ├── layout.ts                history dir / file / intent / tombstone paths
│   ├── codec.ts                 history JSON schema: parse, validate, bound
│   ├── reconstruct.ts           rebuild session-only history from the session branch
│   ├── tombstones.ts            read + prune *.expired.json
│   ├── liveness.ts              .active.<hash> heartbeats
│   ├── retention.ts             expire dormant sessions, readRetentionDays
│   └── store.ts                 SessionHistoryStore (load/save/intents)
│
├── runtime/
│   ├── reaper.ts                runtime marker type + stale runtime directory sweep
│   └── action-state.ts          RuntimeActionStateStore
│
├── session/
│   ├── notices.ts               session-level notice texts
│   ├── navigation.ts            SessionNavigation (cursor, undo/redo, intents)
│   ├── recovery.ts              settle an undo/redo cut short by a crash
│   ├── services.ts              ExtensionServices: shared deps + process-wide sets/flags
│   ├── controller.ts            SessionState record + navigation initialization
│   ├── turn-start.ts            before_agent_start + tool_call logic, capture tracking
│   ├── turn-end.ts              agent_end logic, deferred finalize
│   ├── housekeeping.ts          boot/shutdown housekeeping, retention sweep orchestration
│   └── registry.ts              SessionRegistry: session and turn events, /undo and /redo guards, switch/release, heartbeat, shutdown
│
└── host/
    ├── messages.ts              command result texts
    ├── commands.ts              /undo and /redo handlers
    └── events.ts                pi.on(...) registrations
```

## Responsibilities

- **`host-contract.ts`**: every assumption about the OMP/Pi host that lower layers rely on. When a
  host release changes behavior, read this file first.
- **`store/`**: a snapshot store is the extension's own bare repository (Git mode borrows the
  user's objects through alternates; Private-Git owns a worktree-less repository per workspace).
  `maintenance/` keeps stores bounded: gc, eviction of stores whose workspace vanished, orphaned
  temp directories, and code that exists only for upgrades from old versions.
- **`snapshot/`**: the two snapshots of a turn and restoring one over the worktree. Commit-message
  markers are the single source of what a snapshot left out.
- **`history/`**: the per-session history file in a store, its schema, expiry and liveness.
- **`runtime/`**: the observational `runtime/<pid>/` state for external clients.
- **`session/`**: one `SessionState` record per session in `ExtensionServices.sessions`. Records
  are never removed, only their fields cleared. `services.ts` holds data only; logic lives in the
  other session modules, which take `services` as their first parameter.
- **`host/`**: the only place that calls `pi.on` and `pi.registerCommand`. Each handler delegates to
  the `SessionRegistry` (`session/registry.ts`); from the rest of `session/`, `host/` imports only
  the `ExtensionServices` and `SessionNavigation` types (`npm run lint` enforces this).

## Snapshot behavior

What users see of this is in the README ("Usage" and "What gets stored and what isn't restored");
this is how it works.

### Snapshot modes

- **Git mode.** Snapshots go to a separate store at `<storeRoot>/repos/<sha256(commonDir)>.git`,
  shared by linked worktrees (see [Git-mode snapshot store](#git-mode-snapshot-store)). `HEAD`,
  branch refs and the real index are never touched.
- **Private-Git mode.** A non-Git workspace gets an isolated repository at
  `<storeRoot>/repos/<sha256(cwd)>.git` with the workspace as its worktree, snapshotted through the
  same alternate-index engine. It is seeded with the built-in ignore list so churn is bounded. The
  store root and `repos/` are created `0700` and the repository sets `core.sharedRepository=0600`.
- **Session-only fallback.** With no Git binary, when store setup fails, or when `git rev-parse`
  fails for any reason but "not a git repository" (timeout, dubious ownership: Private-Git there
  could ignore an enclosing repository's `.gitignore`), only the session moves; the user is
  notified once per session. Store setup and an unresolvable repository are retried at the start
  of every turn (no Git binary and refused workspaces are not), and several processes setting up
  the same new store retry instead of failing. A non-Git home
  directory (or any folder above it), a filesystem root, the OS temp directory and the shared temp
  roots (`/tmp`, `/var/tmp`, `%SystemRoot%\Temp`) are refused outright (`store/private-store.ts`);
  only the folders themselves, not their subfolders. Other users' homes and other shared folders
  are not recognized. A store an earlier version created for one of them is evicted once idle for
  24 hours.

In an unborn repository (no commit yet), the checkpoint index is seeded from the first snapshot's
own tree and the index lease is kept until `HEAD` is born, so later turns reuse the stat cache
instead of re-hashing the workspace.

### Snapshot timing

Every wait has a limit; hosts embedding the extension can change the defaults. All stay under OMP's
30 s limit on extension handlers, so a very large or slow workspace cannot time the extension out.

| What waits                                                                                | Limit              | When the limit is reached                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt start (`before_agent_start`) and turn end (`agent_end`), for an in-flight snapshot | 3 s                | The snapshot keeps running in the background; the turn's undo boundary is recorded when it finishes.                                                     |
| `/undo` and `/redo`, for an in-flight snapshot or any session's unfinished after-snapshot | 3 s                | Nothing changes; the command says to try again shortly instead of acting on a half-recorded state.                                                       |
| Each tool call, for the turn's before-snapshot                                            | 25 s per tool call | The tool runs; the snapshot is discarded and the turn is recorded session-only, so `/undo` moves the conversation back and says files were not restored. |
| Turn end (`agent_end`), for the after-snapshot and history write                          | 25 s               | They finish in the background.                                                                                                                           |

Tools wait because a tool that edits a file before Git has read it would make the snapshot record
the edit as the pre-turn state; recording the turn session-only is safer than restoring a wrong
baseline. A turn whose snapshot only finishes after the next turn has started (in any session of
the process: after `/new` or `/resume` the sessions share the workspace) keeps its conversation
boundary but loses file restoration for that turn alone (its snapshot already contains the next
turn's edits); the turns before and after it stay restorable.

### Session history file

Completed checkpoints and the undo/redo cursor are saved per session in the store, so a resumed
session keeps both `/undo` and `/redo`. If that metadata is missing or unusable, completed turns
are reconstructed from the active session branch as session-only checkpoints, with a warning
(`history/reconstruct.ts`). The file is capped at 4 MiB, roughly 9,000 Git turns: a session that
outgrows it keeps the checkpoint at the cursor and drops the oldest turns first; their snapshots
stay until retention removes the session.

Before restoring files, `/undo` and `/redo` save a restore intent next to the history. On the next
load `session/recovery.ts` checks whether the restore patch still applies from either snapshot:
from the source means nothing changed, from the target moves the cursor, from neither leaves the
cursor and warns with the store and both hashes. Loading never writes the worktree.

### Links in the worktree

Git for Windows treats a junction (`mklink /J`) as a plain directory: `add -A` snapshots the files
it points at, and `git apply` writes and deletes through it without its "beyond a symbolic link"
check firing. Before `git apply --check`, `applyPatch` (`snapshot/restore.ts`) passes every path
the restore touches to `pathsBeyondLinks` (`snapshot/restore-scope.ts`), which `lstat`s each
directory above it inside the worktree, once per directory (Node reports junctions as symlinks).
Any link there makes the result `linked`: nothing is written, and the check-only probe of
`session/recovery.ts` does not count the restore as applicable. The path itself is not checked, so
a tracked symlink is still restored as a link. A runner without `cwd` gets the worktree from
`git rev-parse --show-toplevel`. The scan reads the disk once: a link created between it and
`git apply` is not caught (git's own check still covers real symlinks). Capture is unchanged.

### Subagents

Subagent sessions (the `task` tool, eval `agent()`, `/tan` clones) run in the same process with
their own copy of the extension. They cannot be undone, so that copy captures no snapshots, writes
no history, never delays a subagent's tool calls, and answers `/undo`/`/redo` with a warning. A
subagent's edits in the parent's workspace land in the running parent turn's after-snapshot. This
needs `ctx.agent` (OMP 18.3.2+); older hosts checkpoint subagent sessions like any other.

### Runtime action state

While running, the extension publishes normalized Undo/Redo action state for external clients in a
private process-scoped directory, `~/.omp/omp-undo-redo/runtime/<pid>/` (root overridable with
`OMP_UNDO_REDO_RUNTIME_DIR`). It is shared by every session of the process (for example several
ACP sessions) under one runtime ID and removed when the last of them shuts down. Session filenames
use SHA-256 session namespaces; state holds action availability, selected leaf, navigation
revision and the latest action result. Per-session writes larger than 64 KiB are skipped.
Publication is observational and never adds file restoration to session-only mode. A
`runtime/<pid>/` without a `runtime.json` marker is never replaced or deleted
(`runtime-dir-foreign`). The marker records the writer's hostname and runtime scope (boot and PID
namespace on Linux, as owner leases do). Only a marker from this host and scope is pid-probed: such
a `runtime/<pid>/` is replaced by the process now holding that pid, and reaped once the pid is
gone. One from another scope (a container sharing `~/.omp`, a previous boot) or without a scope
is replaced or reaped only once its marker and directory are both 24 h old; another host's never.

## Storage maintenance

What users see of this is in the README ("What gets stored and what isn't restored" and
"Configuration"); this is how it works.

### Git-mode snapshot store

Snapshot commands run against the user's repository (its `HEAD`, config, `.gitignore`,
`info/exclude` and attributes, with `core.autocrlf` off), but new objects are written to the store
(`GIT_OBJECT_DIRECTORY`), refs under `refs/omp-undo-redo/` live only there, and the user's objects
are borrowed through `GIT_ALTERNATE_OBJECT_DIRECTORIES` instead of copied (`store/git-store.ts`).

The extension's own directories inside the worktree (the store root, its `repos/` and the runtime
root; a home directory that is a Git repository, or `OMP_UNDO_REDO_STORE_DIR`/
`OMP_UNDO_REDO_RUNTIME_DIR` set inside one, puts them there) are left out of every snapshot with
literal `:(exclude)` pathspecs, and index entries for them (a `HEAD` that tracks them) are dropped.
Restores pin every path under them to its state in the source snapshot, so snapshots taken before
this exclusion existed cannot rewrite the store either.

Each capture copies into the store every snapshot object the user's `HEAD` does not reach (content
of a reset or amended commit, a staged-then-dropped file, an old version a file was reverted to),
and before every store gc the extension packs every snapshot object `HEAD` then does not reach into
a kept pack of the store (`objects/pack/*.keep`, rebuilt at each gc so expired snapshots are still
reclaimed; `store/pinning.ts`). Neither the repository's normal `git gc` nor
`git reflog expire --expire=now --all && git gc --prune=now` can therefore break a checkpoint.
Content `HEAD` reached at capture time stays shared until a store gc finds `HEAD` no longer
reaching it, so capture never copies the repository; rewriting that history and pruning it before
then (`git filter-repo` and BFG do both in one run) loses it.

Snapshots that earlier versions kept in the repository (refs under `refs/omp-undo-redo/`, files
under `.git/omp-undo-redo/`) are moved into the store and deleted from the repository on the next
session start (`store/maintenance/legacy.ts`).

### Retention and liveness

"In use" is enforced across processes: every history load/save touches a liveness marker
(`.active.<sessionHash>`, fresh for 24 hours) in the shared history directory, a background
interval re-asserts it for all locally active sessions every 10 minutes, and retention sweeps skip
any session with a fresh marker — including sweeps started by another process sharing the same
repository or store. Expired `*.expired.json` tombstones are pruned after twice the retention
period (default 4 days) so the history directory does not grow without bound.

In Git workspaces, expiration removes the session's history refs under
`refs/omp-undo-redo/history/<sessionHash>/` and its history file inside the repository's snapshot
store. The store gets the same retention sweep and eviction as a private repository. In non-Git
workspaces, Private-Git mode expires the session's refs and history file inside the private
repository.

The first session start of every OMP process also sweeps _every_ store under `<storeRoot>/repos/`,
not only the current workspace's, so a workspace that is never reopened still has its dormant
history expired; any store that lost refs this way then gets a background
`git gc --prune=1.hour.ago`, which deletes the expired snapshot objects while sparing objects a
concurrent capture wrote in the last hour.

### Garbage collection

Every gc here prunes with `--prune=1.hour.ago`: every OMP process working in the same folder, or
in a repository and its linked worktrees, shares the store, so another one may be mid-capture.

- **Private-Git store.** After every 20 captured snapshots (and on shutdown, when captures are
  due) a background `git gc --auto --prune=1.hour.ago` runs: git repacks only past its own limits
  (more than 6700 loose objects, or 50 packs), and then packs just the loose objects unless the
  pack limit was hit, so its cost follows what was written since, not the size of the store.
- **Git-mode store.** Its capture-threshold check runs the full gc only once the store crosses
  git's own `gc --auto` limits (more than 6700 loose objects, or 50 packs without a `.keep`): any
  repack there must first re-pin the store's copies of objects the repository also holds, so it
  cannot hand the decision to `git gc --auto`.

Every full gc (the sweep's, and a Git-mode store's) is preceded by a standalone
`git prune --expire=1.hour.ago`: gc prunes only after it repacks, so a store whose repack never
finishes (killed at its 15-minute ceiling, or with the terminal) still has its expired snapshots
and the stale `tmp_*` files of killed repacks deleted.

`git prune` never deletes packed objects, so every deletion of a store's refs (expiry, redo
invalidation, a discarded capture, stale-owner cleanup) first writes
`<store>/omp-undo-redo/gc-pending`. A gc claims it as `gc-pending.running` (unless a claim already
exists, in which case the mark stays) and deletes the claim only once it finishes. The boot sweep
(even with `OMP_UNDO_REDO_RETENTION_DAYS=0`) gcs every store holding either file, a cruft pack, or
objects without a single ref: a gc the exiting process cut short or never started is retried by
the next launch.

### Eviction

Stale stores whose workspace (Private-Git) or repository (Git mode) has disappeared are evicted
conservatively: the source must read as missing on two checks moments apart, the store must be
idle for at least 24 hours, and no capture, finalization, or `git gc` may be in flight. Eviction
renames the store to `<hash>.git.evicted-<timestamp>` and removes its contents only after 7 days,
so a transient mount, lock, or permission hiccup can never cost undo history.

### Checkpoint refs and owner leases

Pending full-mode checkpoints initially use owner-scoped v2 refs:

```text
refs/omp-undo-redo/v2/<ownerId>/<checkpointId>/before
refs/omp-undo-redo/v2/<ownerId>/<checkpointId>/after
```

After a turn completes, both refs are atomically promoted to the resumable namespace:

```text
refs/omp-undo-redo/history/<sessionHash>/<checkpointId>/before
refs/omp-undo-redo/history/<sessionHash>/<checkpointId>/after
```

`<checkpointId>` is 16 hex characters. Refs are loose files under the snapshot store's `refs/`,
which sets `core.longpaths` for its own refs, so the repository path does not limit them; only the
extension's Git ever reads the store. Older versions used `v2/<ownerId>/<sessionHash>/<uuid>`;
those refs are still recognized and cleaned up.

The extension publishes a lease in the store before it creates a v2 ref and refreshes the lease's
mtime every hour while it runs (`store/owners.ts`). A later runtime automatically removes an
owner's temporary v2 refs when its lease is valid and either:

- has the same persistent host ID, hostname, and runtime scope, and its PID probe returns
  `ESRCH`; or
- differs in host ID, hostname, or runtime scope (a remote owner: another machine, a regenerated
  `host-id` file, or on Linux a reboot) and has gone 7 days without a refresh.

The 7-day rule compares the scanning runtime's clock with the lease mtime the owner wrote, so an
owner suspended, clock-skewed or unable to refresh for 7 days can be reaped while still alive. Only
its v2 refs go: a turn running at the time, or one whose promotion failed. `/undo` and `/redo`
check such a checkpoint's refs before restoring; once a ref is gone or moved, the turn becomes a
session-only hole (`checkpoint_removed`) and navigation moves past it instead of failing on
snapshots a later gc prunes. This applies even while gc has not pruned the snapshots yet: refs
are the durable record, and restoring from objects that survive by chance would let a transient
Git failure decide whether a turn is kept.

On Linux, the runtime scope binds cleanup to both the current kernel boot ID and PID namespace,
preventing a container or WSL process outside that namespace from being mistaken for a dead local
process. If that scope cannot be resolved, automatic cleanup is disabled while v2 checkpointing and
graceful cleanup continue. Current, live, recently refreshed remote, malformed, future-version,
unreadable, and otherwise uncertain owners are preserved. Existing ownerless refs and completed
history refs are never stale-runtime cleanup candidates. Automatic maintenance runs once per
runtime and repository, in the background, with bounded Git operations; maintenance failure does
not block checkpoint creation or commands.
