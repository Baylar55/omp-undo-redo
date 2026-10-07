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
- Git-backed projects use Git snapshots. Non-Git workspaces snapshot into a private per-workspace Git repository.

An initialized Git repository does not need an existing commit. In an unborn repository, the extension seeds its checkpoint index from the first snapshot's own tree and keeps that index lease until `HEAD` is born, so later turns reuse the stat cache instead of re-hashing the workspace.

## Installation

Install the extension through OMP's plugin manager. Running `npm install` in an arbitrary project only downloads the package; it does not register the extension with OMP:

```sh
omp plugin install @baylarsadigov/omp-undo-redo
```

To pin an exact release:

```sh
omp plugin install @baylarsadigov/omp-undo-redo@1.6.5
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
pi install npm:@baylarsadigov/omp-undo-redo@1.6.5
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

Every completed turn remains navigable, including conversation-only turns and turns that change only ignored files. In Git projects and non-Git workspaces alike, `/undo` and `/redo` restore worktree snapshots through Git without rewriting the Git index. Files matched by the repository's `.gitignore` — or by the built-in ignore list, which Private-Git mode seeds into its private repository — are outside these checkpoints: changes to them survive undo/redo untouched.

Completed Git or non-Git checkpoints and the undo/redo cursor survive a normal terminal restart. Resuming the same session in the same worktree restores both `/undo` and `/redo` history, unless the session's file history was removed by the retention policy (see [Configuration](#configuration)). If durable file metadata is missing or unusable, the extension reconstructs completed turns from the active session branch and offers session-only undo with an explicit warning. A changed worktree must still pass the normal conflict check; resuming never bypasses file-safety checks.

The saved history file is capped at 4 MiB, roughly 8,000 Git turns. A session that outgrows it keeps the checkpoint at the cursor and drops the oldest turns first, so after a resume those turns can no longer be undone; their snapshots stay until the retention policy removes the session.

Subagent sessions (the `task` tool, eval `agent()`, `/tan` clones) are not checkpointed: OMP runs them in the same process with their own copy of the extension, and they cannot be undone, so that copy captures no snapshots, writes no history, never delays a subagent's tool calls, and answers `/undo`/`/redo` with a warning. Edits a subagent makes in the parent's workspace while a parent turn runs land in that turn's after-snapshot, so `/undo` of the parent turn reverts them. This needs an OMP version that reports `ctx.agent`; older hosts checkpoint subagent sessions like any other.

While the extension process is running, it publishes normalized Undo/Redo action state for external clients. State lives in a private process-scoped directory at `~/.omp/omp-undo-redo/runtime/<pid>/`, shared by every session of the process (for example several ACP sessions) under one runtime ID and removed when the last of them shuts down; set `OMP_UNDO_REDO_RUNTIME_DIR` to override the root for tests or deployments (see [Configuration](#configuration): without `OMP_UNDO_REDO_STORE_DIR` it also moves the snapshot store). Session filenames use SHA-256 session namespaces, and state includes action availability, selected leaf, navigation revision, and the latest action result. Per-session state writes larger than 64 KiB are skipped. Runtime publication is observational and does not add file restoration to session-only mode.

## Configuration

The extension supports optional environment variables to configure snapshot history retention and storage locations:

- `OMP_UNDO_REDO_RETENTION_DAYS` — Inactivity retention threshold in days (default: `2`). Dormant session history untouched for longer than this limit is deleted on extension startup. The clock counts from the session's last access; resuming or using a session refreshes it. Fractions are allowed (`0.5` is 12 hours). Set to `0` to disable age-based expiration (indefinite retention). A value that is not a non-negative number (`7days`, `-1`, empty) is ignored and the default applies. Retention-by-age is the sole storage limit; there is no byte cap.
- `OMP_UNDO_REDO_STORE_DIR` — Root directory for state, private Git repositories, and session history (default: `~/.omp/omp-undo-redo`). Legacy `OMP_UNDO_REDO_BLOB_DIR` is retained as a permanent alias.
- `OMP_UNDO_REDO_RUNTIME_DIR` — Root of the runtime action-state directories (default: `~/.omp/omp-undo-redo/runtime`). When neither store variable is set, the snapshot store moves with it: to its parent if the directory is named `runtime`, otherwise to the directory itself.

Snapshot stores (`<storeRoot>/repos`) and runtime directories (`<runtimeRoot>/<pid>`) are always created owner-only (`0700`). The default roots are also restricted to `0700`; a root set through these variables keeps the permissions it has, so pointing one at a shared directory such as `/tmp` does not change that directory's mode.

### Setting the variables

Set these in your Pi/OMP process environment before starting the agent. A running process never sees later changes to its environment, so changing them in a terminal while a session is open has no effect. The values are global to the agent process, not per project.

**Linux / macOS (bash, zsh)** — export in the current terminal, or add to `~/.bashrc` / `~/.zshrc` so they persist across sessions:

```sh
export OMP_UNDO_REDO_RETENTION_DAYS=7
export OMP_UNDO_REDO_STORE_DIR=~/.omp/omp-undo-redo
```

**Windows PowerShell** — for the current session:

```powershell
$env:OMP_UNDO_REDO_RETENTION_DAYS = "7"
$env:OMP_UNDO_REDO_STORE_DIR = "$HOME\.omp\omp-undo-redo"
```

**Windows (persistent)** — use `setx`, then open a new terminal:

```powershell
setx OMP_UNDO_REDO_RETENTION_DAYS 7
setx OMP_UNDO_REDO_STORE_DIR "$HOME\.omp\omp-undo-redo"
```

To disable automatic cleanup, set `OMP_UNDO_REDO_RETENTION_DAYS=0` (indefinite retention).

### Expiration behavior

Cleanup runs automatically in the background shortly after extension startup and never blocks session initialization or the first undo/redo; sessions currently in use are never expired or evicted. Successful cleanup is silent. When a dormant session's file history is expired, resuming that session shows a warning: session navigation still works, but file changes from the expired turns cannot be restored, and `/undo`/`/redo` degrade to session-only navigation.

"In use" is enforced across processes: every history load/save touches a liveness marker (`.active.<sessionHash>`, fresh for 24 hours) in the shared history directory, a background interval re-asserts it for all locally active sessions every 10 minutes, and retention sweeps skip any session with a fresh marker — including sweeps started by another process sharing the same repository or store. Once an expired session records a new turn, its saved history supersedes the expiration marker, so undo capability resumes for the new turns instead of every later resume reporting "expired".

In Git workspaces, expiration removes the session's history refs under `refs/omp-undo-redo/history/<sessionHash>/` and its history file inside the repository's snapshot store (see Git mode below). The store gets the same retention sweep and eviction as a private repository. Its capture-threshold check runs the full gc (below) only once the store crosses git's own `gc --auto` limits (more than 6700 loose objects, or 50 packs without a `.keep`): any repack there must first re-pin the store's copies of objects the repository also holds, so it cannot hand the decision to `git gc --auto`. As with every gc here, it prunes with `--prune=1.hour.ago`: every OMP process working in the repository or its linked worktrees shares the store, so another one may be mid-capture. The repository's own `.git` never holds snapshot objects and never grows from them.

In non-Git workspaces, Private-Git mode expires the session's refs and history file inside the private repository. After every 20 captured snapshots (and on shutdown, when captures are due) a background `git gc --auto --prune=1.hour.ago` runs: git repacks only past its own limits (more than 6700 loose objects, or 50 packs), and then packs just the loose objects unless the pack limit was hit, so its cost follows what was written since, not the size of the store; the hour spares objects another OMP process in the same folder has written but not yet linked to a ref. The first session start of every OMP process also sweeps _every_ private repository under `<storeRoot>/repos/`, not only the current workspace's, so a workspace that is never reopened still has its dormant history expired; any private repository that lost refs this way then gets a background `git gc --prune=1.hour.ago`, which deletes the expired snapshot objects while sparing objects a concurrent capture wrote in the last hour. Every full gc (the sweep's, and a Git-mode store's) is preceded by a standalone `git prune --expire=1.hour.ago`: gc prunes only after it repacks, so a store whose repack never finishes (killed at its 15-minute ceiling, or with the terminal) still has its expired snapshots and the stale `tmp_*` files of killed repacks deleted. `git prune` never deletes packed objects, so every deletion of a store's refs (expiry, redo invalidation, a discarded capture, stale-owner cleanup) first writes `<store>/omp-undo-redo/gc-pending`, a gc claims it as `gc-pending.running` (unless a claim already exists, in which case the mark stays) and deletes the claim only once it finishes, and the same sweep (even with `OMP_UNDO_REDO_RETENTION_DAYS=0`) gcs every store holding either file, a cruft pack, or objects without a single ref: a gc the exiting process cut short or never started is retried by the next launch. Stale private repositories whose workspace has disappeared are evicted conservatively: the workspace must read as missing on two checks moments apart, the repository must be idle for at least 24 hours, and no capture, finalization, or `git gc` may be in flight. Eviction renames the repository to `<hash>.git.evicted-<timestamp>` and removes its contents only after 7 days, so a transient mount, lock, or permission hiccup can never cost undo history. Expired `*.expired.json` tombstones are pruned after twice the retention period (default 4 days) so the history directory does not grow without bound.

## Limitations

Undo/redo operates in one of three modes:

- **Git mode**: Git workspaces create private snapshots through an alternate index and `git commit-tree`; `HEAD`, branch refs, and the real index are never touched. Snapshots are stored outside the repository, in a bare snapshot store at `<storeRoot>/repos/<sha256(commonDir)>.git` shared by linked worktrees: snapshot commands still run against your repository (its `HEAD`, config, `.gitignore`, `info/exclude` and attributes), but new objects are written to the store (`GIT_OBJECT_DIRECTORY`), refs under `refs/omp-undo-redo/` live only there, and your objects are borrowed through `GIT_ALTERNATE_OBJECT_DIRECTORIES` instead of copied. So `git push --mirror`, `git clone --mirror`, `git bundle create --all` and `git log --all` never see snapshots, including untracked non-ignored files such as `.env.local`. Snapshots that earlier versions kept in the repository (refs under `refs/omp-undo-redo/`, files under `.git/omp-undo-redo/`) are moved into the store and deleted from the repository on the next session start. Each capture copies into the store every snapshot object your `HEAD` does not reach (content of a reset or amended commit, a staged-then-dropped file, an old version a file was reverted to), and before every store gc the extension packs every snapshot object your `HEAD` then does not reach into a kept pack of the store (`objects/pack/*.keep`, rebuilt at each gc so expired snapshots are still reclaimed). Neither your repository's normal `git gc` nor an aggressive `git reflog expire --expire=now --all && git gc --prune=now` can therefore break a checkpoint. Content your `HEAD` reached at capture time stays shared until a store gc finds `HEAD` no longer reaching it, so capture never copies the repository: if you rewrite that history and prune it before then (`git filter-repo` and BFG do both in one run), checkpoints that need it can no longer be restored, and undo/redo reports the failure instead of restoring part of them.
- **Private-Git mode**: Non-Git workspaces get an isolated private repository under `<storeRoot>/repos/<sha256(cwd)>.git` (defaults to `~/.omp/omp-undo-redo/repos/`, configurable via `OMP_UNDO_REDO_STORE_DIR` or legacy `OMP_UNDO_REDO_BLOB_DIR`), with the workspace as its worktree, and snapshots through the same alternate-index engine. The private repository is seeded with built-in ignores (`node_modules`, `dist`, `.omp`, etc.) so churn is bounded. Because a non-Git workspace usually has no `.gitignore`, these snapshots capture **everything** outside that built-in list — `.env`, `id_rsa`, `*.pem`, `credentials.json` included — in plaintext Git objects for the whole retention window. The store root and its `repos/` directory are created owner-only (`0700`) and the repository is configured with `core.sharedRepository=0600`, so other local users on a shared POSIX host cannot read them; repositories created by an earlier version keep their original object modes, so delete `<storeRoot>/repos` if the store was ever created with a permissive umask.
- **Session-only fallback**: If no Git binary is available or private repository initialization fails, the extension navigates session context without restoring file changes, notifying the user once per session. A non-Git home directory (or any folder above it, such as `C:\Users` or `/home`), a filesystem root (`C:\`, `/`) and the OS temp directory always get this fallback: Private-Git would copy every file there (`.ssh`, `AppData`, browser profiles) into plaintext snapshot objects. Their subfolders are ordinary workspaces. Only the current user's home and temp directory are recognized: another user's home (`C:\Users\Administrator`), the system temp directory (`C:\Windows\Temp`) and system folders (`C:\Windows`) are snapshotted like any other folder. Making such a folder a Git repository does not make it safe: Git mode then snapshots everything its `.gitignore` does not exclude. A store an earlier version created for one of them is evicted once idle for 24 hours, like the store of a deleted workspace.

Git and Private-Git checkpoints cover tracked files and untracked non-ignored files across the repository worktree. Files matched by the repository's `.gitignore` — or by the built-in ignore list, which Private-Git mode seeds into its private repository — are outside these checkpoints: changes to them survive undo/redo untouched.

Nested Git repositories — submodules, or a folder with its own `.git` inside the workspace — are outside the checkpoints too: a snapshot records at most the nested repository's HEAD commit, never its files, and a nested repository with no commit is left out entirely. Undo/redo leaves their contents (and HEAD) as they are and names them in the result instead of reporting a full restore: "…file snapshot restored, but files inside nested Git repositories are outside the snapshot and were not restored: mod."

A file Git cannot read while a snapshot is taken (held open exclusively by a running app, as Visual Studio does with `.vs` databases, or without read permission) is left out of that snapshot instead of failing it. Undo/redo leaves such a file as it is on disk and names it: "…file snapshot restored, but files Git could not read when the snapshot was taken (locked by another process or no read permission) were left as they are: app.db."

Checkpoint capture never blocks the prompt: `before_agent_start`, `agent_end`, `/undo` and `/redo` wait at most a few seconds (default 3 s, configurable by hosts embedding the extension) for an in-flight capture; when a capture overruns that deadline it keeps running in the background and the turn's undo boundary is recorded as soon as it settles, so a very large or slow workspace cannot time out the extension handlers (OMP's 30 s handler cap). `agent_end` likewise stops waiting for the turn's after-snapshot and history write after 25 s; they finish in the background and `/undo` and `/redo` wait for them. The agent's tools, however, wait for the turn's before-snapshot (up to 25 s per tool call), because a tool that edits a file before git has read it would make the snapshot capture the edit as the pre-turn state. If the snapshot is still running when a tool is released, it is discarded and that turn is recorded session-only: `/undo` moves the session back and says files were not restored rather than restoring a wrong baseline. While a capture is still in flight, `/undo`/`/redo` tell you to try again shortly instead of acting on a half-recorded state. A turn whose capture only settles after the next turn already started keeps its session boundary but loses file restoration for that turn alone (its snapshot already contains the next turn's edits); turns before and after it stay restorable.

### Checkpoint ownership and stale cleanup

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

`<checkpointId>` is 16 hex characters. Refs are loose files under the snapshot store's `refs/`, which sets `core.longpaths` for its own refs, so the repository path does not limit them; only the extension's Git ever reads the store. Older versions used `v2/<ownerId>/<sessionHash>/<uuid>`; those refs are still recognized and cleaned up.

The extension publishes a lease in the store before it creates a v2 ref. A later runtime automatically removes temporary v2 refs only when the lease is valid, has the same persistent host ID, hostname, and runtime scope, and its PID probe returns `ESRCH`. On Linux, the runtime scope binds cleanup to both the current kernel boot ID and PID namespace, preventing a container or WSL process outside that namespace from being mistaken for a dead local process. If that scope cannot be resolved, automatic cleanup is disabled while v2 checkpointing and graceful cleanup continue. Current, live, remote, malformed, future-version, unreadable, and otherwise uncertain owners are preserved. Existing ownerless refs and completed history refs are never stale-runtime cleanup candidates. Automatic maintenance runs once per runtime and repository, in the background, with bounded Git operations; maintenance failure does not block checkpoint creation or commands.

For manual inspection, stop all OMP/Pi processes that use the repository, then use Git commands only, against the store (`<storeRoot>/repos/<hash>.git` for a Private-Git workspace or a Git repository; a Git-mode store records its repository in its `config` as `omp-undo-redo.commondir`):

```sh
git --git-dir=<store> for-each-ref --format="%(refname) %(objectname)" refs/omp-undo-redo/
git --git-dir=<store> update-ref -d <exact-ref> <expected-object-id>
```

Replace the placeholders with the exact ref and object ID printed by the first command. Do not delete a ref by name alone. Removing a ref makes its objects eligible for later Git reclamation; it does not immediately or securely erase the object data. Unreadable host identity or Linux runtime-scope state, malformed leases, and future ref versions remain manual-cleanup cases. The persistent host-ID directory must not be copied or shared between independent native machines that use the same repository and hostname; native Windows and macOS cleanup assumes that identity is machine-local. Sharing it between machines (cloned virtual machines, synced dotfiles, shared network homes) can make one machine classify another machine's live sessions as stale and delete their pending checkpoint refs.

### Git index and staged changes

`/undo` and `/redo` are worktree operations, not staging operations. Staged changes that existed before or were created during a turn remain staged, even when navigation restores an earlier worktree snapshot. A touched path can therefore show `MM`, `AM`, `MD`, or another two-column porcelain state after navigation. `git diff --cached` shows what a commit would take from the preserved index. `git diff` shows unstaged differences between that index and the restored worktree. Inspect both views and deliberately stage the desired files before committing. The extension does not recommend an automatic `git add -A`, `git reset`, or `git restore --staged` command because each can alter unrelated staging intent.

For example, if `f.txt` is committed as `base`, a turn changes it to `turn` and stages it, and `/undo` restores the worktree to `base`, Git reports `MM f.txt`: `git diff --cached` still shows `base -> turn`, while `git diff` shows `turn -> base`. This is a visible staged/unstaged divergence, not corruption or data loss.

## Development

Install dependencies with npm, then use the scripts in `package.json`:

- `npm run build` replaces `dist/` rather than incrementally accumulating files, compiling `src/` to `dist/`.
- `npm run typecheck` checks TypeScript in `src/` and `test/` without emitting files.
- `npm test` runs the deterministic test suite.
- `npm run lint` and `npm run format:check` check style.
- `npm run verify` runs the repository verification sequence.

The implementation uses only public OMP extension APIs. Keep changes focused, preserve the package manifest, and do not commit generated `dist/` output unless a release process explicitly requires it.

## Release

Tag-triggered CI does the publishing; the runbook is [RELEASE.md](./RELEASE.md). Never put npm tokens, registry credentials, or other secrets in the repository or release logs.

## Security

Please read [SECURITY.md](./SECURITY.md) before reporting a vulnerability. Do not disclose credentials or sensitive data in a public issue. For normal bugs and feature requests, use the [GitHub issue tracker](https://github.com/Baylar55/omp-undo-redo/issues).

## License

Released under the [MIT License](./LICENSE). Copyright © 2026 Baylar Sadigov.
