# OMP Undo/Redo

[![npm version](https://img.shields.io/npm/v/%40baylarsadigov%2Fomp-undo-redo)](https://www.npmjs.com/package/@baylarsadigov/omp-undo-redo)
[![CI](https://github.com/Baylar55/omp-undo-redo/actions/workflows/ci.yml/badge.svg)](https://github.com/Baylar55/omp-undo-redo/actions/workflows/ci.yml)

`/undo` and `/redo` for [Oh My Pi (OMP)](https://omp.sh) and [Pi](https://pi.dev). `/undo` takes the conversation back to your last prompt and puts your files back as they were before that turn; `/redo` goes forward again. No changes to the agent's source or session format.

Know this before relying on it:

- **Snapshots are plaintext copies of your worktree**, kept outside the repository: in Git projects, unignored files such as `.env.local`; in non-Git folders, `.env` and private keys too. They are deleted 2 days (configurable) after the session's last use, not securely erased.
- **`/undo` reverts every file changed during the turn**, including edits from your editor or a build watcher, and lists what it restored.
- **Not restored:** ignored files, nested Git repositories, files locked by another program, Git LFS content removed by `git lfs prune`. A turn that touched files under a symlink or Windows junction cannot be undone or redone until the link is replaced.
- **No file snapshots** in a non-Git home directory, drive root or temp directory: only the conversation moves back.

Details: [What gets stored and what isn't restored](#what-gets-stored-and-what-isnt-restored). Problems: [Troubleshooting](./docs/troubleshooting.md).

## Installation

Requires OMP 18.3.2+ (extensions run under Bun) or Pi with Node.js 20+, and Git. Without Git, or if the snapshot store cannot be set up, undo/redo moves only the conversation; you are told once per session and setup is retried every turn.

Install through the agent; a plain `npm install` does not register the extension.

```sh
# OMP
omp plugin install @baylarsadigov/omp-undo-redo
omp plugin install @baylarsadigov/omp-undo-redo@1.7.0   # pin a release

# Pi
pi install npm:@baylarsadigov/omp-undo-redo
pi install npm:@baylarsadigov/omp-undo-redo@1.7.0       # pin a release
pi update --extensions                                  # update
```

In Pi, confirm with `pi list` and restart the TUI; `/undo` and `/redo` then appear in slash-command completion.

## Usage

- `/undo` goes back to the latest prompt, dropping the assistant's reply and tool activity and restoring the files changed in that turn. The prompt itself stays in the session tree.
- `/redo` reapplies the last undo. A new prompt or any other successful tree or session navigation clears redo history; `/undo`, `/redo`, and cancelled or no-op navigation keep it.

Neither command takes arguments or starts a model turn. Both wait for the agent to become idle, and up to 3 s for an in-flight snapshot; if either stays busy, nothing changes and you get a warning.

Snapshots are taken when a turn starts and when it ends, so anything that changes a file mid-turn (a formatter on save, another OMP process in the same repository) is reverted with the agent's edits. Check the restored-file list ("Restored files: notes.md, src/app.ts.") for files the agent did not touch. Edits made after the turn are safe: if they overlap the turn's changes, `/undo` refuses and names the conflicting files; otherwise they stay in place.

- **Restarts:** history survives resuming the session in the same worktree until retention expires. If file history is missing, undo moves only the conversation, with a warning.
- **Subagents** (`task`, eval `agent()`, `/tan`) have no undo of their own; their edits belong to the parent turn.
- **Staged changes stay staged:** the Git index is never touched, so `git status` may show `MM`. See [Staged changes after undo or redo](./docs/troubleshooting.md#staged-changes-after-undo-or-redo-mm-in-git-status).
- **Interrupted undo/redo** is settled on the next session load. If files were left partly restored, follow [Restoring files after an interrupted undo or redo](./docs/troubleshooting.md#restoring-files-after-an-interrupted-undo-or-redo).
- **Limits:** about 9,000 turns of history survive a resume. A turn whose first snapshot is not ready within 25 s of a tool call is recorded conversation-only.

Internals: [docs/architecture.md](./docs/architecture.md).

## What gets stored and what isn't restored

Snapshots are plaintext Git objects in the store (`~/.omp/omp-undo-redo/repos/` by default), kept for the [retention period](#configuration):

- **Git projects:** tracked files plus untracked files `.gitignore` does not exclude. Your `HEAD`, branches and index are never touched, and mirror push/clone, `git bundle create --all` and `git log --all` never see the snapshots.
- **Non-Git folders:** everything except the built-in ignore list (`.git`, `.hg`, `.svn`, `node_modules`, `.history`, `dist`, `coverage`, `.omp`, `.next`, `build`, `out`, `target`, `.vs`, `.idea`, `__pycache__`, `.venv`, `.gradle`), matched at any depth. So `.env`, `id_rsa`, `*.pem` are included, and a hand-written `docs/build/` is not.
- **Through a Windows junction** (`mklink /J`): Git reads it as a plain folder, so snapshots also copy the files it points at, even outside the workspace. Directory symlinks are stored as links and never followed.
- **Skipped entirely:** your own home directory without Git (and folders above it such as `C:\Users` or `/home`), drive roots and your OS temp directory, since snapshotting would copy `.ssh`, `AppData` and browser profiles. Their subfolders are normal workspaces. Running `git init` there does not make it safe: Git mode then snapshots everything not gitignored.

Left as they are by `/undo` and `/redo`:

- **Ignored files:** matched by `.gitignore` or the built-in list.
- **Nested Git repositories and submodules:** contents and `HEAD` untouched; the result names them.
- **Files Git could not read** at snapshot time (locked, e.g. Visual Studio's `.vs` databases, or no read permission); the result names them.
- **Pruned Git LFS files:** snapshotting runs clean filters like `git add`, writing LFS objects to `.git/lfs/objects` (or the store's `lfs/` for non-Git folders). If `git lfs prune` removed one and LFS cannot download it again, the restore is rolled back; if the file's current version was pruned too, it is left empty.
- **Rewritten history:** in Git mode, content reachable from `HEAD` is shared with your repository until the next store gc. Rewriting and pruning it before then (`git filter-repo`, BFG) makes those checkpoints unrestorable; undo/redo reports the failure rather than restoring part of them. Normal `git gc --prune=now` is safe.

Refused whole: an undo or redo that would write, create or delete a file under a symlink or junction in the workspace writes nothing and names those files. See [Undo or redo refused: files under a symlink or junction](./docs/troubleshooting.md#undo-or-redo-refused-files-under-a-symlink-or-junction).

## Configuration

Optional environment variables, read once at startup and applied process-wide (e.g. `export OMP_UNDO_REDO_RETENTION_DAYS=7`, or `setx OMP_UNDO_REDO_RETENTION_DAYS 7` on Windows, then open a new terminal).

| Variable                       | Default                        | Meaning                                                                                                                                                                                    |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OMP_UNDO_REDO_RETENTION_DAYS` | `2`                            | Days file history is kept after a session's last use. Fractions allowed; `0` keeps it forever; invalid values are ignored.                                                                 |
| `OMP_UNDO_REDO_STORE_DIR`      | `~/.omp/omp-undo-redo`         | Store and history root (legacy alias `OMP_UNDO_REDO_BLOB_DIR`). Changing it starts an empty store: older turns can no longer restore files, and the old directory is not moved or deleted. |
| `OMP_UNDO_REDO_RUNTIME_DIR`    | `~/.omp/omp-undo-redo/runtime` | Action state for external clients. Without a store variable, the store follows it: to its parent if the directory is named `runtime`, otherwise to itself.                                 |
| `OMP_UNDO_REDO_DEBUG`          | unset                          | `1` logs every git command, including your paths, to `<storeRoot>/debug.log`. See [Collecting a debug trace](./docs/troubleshooting.md#collecting-a-debug-trace).                          |

Store directories are created owner-only (`0700` on Linux/macOS; on Windows they inherit the parent's ACL); a root you set yourself keeps its permissions.

**Expiry** runs in the background shortly after startup, covers every store, and never touches a session in use. Expired turns resume conversation-only, with a warning. Stores of deleted workspaces are set aside after 24 idle hours and removed 7 days later. Details: [Storage maintenance](./docs/architecture.md#storage-maintenance).

## Contributing

`npm run verify` runs format, lint, typecheck, tests, build and package checks. Use only public OMP extension APIs and do not commit `dist/`. See [CONTRIBUTING.md](./CONTRIBUTING.md); releases follow [RELEASE.md](./RELEASE.md) (never commit npm tokens or secrets). Report vulnerabilities per [SECURITY.md](./SECURITY.md), not in public issues; bugs and feature requests go to the [issue tracker](https://github.com/Baylar55/omp-undo-redo/issues).

## License

[MIT](./LICENSE). Copyright © 2026 Baylar Sadigov.
