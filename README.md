# OMP Undo/Redo

[![npm version](https://img.shields.io/npm/v/%40baylarsadigov%2Fomp-undo-redo)](https://www.npmjs.com/package/@baylarsadigov/omp-undo-redo)
[![CI](https://github.com/Baylar55/omp-undo-redo/actions/workflows/ci.yml/badge.svg)](https://github.com/Baylar55/omp-undo-redo/actions/workflows/ci.yml)

Official npm package: [@baylarsadigov/omp-undo-redo](https://www.npmjs.com/package/@baylarsadigov/omp-undo-redo)

A small extension for session and file undo/redo in Oh My Pi (OMP) and Pi. It adds `/undo` and `/redo` without modifying either agent's source code or session format.

`/undo` moves the conversation back to your last prompt, dropping the agent's reply and tool activity, and puts your files back as they were before that turn; `/redo` moves forward again. Before you rely on it, know what it does with your files:

- **Snapshots hold file contents in plaintext**, outside your repository. In a Git project that includes untracked files `.gitignore` does not exclude, such as `.env.local`; in a folder without Git it includes everything outside a short built-in ignore list, `.env` and private keys included. A session's snapshots are deleted at the first OMP start after it has been idle for 2 days (configurable), and the data stays on disk until a later `git gc`; neither step securely erases it.
- **`/undo` reverts every file that changed during the turn**, including edits from your editor or a build watcher, and lists the files it restored.
- **Some changes are not undone**: ignored files, nested Git repositories, files another program had locked, and Git LFS files whose content `git lfs prune` removed.
- **A home directory, drive root or temp directory without Git gets no file snapshots**: only the conversation moves back there.

Details: [What gets stored and what isn't restored](#what-gets-stored-and-what-isnt-restored). Something went wrong: [Troubleshooting](./docs/troubleshooting.md).

## Agent compatibility

- **Oh My Pi (OMP)**: [omp.sh](https://omp.sh), source [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).
- **Pi**, the upstream agent: [pi.dev](https://pi.dev), source [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

## Requirements

- Node.js 20 or newer for Pi; OMP runs extensions under Bun.
- OMP 16.5.2 or newer, or a compatible Pi release.
- Git. Git projects (with or without a first commit) are snapshotted through Git; other folders through a private per-workspace Git repository. Without a Git binary, or if the snapshot store cannot be set up, undo/redo moves only the conversation; you are told once per session, and setup is retried every turn.

## Installation

Install through the agent's package manager; a plain `npm install` downloads the package without registering it.

**OMP:**

```sh
omp plugin install @baylarsadigov/omp-undo-redo
omp plugin install @baylarsadigov/omp-undo-redo@1.7.0   # pin a release
```

**Pi:**

```sh
pi install npm:@baylarsadigov/omp-undo-redo
pi install npm:@baylarsadigov/omp-undo-redo@1.7.0       # pin a release
pi update --extensions                                  # update
```

Use `pi list` to confirm the package is installed, then restart the Pi TUI. `/undo` and `/redo` should appear in slash-command completion.

## Usage

- `/undo` moves to the latest user-prompt boundary, removing that prompt's assistant and tool activity from the active context. The prompt itself stays, as the session-tree boundary. When there is nothing left to undo it says "Nothing to undo in this session."
- `/redo` restores the most recently undone checkpoint. A new prompt, or any other successful tree, session-switch or session-branch navigation, clears redo history; matching `/undo`/`/redo`, no-op and cancelled navigation keep it.

Commands take no arguments and do not start a model turn. Both wait for the current agent turn to become idle (and briefly for an in-flight snapshot); if OMP stays busy, the session is left unchanged with a warning.

Snapshots cover the whole worktree, taken when a turn starts and when it ends. Anything that changes a file while the turn runs (your editor, a build watcher, a formatter on save, another OMP process in the same repository) lands in the turn's snapshot, so `/undo` reverts it along with the agent's edits. The result names the files it restored ("…file snapshot restored. Restored files: notes.md, src/app.ts.", the first five, then "and N more"); check that list for files the agent did not touch. Edits made after the turn ends are safe: when they overlap the turn's changes, `/undo` refuses ("Worktree changed; nothing was undone. Conflicting files: notes.md."), and otherwise leaves them in place.

Also good to know:

- **Restarts.** Undo and redo history survive a terminal restart: resuming the session in the same worktree restores both, unless retention expired it. If file history is missing, undo falls back to moving only the conversation, with a warning.
- **Very long sessions.** The saved history holds about 9,000 turns; past that, the oldest turns can no longer be undone after the session is resumed.
- **Slow workspaces.** If a turn's first snapshot is not ready within 25 s of a tool call, the turn is recorded conversation-only and `/undo` says files were not restored.
- **Subagents** (the `task` tool, eval `agent()`, `/tan` clones) have no undo of their own. Their edits in your workspace are part of the parent turn, so undoing that turn reverts them.
- **Staged changes stay staged.** Undo/redo restores the worktree and never touches the Git index, so `git status` may show `MM` afterwards. That is expected, not corruption: see [Staged changes after undo or redo](./docs/troubleshooting.md#staged-changes-after-undo-or-redo-mm-in-git-status).
- **Interrupted undo/redo.** One cut short by a crash is settled the next time the session loads. If files were left partly restored, the warning names two snapshot hashes; follow [Restoring files after an interrupted undo or redo](./docs/troubleshooting.md#restoring-files-after-an-interrupted-undo-or-redo).

How it works inside: [docs/architecture.md](./docs/architecture.md).

## What gets stored and what isn't restored

Snapshots copy the whole worktree into plaintext Git objects in the snapshot store (`~/.omp/omp-undo-redo/repos/` by default), outside your repository, and keep them for the retention period (see [Configuration](#configuration)):

- **Git projects**: tracked files and every untracked file `.gitignore` does not exclude, such as an unignored `.env.local`. Snapshots never touch your `HEAD`, branches or index, and `git push --mirror`, `git clone --mirror`, `git bundle create --all` and `git log --all` never see them.
- **Non-Git folders** (Private-Git mode): everything except the built-in ignore list, so `.env`, `id_rsa`, `*.pem` and `credentials.json` are included. The built-in list is `.git`, `.hg`, `.svn`, `node_modules`, `.history`, `dist`, `coverage`, `.omp`, `.next`, `build`, `out`, `target`, `.vs`, `.idea`, `__pycache__`, `.venv` and `.gradle`. Each name matches at any depth, so changes inside a hand-written `docs/build/` or `out/` folder are not restored either.
- **A non-Git home directory** (or any folder above it, such as `C:\Users` or `/home`), **a drive root and the OS temp directory** get no file snapshots: Private-Git would copy `.ssh`, `AppData` and browser profiles into the store. Their subfolders are ordinary workspaces. Only your own home and temp directory are recognized; another user's home, `C:\Windows\Temp` and system folders are snapshotted like any other folder. Making such a folder a Git repository does not make it safe: Git mode then snapshots everything its `.gitignore` does not exclude.

`/undo` and `/redo` leave these as they are:

- **Ignored files.** Files matched by `.gitignore` (or, in Private-Git mode, the built-in list) are outside the snapshots: changes to them survive undo/redo untouched.
- **Nested Git repositories.** Submodules, or a folder with its own `.git` inside the workspace, are outside the snapshots. Undo/redo leaves their contents and `HEAD` as they are and names them: "…file snapshot restored, but files inside nested Git repositories are outside the snapshot and were not restored: mod."
- **Files Git could not read.** A file held open exclusively by another app while a snapshot is taken (as Visual Studio does with `.vs` databases), or without read permission, is left out of that snapshot and left as it is on disk: "…file snapshot restored, but files Git could not read when the snapshot was taken (locked by another process or no read permission) were left as they are: app.db."
- **Git LFS files whose content was pruned.** Capturing runs clean filters the way `git add` does, so Git LFS writes every filtered file a snapshot hashes, untracked ones included, to LFS storage (`.git/lfs/objects`, or the store's own `lfs/` in Private-Git mode). Only `git lfs prune` deletes those objects. Restoring a file whose LFS object was pruned fails and the restore is rolled back, unless LFS can download it again; if the file's current version was pruned too, the file is left empty.
- **Checkpoints that need rewritten history.** In Git mode, content your `HEAD` reached at capture time is shared with your repository, not copied, until a later store gc. If you rewrite that history and prune it before then (`git filter-repo` and BFG do both in one run), those checkpoints can no longer be restored, and undo/redo reports the failure instead of restoring part of them. Normal `git gc`, even with `--prune=now`, is safe.

## Configuration

Optional environment variables. Set them before starting the agent; a running process does not see later changes, and they apply to the whole process, not per project.

| Variable                       | Default                        | Meaning                                                                                                                                                                                           |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OMP_UNDO_REDO_RETENTION_DAYS` | `2`                            | Days a session's file history is kept after its last use. Fractions allowed (`0.5` = 12 hours); `0` keeps it forever. Anything that is not a non-negative number is ignored.                      |
| `OMP_UNDO_REDO_STORE_DIR`      | `~/.omp/omp-undo-redo`         | Root for snapshot stores and session history. `OMP_UNDO_REDO_BLOB_DIR` is a permanent legacy alias.                                                                                               |
| `OMP_UNDO_REDO_RUNTIME_DIR`    | `~/.omp/omp-undo-redo/runtime` | Root of the action state published for external clients. Without a store variable, the store moves with it: to its parent if the directory is named `runtime`, otherwise to the directory itself. |
| `OMP_UNDO_REDO_DEBUG`          | unset                          | `1` logs every git command to `<storeRoot>/debug.log`. Names your paths and files; see [Collecting a debug trace](./docs/troubleshooting.md#collecting-a-debug-trace).                            |

```sh
export OMP_UNDO_REDO_RETENTION_DAYS=7            # bash/zsh; add to ~/.bashrc or ~/.zshrc to persist
```

```powershell
$env:OMP_UNDO_REDO_RETENTION_DAYS = "7"          # current PowerShell session
setx OMP_UNDO_REDO_RETENTION_DAYS 7              # persistent; open a new terminal
```

Changing the store directory starts an empty store: nothing is moved, older turns can no longer restore files, and the old directory stays until you delete it. Store directories are created owner-only (`0700` on Linux and macOS; on Windows they inherit the parent folder's ACL); a root you set yourself keeps its own permissions.

**Expiry.** Cleanup runs in the background shortly after OMP starts, sweeps every store (including workspaces you never reopen), and never touches a session in use by any process. It deletes the session's snapshot refs and history; a later background `git gc` deletes the snapshot data, and neither step securely erases it. Resuming an expired session works but moves only the conversation for the expired turns, with a warning. Stores of deleted workspaces are set aside after 24 idle hours and removed 7 days later. Details: [Storage maintenance](./docs/architecture.md#storage-maintenance).

## Development

`npm run verify` runs format, lint, typecheck, tests, build and the package checks; the individual scripts are in `package.json`. Use only public OMP extension APIs, and do not commit `dist/`. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Release

Tag-triggered CI publishes; the runbook is [RELEASE.md](./RELEASE.md). Never put npm tokens or other secrets in the repository or release logs.

## Security

Read [SECURITY.md](./SECURITY.md) before reporting a vulnerability, and do not post credentials or sensitive data in a public issue. Bugs and feature requests go to the [issue tracker](https://github.com/Baylar55/omp-undo-redo/issues).

## License

Released under the [MIT License](./LICENSE). Copyright © 2026 Baylar Sadigov.
