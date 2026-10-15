# OMP Undo/Redo

[![npm version](https://img.shields.io/npm/v/%40baylarsadigov%2Fomp-undo-redo)](https://www.npmjs.com/package/@baylarsadigov/omp-undo-redo)
[![CI](https://github.com/Baylar55/omp-undo-redo/actions/workflows/ci.yml/badge.svg)](https://github.com/Baylar55/omp-undo-redo/actions/workflows/ci.yml)

Official npm package: [@baylarsadigov/omp-undo-redo](https://www.npmjs.com/package/@baylarsadigov/omp-undo-redo)

A small extension for session and file undo/redo in Oh My Pi (OMP) and Pi. It adds `/undo` and `/redo` without modifying either agent's source code or session format.

`/undo` moves the conversation back to your last prompt, dropping the agent's reply and tool activity, and puts your files back as they were before that turn; `/redo` moves forward again. Before you rely on it, know what it does with your files:

- **Snapshots hold file contents in plaintext**, outside your repository, until the session has been idle for 2 days (configurable). In a Git project that includes untracked files `.gitignore` does not exclude, such as `.env.local`; in a folder without Git it includes everything outside a short built-in ignore list, `.env` and private keys included.
- **`/undo` reverts every file that changed during the turn**, including edits from your editor or a build watcher, and lists the files it restored.
- **Some changes are not undone**: ignored files, nested Git repositories, files another program had locked, and Git LFS files whose content `git lfs prune` removed.
- **A home directory, drive root or temp directory without Git gets no file snapshots**: only the conversation moves back there.

Details: [What gets stored and what isn't restored](#what-gets-stored-and-what-isnt-restored).

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
omp plugin install @baylarsadigov/omp-undo-redo@1.7.0
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
pi install npm:@baylarsadigov/omp-undo-redo@1.7.0
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

Every completed turn remains navigable, including conversation-only turns and turns that change only ignored files. In Git projects and non-Git workspaces alike, `/undo` and `/redo` restore worktree snapshots through Git without rewriting the Git index. Ignored files are outside the snapshots, so changes to them survive undo/redo untouched; see [What gets stored and what isn't restored](#what-gets-stored-and-what-isnt-restored).

Completed Git or non-Git checkpoints and the undo/redo cursor survive a normal terminal restart. Resuming the same session in the same worktree restores both `/undo` and `/redo` history, unless the session's file history was removed by the retention policy (see [Configuration](#configuration)). If durable file metadata is missing or unusable, the extension reconstructs completed turns from the active session branch and offers session-only undo with an explicit warning. A changed worktree must still pass the normal conflict check; resuming never bypasses file-safety checks.

An `/undo` or `/redo` cut short by a killed process or a crash is settled the next time the session loads. Before restoring files, each one records what it is doing next to the session's history. If the files were fully restored, the undo/redo cursor moves to match them and a notice says so. If the restore never started, nothing changes. If it stopped halfway, the cursor stays where it was and a warning names the snapshot store and the two snapshot hashes, so the files can be restored by hand (see [Restoring files after an interrupted undo or redo](#restoring-files-after-an-interrupted-undo-or-redo)). Loading only checks the files; it never writes them.

The saved history file is capped at 4 MiB, roughly 9,000 Git turns. A session that outgrows it keeps the checkpoint at the cursor and drops the oldest turns first, so after a resume those turns can no longer be undone; their snapshots stay until the retention policy removes the session.

Subagent sessions (the `task` tool, eval `agent()`, `/tan` clones) are not checkpointed: OMP runs them in the same process with their own copy of the extension, and they cannot be undone, so that copy captures no snapshots, writes no history, never delays a subagent's tool calls, and answers `/undo`/`/redo` with a warning. Edits a subagent makes in the parent's workspace while a parent turn runs land in that turn's after-snapshot, so `/undo` of the parent turn reverts them. This needs an OMP version that reports `ctx.agent`; older hosts checkpoint subagent sessions like any other.

Snapshots cover the whole worktree, not just the files the agent's tools wrote, and a turn's after-snapshot is taken when the turn ends. Anything else that changes a file while the turn runs — saving it in your editor, a build watcher, a formatter on save, another OMP process in the same repository — lands in that snapshot too, so `/undo` of the turn reverts it along with the agent's edits. Undo/redo names every file it restored ("…file snapshot restored. Restored files: notes.md, src/app.ts.", the first five, then "and N more"), so check that list for files the agent did not touch. Edits made after the turn ends are safe: `/undo` refuses to run over them ("Worktree changed; nothing was undone. Conflicting files: notes.md.") when they overlap the turn's changes, naming the files in the way, and leaves them in place when they do not.

While the extension process is running, it publishes normalized Undo/Redo action state for external clients. State lives in a private process-scoped directory at `~/.omp/omp-undo-redo/runtime/<pid>/`, shared by every session of the process (for example several ACP sessions) under one runtime ID and removed when the last of them shuts down; set `OMP_UNDO_REDO_RUNTIME_DIR` to override the root for tests or deployments (see [Configuration](#configuration): without `OMP_UNDO_REDO_STORE_DIR` it also moves the snapshot store). Session filenames use SHA-256 session namespaces, and state includes action availability, selected leaf, navigation revision, and the latest action result. Per-session state writes larger than 64 KiB are skipped. Runtime publication is observational and does not add file restoration to session-only mode. Starting with the release after 1.7.0, a `runtime/<pid>/` without a `runtime.json` marker is never replaced or deleted, so a process given that pid publishes nothing (logged as `runtime-dir-foreign` with `OMP_UNDO_REDO_DEBUG=1`). Version 1.7.0 and earlier deleted whatever was at `runtime/<pid>/` on startup, and could leave one without a marker after a crash or a shutdown that could not delete every file (it holds only `sessions/` and `.tmp` files); such a directory is safe to delete by hand.

## What gets stored and what isn't restored

Snapshots copy the whole worktree into plaintext Git objects in the snapshot store, outside your repository, and keep them for the retention period (by default until the session has been idle for 2 days; see [Configuration](#configuration)):

- **Git projects**: tracked files and every untracked file `.gitignore` does not exclude, such as an unignored `.env.local`.
- **Non-Git folders** (Private-Git mode): everything except the built-in ignore list, so `.env`, `id_rsa`, `*.pem` and `credentials.json` are included. The built-in list is `.git`, `.hg`, `.svn`, `node_modules`, `.history`, `dist`, `coverage`, `.omp`, `.next`, `build`, `out`, `target`, `.vs`, `.idea`, `__pycache__`, `.venv` and `.gradle`. Each name matches at any depth, so changes inside a hand-written `docs/build/` or `out/` folder are not restored either.
- **A non-Git home directory, drive root or temp directory** gets no file snapshots at all (see the session-only fallback under [Limitations](#limitations)).

`/undo` and `/redo` leave these as they are:

- **Ignored files.** Files matched by the repository's `.gitignore` — or, in Private-Git mode, by the built-in ignore list — are outside the snapshots: changes to them survive undo/redo untouched.
- **Nested Git repositories.** Submodules, or a folder with its own `.git` inside the workspace, are outside the snapshots: a snapshot records at most the nested repository's HEAD commit, never its files, and a nested repository with no commit is left out entirely. Undo/redo leaves their contents (and HEAD) as they are and names them in the result instead of reporting a full restore: "…file snapshot restored, but files inside nested Git repositories are outside the snapshot and were not restored: mod."
- **Files Git could not read.** A file held open exclusively by a running app while a snapshot is taken (as Visual Studio does with `.vs` databases), or without read permission, is left out of that snapshot instead of failing it. Undo/redo leaves such a file as it is on disk and names it: "…file snapshot restored, but files Git could not read when the snapshot was taken (locked by another process or no read permission) were left as they are: app.db."
- **Git LFS files whose content was pruned.** A capture runs clean filters the way `git add` does, so Git LFS (or any filter driver with its own storage) writes every filtered file a capture hashes, untracked files included, to the repository's LFS storage (`.git/lfs/objects` by default; the store's own `lfs/` in Private-Git mode, removed when the store is evicted). Nothing in the extension deletes those files and neither does `git gc`; only `git lfs prune` does. Restoring a file whose LFS object was pruned fails (unless LFS can download it from the remote) and the restore is rolled back, unless the object of the file's current version was pruned too, in which case the file is left empty.
- **Checkpoints that need rewritten history.** In Git mode, content your `HEAD` reached at capture time is shared with your repository, not copied, until a store gc finds `HEAD` no longer reaching it. If you rewrite that history and prune it before then (`git filter-repo` and BFG do both in one run), checkpoints that need it can no longer be restored, and undo/redo reports the failure instead of restoring part of them.

## Configuration

The extension supports optional environment variables to configure snapshot history retention and storage locations:

- `OMP_UNDO_REDO_RETENTION_DAYS` — Inactivity retention threshold in days (default: `2`). Dormant session history untouched for longer than this limit is deleted on extension startup. The clock counts from the session's last access; resuming or using a session refreshes it. Fractions are allowed (`0.5` is 12 hours). Set to `0` to disable age-based expiration (indefinite retention). A value that is not a non-negative number (`7days`, `-1`, empty) is ignored and the default applies. Retention-by-age is the only limit on the snapshot store; there is no store-wide byte cap (each session's history file is capped at 4 MiB, see [Usage](#usage)).
- `OMP_UNDO_REDO_STORE_DIR` — Root directory for state, private Git repositories, and session history (default: `~/.omp/omp-undo-redo`). Legacy `OMP_UNDO_REDO_BLOB_DIR` is retained as a permanent alias.
- `OMP_UNDO_REDO_RUNTIME_DIR` — Root of the runtime action-state directories (default: `~/.omp/omp-undo-redo/runtime`). When neither store variable is set, the snapshot store moves with it: to its parent if the directory is named `runtime`, otherwise to the directory itself.
- `OMP_UNDO_REDO_DEBUG` — Set to `1` to append every git command the extension runs (working directory, arguments, the environment overrides it sets, exit code, duration, and up to 8 KiB of stderr) as one JSON line to `<storeRoot>/debug.log`, along with the error of a turn whose recording failed. Lines are written synchronously, so a crash keeps the last ones. Never logs stdin or stdout, so no file contents, but the working directory, the store paths, arguments and stderr name your folders, files and commit hashes. The log is not rotated: turn it off once you have the trace.

Snapshot stores (`<storeRoot>/repos`) and runtime directories (`<runtimeRoot>/<pid>`) are always created owner-only (`0700`). The default roots are also restricted to `0700`; a root set through these variables keeps the permissions it has, so pointing one at a shared directory such as `/tmp` does not change that directory's mode.

### Setting the variables

Set these in your Pi/OMP process environment before starting the agent. A running process never sees later changes to its environment, so changing them in a terminal while a session is open has no effect. The values are global to the agent process, not per project.

**Linux / macOS (bash, zsh)** — export in the current terminal, or add to `~/.bashrc` / `~/.zshrc` so they persist across sessions:

```sh
export OMP_UNDO_REDO_RETENTION_DAYS=7
export OMP_UNDO_REDO_STORE_DIR="$HOME/.local/state/omp-undo-redo"
```

**Windows PowerShell** — for the current session:

```powershell
$env:OMP_UNDO_REDO_RETENTION_DAYS = "7"
$env:OMP_UNDO_REDO_STORE_DIR = "D:\omp-undo-redo"
```

**Windows (persistent)** — use `setx`, then open a new terminal:

```powershell
setx OMP_UNDO_REDO_RETENTION_DAYS 7
setx OMP_UNDO_REDO_STORE_DIR "D:\omp-undo-redo"
```

To disable automatic cleanup, set `OMP_UNDO_REDO_RETENTION_DAYS=0` (indefinite retention).

Changing `OMP_UNDO_REDO_STORE_DIR` (or `OMP_UNDO_REDO_RUNTIME_DIR` without a store variable) starts an empty store: nothing is moved, so turns recorded before the change can no longer restore files, and the old directory stays on disk until you delete it.

### Expiration behavior

Cleanup runs automatically in the background shortly after extension startup and never blocks session initialization or the first undo/redo; sessions currently in use are never expired or evicted. Successful cleanup is silent. When a dormant session's file history is expired, resuming that session shows a warning: session navigation still works, but file changes from the expired turns cannot be restored, and `/undo`/`/redo` degrade to session-only navigation.

Sessions in use by another OMP process sharing the same repository or store are protected the same way. Once an expired session records a new turn, its saved history supersedes the expiration marker, so undo capability resumes for the new turns instead of every later resume reporting "expired".

Expiry deletes a session's snapshot refs and history file from the store; a background `git gc` later deletes the snapshot objects nothing else references. Until it does, the objects stay on disk, and neither step securely erases them. Every OMP start sweeps every store under `<storeRoot>/repos/`, so the history of a workspace you never reopen still expires. A store whose workspace (or, in Git mode, repository) has been deleted is renamed aside once it has been idle for 24 hours, and its contents are removed 7 days later. How retention, gc and eviction work: [Storage maintenance](./docs/architecture.md#storage-maintenance).

## Limitations

Undo/redo operates in one of three modes:

- **Git mode**: Snapshots go to a separate snapshot store at `<storeRoot>/repos/<sha256(commonDir)>.git`, shared by linked worktrees, never to your repository: `HEAD`, branch refs and the real index are never touched, and `git push --mirror`, `git clone --mirror`, `git bundle create --all` and `git log --all` never see snapshots. Your repository's `.gitignore`, `info/exclude` and attributes decide what is captured. `core.autocrlf` is off for snapshots and restores, so a file no text/eol attribute covers is stored and restored byte for byte. Neither your repository's normal `git gc` nor an aggressive `git reflog expire --expire=now --all && git gc --prune=now` can break a checkpoint; the exceptions are Git LFS content and rewritten history (see [What gets stored and what isn't restored](#what-gets-stored-and-what-isnt-restored)). How the store borrows and keeps your objects: [Git-mode snapshot store](./docs/architecture.md#git-mode-snapshot-store).
- **Private-Git mode**: Non-Git workspaces get an isolated private repository under `<storeRoot>/repos/<sha256(cwd)>.git` (defaults to `~/.omp/omp-undo-redo/repos/`, configurable via `OMP_UNDO_REDO_STORE_DIR` or legacy `OMP_UNDO_REDO_BLOB_DIR`), with the workspace as its worktree, and snapshots through the same alternate-index engine. The private repository is seeded with the [built-in ignore list](#what-gets-stored-and-what-isnt-restored) so churn is bounded; because a non-Git workspace usually has no `.gitignore`, everything outside that list is captured, secrets included. The store root and its `repos/` directory are created owner-only (`0700`) and the repository is configured with `core.sharedRepository=0600`, so other local users on a shared POSIX host cannot read them. Repositories created by an earlier version keep their original object modes: if the store was ever created with a permissive umask, close every OMP and Pi process, then delete `<storeRoot>/repos`. That deletes all undo file history; the store is recreated owner-only on next use.
- **Session-only fallback**: If no Git binary is available or private repository initialization fails, the extension navigates session context without restoring file changes, notifying the user once per session. A failed snapshot store setup is retried at the start of every turn, and file snapshots resume from the first turn it succeeds; several OMP processes setting up the same new store at once retry instead of failing. A non-Git home directory (or any folder above it, such as `C:\Users` or `/home`), a filesystem root (`C:\`, `/`) and the OS temp directory always get this fallback: Private-Git would copy every file there (`.ssh`, `AppData`, browser profiles) into plaintext snapshot objects. Their subfolders are ordinary workspaces. Only the current user's home and temp directory are recognized: another user's home (`C:\Users\Administrator`), the system temp directory (`C:\Windows\Temp`) and system folders (`C:\Windows`) are snapshotted like any other folder. Making such a folder a Git repository does not make it safe: Git mode then snapshots everything its `.gitignore` does not exclude. A store an earlier version created for one of them is evicted once idle for 24 hours, like the store of a deleted workspace.

Snapshots never block the prompt for long. Each wait has a limit; the defaults are below, and hosts embedding the extension can change them. All stay under OMP's 30 s limit on extension handlers, so a very large or slow workspace cannot time the extension out.

| What waits                                                                                | Limit              | When the limit is reached                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt start (`before_agent_start`) and turn end (`agent_end`), for an in-flight snapshot | 3 s                | The snapshot keeps running in the background; the turn's undo boundary is recorded when it finishes.                                                     |
| `/undo` and `/redo`, for an in-flight snapshot or the previous turn's after-snapshot      | 3 s                | Nothing changes; the command says to try again shortly instead of acting on a half-recorded state.                                                       |
| Each tool call, for the turn's before-snapshot                                            | 25 s per tool call | The tool runs; the snapshot is discarded and the turn is recorded session-only, so `/undo` moves the conversation back and says files were not restored. |
| Turn end (`agent_end`), for the after-snapshot and history write                          | 25 s               | They finish in the background.                                                                                                                           |

Tools wait because a tool that edits a file before Git has read it would make the snapshot record the edit as the pre-turn state; recording the turn session-only is safer than restoring a wrong baseline. A turn whose snapshot only finishes after the next turn has started keeps its conversation boundary but loses file restoration for that turn alone (its snapshot already contains the next turn's edits); the turns before and after it stay restorable.

### Checkpoint ownership and stale cleanup

Checkpoint refs live under `refs/omp-undo-redo/` in the snapshot store. A turn's refs start as pending refs owned by the running process and become history refs when the turn completes; stale-owner cleanup never touches history refs. A later run deletes pending refs left by an exited process on this machine, and those of an owner it cannot probe (another host ID, hostname or, on Linux, boot or PID namespace) once that owner's lease has gone 7 days without a refresh. Ref layout and lease rules: [Checkpoint refs and owner leases](./docs/architecture.md#checkpoint-refs-and-owner-leases).

For manual inspection, stop all OMP/Pi processes that use the repository, then use Git commands only, against the store (`<storeRoot>/repos/<hash>.git` for a Private-Git workspace or a Git repository; a Git-mode store records its repository in its `config` as `omp-undo-redo.commondir`):

```sh
git --git-dir=<store> for-each-ref --format="%(refname) %(objectname)" refs/omp-undo-redo/
git --git-dir=<store> update-ref -d <exact-ref> <expected-object-id>
```

Replace the placeholders with the exact ref and object ID printed by the first command. Do not delete a ref by name alone. Removing a ref makes its objects eligible for later Git reclamation; it does not immediately or securely erase the object data. Unreadable host identity or Linux runtime-scope state, malformed leases, and future ref versions remain manual-cleanup cases. The persistent host-ID directory must not be copied or shared between independent native machines that use the same repository and hostname; native Windows and macOS cleanup assumes that identity is machine-local. Sharing it between machines (cloned virtual machines, synced dotfiles, shared network homes) can make one machine classify another machine's live sessions as stale and delete their pending checkpoint refs.

### Restoring files after an interrupted undo or redo

When an interrupted `/undo` or `/redo` left files partly restored, its warning names the snapshot store and two snapshot hashes: the one marked "before the /undo" (or "/redo") is where undo history still points, the other is the command's result. Put the files back at the "before" snapshot, then run the command again. The commands below write only the files that differ between the two snapshots (overwriting any edit you made to them since the interruption) and never touch your Git index, `HEAD`, or any other file; a directory emptied this way is left in place.

Close every OMP and Pi process using the workspace, then run this from the workspace root after filling in the three placeholders. In bash, zsh or Git Bash:

```sh
store='<store>' before=<before-hash> result=<result-hash>
repo=$(git --git-dir="$store" config omp-undo-redo.commondir)
if [ -n "$repo" ]; then # Git mode: also read the repository's own objects
  export GIT_OBJECT_DIRECTORY="$store/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="$repo/objects"
else # Private-Git mode
  export GIT_DIR="$store"
fi
export GIT_INDEX_FILE="$(mktemp -d)/index" # scratch index: your real index is never touched
git read-tree "$before"
git diff --no-renames --name-only -z --diff-filter=D "$result" "$before" | xargs -0 rm -f --
git diff --no-renames --name-only -z --diff-filter=d "$result" "$before" |
  git -c core.autocrlf=false checkout-index -f -z --stdin
unset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_DIR GIT_INDEX_FILE
```

In PowerShell (on Linux and macOS, prefer the bash block: this one reads file names line by line, so a name containing `"`, `\` or a control character is not handled):

```powershell
$store = '<store>'; $before = '<before-hash>'; $result = '<result-hash>'
[Console]::OutputEncoding = [Text.Encoding]::UTF8 # read file names git prints as UTF-8
$repo = git --git-dir="$store" config omp-undo-redo.commondir
if ($repo) { $env:GIT_OBJECT_DIRECTORY = "$store/objects"; $env:GIT_ALTERNATE_OBJECT_DIRECTORIES = "$repo/objects" } else { $env:GIT_DIR = $store }
$env:GIT_INDEX_FILE = Join-Path ([IO.Path]::GetTempPath()) "omp-undo-redo-recover-$PID.index"
git read-tree $before
git -c core.quotePath=false diff --no-renames --name-only --diff-filter=D $result $before |
  ForEach-Object { if (Test-Path -LiteralPath $_ -PathType Leaf) { Remove-Item -LiteralPath $_ -Force } }
git -c core.quotePath=false diff --no-renames --name-only --diff-filter=d $result $before |
  ForEach-Object { git -c core.autocrlf=false checkout-index -f '--' $_ }
Remove-Item -LiteralPath $env:GIT_INDEX_FILE
'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_DIR', 'GIT_INDEX_FILE' |
  ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
```

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
