# OMP Undo/Redo

[![npm version](https://img.shields.io/npm/v/%40baylarsadigov%2Fomp-undo-redo)](https://www.npmjs.com/package/@baylarsadigov/omp-undo-redo)
[![CI](https://github.com/Baylar55/omp-undo-redo/actions/workflows/ci.yml/badge.svg)](https://github.com/Baylar55/omp-undo-redo/actions/workflows/ci.yml)

Official npm package: [@baylarsadigov/omp-undo-redo](https://www.npmjs.com/package/@baylarsadigov/omp-undo-redo)

A small extension for session and file undo/redo in Oh My Pi (OMP) and Pi. It adds `/undo` and `/redo` without modifying either agent's source code or session format.

## Agent compatibility

This package supports two related coding agents:

- **Oh My Pi (OMP)** — the fork used by this project. Website: [omp.sh](https://omp.sh). Source repository: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).
- **Pi** — the upstream coding agent. Website: [pi.dev](https://pi.dev). Source repository: [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

The extension uses the shared extension APIs provided by compatible OMP and Pi releases. See the links above for the respective projects and installation documentation.

## Requirements

- Node.js 20 or newer.
- A compatible OMP or Pi release.
- Git-backed projects use Git snapshots. Non-Git workspaces use a built-in content-addressed snapshot store.

An initialized Git repository does not need an existing commit. In an unborn repository, the extension creates full file checkpoints from an empty index.

## Installation

Install the extension through OMP's plugin manager. Running `npm install` in an arbitrary project only downloads the package; it does not register the extension with OMP:

```sh
omp plugin install @baylarsadigov/omp-undo-redo
```

To pin an exact release:

```sh
omp plugin install @baylarsadigov/omp-undo-redo@1.2.4
```

OMP discovers the compiled entry through the package manifest:

```json
{
  "omp": {
    "extensions": ["./dist/index.js"]
  }
}
```

The `pi.extensions` manifest is also included for Pi-compatible loaders. Do not add a second extension entry when the package is installed through the plugin manager.

### Pi

Install the package through Pi's package manager, not with a standalone `npm install`:

```sh
pi install npm:@baylarsadigov/omp-undo-redo
```

To pin a release:

```sh
pi install npm:@baylarsadigov/omp-undo-redo@1.2.4
```

To update installed Pi packages:

```sh
pi update --extensions
```

Use `pi list` to confirm the package is installed, then restart the Pi TUI. The `/undo` and `/redo` commands should appear in slash-command completion.

## Usage

The extension exposes exactly these commands:

- `/undo` — move to the latest user-prompt boundary, removing that prompt's assistant/tool activity from the active context. The prompt itself remains as the supported OMP session-tree boundary. If the current context is already at that boundary, it reports that undo is unavailable.
- `/redo` — restore the most recently undone context checkpoint. Redo is single-use in order: after a new branch or any successful, unrelated tree, session-switch, or session-branch navigation, the redo history is cleared. Matching `/undo` and `/redo` navigation, no-op navigation, and cancelled navigation preserve redo.

Commands take no arguments. They navigate OMP's session tree through the official extension API and do not create a new model turn.
Both commands wait for the current agent turn to become idle; if OMP remains busy, the command leaves the session unchanged and shows a warning.

Every completed turn remains navigable, including conversation-only turns and turns that change only ignored files. In Git projects, `/undo` and `/redo` restore worktree snapshots without rewriting the Git index. In non-Git workspaces, the built-in snapshot store restores regular files, binary content, and executable modes. Unsupported symlinks and files above the 16 MiB limit are reported as partial restoration. Skipped paths and their overlapping parent or descendant paths remain untouched during partial restoration. Such a session-only checkpoint is a file-history continuity barrier: older file checkpoints are discarded because applying them across an unknown file delta would be unsafe.

Completed Git or non-Git checkpoints and the undo/redo cursor survive a normal terminal restart. Resuming the same session in the same worktree restores both `/undo` and `/redo` history, unless the session's file history was removed by the retention policy (see [Configuration](#configuration)). If durable file metadata is missing or unusable, the extension reconstructs completed turns from the active session branch and offers session-only undo with an explicit warning. A changed worktree must still pass the normal conflict check; resuming never bypasses file-safety checks.

While the extension process is running, it publishes normalized Undo/Redo action state for external clients. State lives in a private process-scoped directory at `~/.omp/omp-undo-redo/runtime/<pid>/`; set `OMP_UNDO_REDO_RUNTIME_DIR` to override the root for tests or deployments. Session filenames use SHA-256 session namespaces, and state includes action availability, selected leaf, navigation revision, and the latest action result. Runtime publication is observational and does not add file restoration to session-only mode.

## Configuration

The extension supports optional environment variables to configure snapshot history retention and storage limits:

- `OMP_UNDO_REDO_RETENTION_DAYS` — Inactivity retention threshold in days (default: `2`). Dormant session history untouched for longer than this limit is deleted on extension startup. The clock counts from the session's last access; resuming or using a session refreshes it. Set to `0` to disable age-based expiration.
- `OMP_UNDO_REDO_MAX_STORE_MB` — Maximum storage cap for the non-Git blob store in MiB (default: `1024`, i.e., 1 GiB). If store size exceeds this limit, the oldest inactive session histories are evicted iteratively until total size drops below the cap. Set to `0` to disable storage cap enforcement. Applies to the non-Git blob store only.

### Setting the variables

Set these in your Pi/OMP process environment. The extension reads them **once, when it loads**, so set them before starting the agent — changing them while a session is open has no effect. The values are global to the agent process, not per project.

**Linux / macOS (bash, zsh)** — export in the current terminal, or add to `~/.bashrc` / `~/.zshrc` so they persist across sessions:

```sh
export OMP_UNDO_REDO_RETENTION_DAYS=7
export OMP_UNDO_REDO_MAX_STORE_MB=2048
```

**Windows PowerShell** — for the current session:

```powershell
$env:OMP_UNDO_REDO_RETENTION_DAYS = "7"
$env:OMP_UNDO_REDO_MAX_STORE_MB = "2048"
```

**Windows (persistent)** — use `setx`, then open a new terminal:

```powershell
setx OMP_UNDO_REDO_RETENTION_DAYS 7
setx OMP_UNDO_REDO_MAX_STORE_MB 2048
```

To disable either behavior, set its value to `0`; setting both to `0` disables automatic cleanup entirely (indefinite retention).

### Setting interaction rules

| `RETENTION_DAYS` | `MAX_STORE_MB`   | Behavior                                                                                                  |
| ---------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `2` (default)    | `1024` (default) | Age expiration (2 days) + blob storage cap enforcement (1 GiB)                                            |
| `0`              | `1024`           | No age expiration; storage cap can still evict oldest inactive sessions if total blob store exceeds 1 GiB |
| `2`              | `0`              | Age expiration (2 days); no storage cap enforcement                                                       |
| `0`              | `0`              | No automatic cleanup (indefinite retention)                                                               |

> **Note:** `OMP_UNDO_REDO_RETENTION_DAYS=0` disables age-based expiration but does **not** guarantee indefinite history retention when a storage cap is active (`MAX_STORE_MB > 0`). The cap can still evict the oldest inactive session histories to free up storage space. Active sessions are never evicted by age or storage cap.

### Expiration behavior

Cleanup runs automatically in the background shortly after extension startup and never blocks session initialization or the first undo/redo; sessions currently in use are never expired or evicted. Successful cleanup is silent. When a dormant session's file history is expired, resuming that session shows a warning: session navigation still works, but file changes from the expired turns cannot be restored, and `/undo`/`/redo` degrade to session-only navigation.

In Git workspaces, expiration removes the session's history refs under `refs/omp-undo-redo/history/<sessionHash>/` and its history file. The referenced commit objects become unreachable and are reclaimed later by the repository's normal `git gc`; `.git` size does not shrink immediately. No storage cap applies to Git object storage.

In non-Git workspaces, expiration removes the session's refs and history file, then garbage-collects orphaned blobs and tree manifests from `~/.omp/omp-undo-redo/`. When the storage cap is set, the oldest inactive sessions are evicted iteratively until the store is back under the cap.

## Limitations

Undo/redo has three modes. **Git mode** creates private snapshots through an alternate index and `git commit-tree`, then retains refs under `refs/omp-undo-redo/history/`; it never rewrites `HEAD`, branch refs, or the real index. **Non-Git mode** stores immutable content-addressed blobs and tree manifests under `~/.omp/omp-undo-redo/` (override with `OMP_UNDO_REDO_BLOB_DIR`) and keeps per-session refs and history metadata there. **Session-only mode** navigates context without changing files when a checkpoint cannot be created or loaded. Git checkpoints cover the complete repository worktree. Non-Git checkpoints cover regular files outside built-in ignored directories (`node_modules`, `dist`, `.git`, and similar). Symlinks, oversized files, empty directories, shell effects, network effects, and editor state are outside the non-Git checkpoint. If overlapping worktree changes prevent safe application, undo/redo fails instead of overwriting them. Graceful shutdown releases pending snapshots but retains completed resumable checkpoints.

### Checkpoint ownership and stale cleanup

Pending full-mode checkpoints initially use owner-scoped v2 refs:

```text
refs/omp-undo-redo/v2/<ownerId>/<sessionHash>/<checkpointId>/before
refs/omp-undo-redo/v2/<ownerId>/<sessionHash>/<checkpointId>/after
```

After a turn completes, both refs are atomically promoted to the resumable namespace:

```text
refs/omp-undo-redo/history/<sessionHash>/<checkpointId>/before
refs/omp-undo-redo/history/<sessionHash>/<checkpointId>/after
```

The extension publishes a repository-local lease before it creates a v2 ref. A later runtime automatically removes temporary v2 refs only when the lease is valid, has the same persistent host ID, hostname, and runtime scope, and its PID probe returns `ESRCH`. On Linux, the runtime scope binds cleanup to both the current kernel boot ID and PID namespace, preventing a container or WSL process outside that namespace from being mistaken for a dead local process. If that scope cannot be resolved, automatic cleanup is disabled while v2 checkpointing and graceful cleanup continue. Current, live, remote, malformed, future-version, unreadable, and otherwise uncertain owners are preserved. Existing ownerless refs and completed history refs are never stale-runtime cleanup candidates. Automatic maintenance runs once per runtime and repository, in the background, with bounded Git operations; maintenance failure does not block checkpoint creation or commands.

For manual inspection, stop all OMP/Pi processes that use the repository, then use Git commands only:

```sh
git for-each-ref --format="%(refname) %(objectname)" refs/omp-undo-redo/
git update-ref -d <exact-ref> <expected-object-id>
```

Replace the placeholders with the exact ref and object ID printed by the first command. Do not delete a ref by name alone. Removing a ref makes its objects eligible for later Git reclamation; it does not immediately or securely erase the object data. Unreadable host identity or Linux runtime-scope state, malformed leases, and future ref versions remain manual-cleanup cases. The persistent host-ID directory must not be copied or shared between independent native machines that use the same repository and hostname; native Windows and macOS cleanup assumes that identity is machine-local.

### Git index and staged changes

`/undo` and `/redo` are worktree operations, not staging operations. Staged changes that existed before or were created during a turn remain staged, even when navigation restores an earlier worktree snapshot. A touched path can therefore show `MM`, `AM`, `MD`, or another two-column porcelain state after navigation. `git diff --cached` shows what a commit would take from the preserved index. `git diff` shows unstaged differences between that index and the restored worktree. Inspect both views and deliberately stage the desired files before committing. The extension does not recommend an automatic `git add -A`, `git reset`, or `git restore --staged` command because each can alter unrelated staging intent.

For example, if `f.txt` is committed as `base`, a turn changes it to `turn` and stages it, and `/undo` restores the worktree to `base`, Git reports `MM f.txt`: `git diff --cached` still shows `base -> turn`, while `git diff` shows `turn -> base`. This is a visible staged/unstaged divergence, not corruption or data loss.

## Development

Install dependencies with npm, then use the scripts in `package.json`:

- `npm run build` replaces `dist/` rather than incrementally accumulating files, compiling `src/` to `dist/` and enforcing output parity.
- `npm run typecheck` checks TypeScript without emitting files.
- `npm test` runs the deterministic test suite.
- `npm run lint` and `npm run format:check` check style.
- `npm run verify` runs the repository verification sequence.
- `npm run bench:walk` benchmarks non-Git blob-store captures (cold, warm cache-hit, and incremental) on a synthetic workspace under the OS temp directory.

The implementation uses only public OMP extension APIs. Keep changes focused, preserve the package manifest, and do not commit generated `dist/` output unless a release process explicitly requires it.

## Release

A release consists of a reviewed change, a clean verification run (enforcing exact generated-output parity and running the compiled package-entry smoke check), an updated `CHANGELOG.md` entry, and a published npm package containing `index.js`, `dist/`, `README.md`, `LICENSE`, and `CHANGELOG.md`. The package manifest is the source of truth for the extension entry point and peer compatibility. Never place npm tokens, registry credentials, or other secrets in the repository or release logs.

## Security

Please read [SECURITY.md](./SECURITY.md) before reporting a vulnerability. Do not disclose credentials or sensitive data in a public issue. For normal bugs and feature requests, use the [GitHub issue tracker](https://github.com/Baylar55/omp-undo-redo/issues).

## License

Released under the [MIT License](./LICENSE). Copyright © 2026 Baylar Sadigov.
