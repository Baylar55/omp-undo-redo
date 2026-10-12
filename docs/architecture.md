# Architecture

The source is split into layers. A file imports only from its own folder and from the layers
below it; `npm run lint` enforces this (`eslint.config.mjs`, the `layer(...)` entries).

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

| Importing folder / file                | May import from                                             |
| -------------------------------------- | ----------------------------------------------------------- |
| `src/types.ts`, `src/host-contract.ts` | `@oh-my-pi/pi-coding-agent` (type-only), each other         |
| `src/infra/`                           | L0                                                          |
| `src/store/` (incl. `maintenance/`)    | `infra/`, L0                                                |
| `src/snapshot/`                        | `store/`, `infra/`, L0                                      |
| `src/history/`                         | `store/`, `infra/`, L0                                      |
| `src/runtime/`                         | `infra/`, L0                                                |
| `src/session/`                         | `snapshot/`, `history/`, `runtime/`, `store/`, `infra/`, L0 |
| `src/host/`                            | `session/` and everything below                             |
| `src/extension.ts`                     | everything except `src/index.ts`                            |
| `src/index.ts`                         | everything                                                  |

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
│       └── legacy.ts            pre-1.6 cleanup + legacy snapshot migration (delete at 1.7.0)
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
│   └── registry.ts              SessionRegistry: session events, switch/release, heartbeat, shutdown
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
  `session/`.
