# Troubleshooting

What to do when undo/redo leaves something unexpected behind. What the extension stores, and what it never restores, is in the README: [What gets stored and what isn't restored](../README.md#what-gets-stored-and-what-isnt-restored).

## Restoring files after an interrupted undo or redo

An `/undo` or `/redo` cut short by a killed process or a crash is settled the next time the session loads. Before restoring files, each one records what it is doing next to the session's history. If the files were fully restored, the undo/redo cursor moves to match them and a notice says so. If the restore never started, nothing changes. Loading only checks the files; it never writes them.

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

## Staged changes after undo or redo (`MM` in `git status`)

`/undo` and `/redo` are worktree operations, not staging operations. Staged changes that existed before or were created during a turn remain staged, even when navigation restores an earlier worktree snapshot. A touched path can therefore show `MM`, `AM`, `MD`, or another two-column porcelain state after navigation. `git diff --cached` shows what a commit would take from the preserved index. `git diff` shows unstaged differences between that index and the restored worktree. Inspect both views and deliberately stage the desired files before committing. The extension does not recommend an automatic `git add -A`, `git reset`, or `git restore --staged` command because each can alter unrelated staging intent.

For example, if `f.txt` is committed as `base`, a turn changes it to `turn` and stages it, and `/undo` restores the worktree to `base`, Git reports `MM f.txt`: `git diff --cached` still shows `base -> turn`, while `git diff` shows `turn -> base`. This is a visible staged/unstaged divergence, not corruption or data loss.

## Undo or redo refused: files under a symlink or junction

"Files sit under a symlink or junction, which undo never writes through; nothing was undone. Linked files: …" means the restore would reach those files through a link in the workspace, almost always a Windows junction (`mklink /J`). Git for Windows treats a junction as a plain folder, so the snapshot holds the files it points at, and restoring them would write or delete them there, outside the workspace. Nothing was written.

Deleting the link does not help: the restore then finds those files missing and refuses with "Worktree changed". Replace the link with a real folder holding the same files instead. In `cmd.exe`, from the workspace root, with `shared` the link and `C:\x` the folder it points at:

```bat
rmdir shared
robocopy C:\x shared /E
```

`rmdir` without `/S` removes only the junction, never the files it points at; robocopy exits with 1 when it copied files. Run `/undo` or `/redo` again: it now writes or deletes the copy, and `C:\x` stays as it is. Recreate the link afterwards if you still want it.

## Inspecting and deleting checkpoint refs by hand

Checkpoint refs live under `refs/omp-undo-redo/` in the snapshot store, and pending refs left by an exited process are deleted automatically (rules: [Checkpoint refs and owner leases](./architecture.md#checkpoint-refs-and-owner-leases)). For manual inspection, stop all OMP/Pi processes that use the repository, then use Git commands only, against the store (`<storeRoot>/repos/<hash>.git` for a Private-Git workspace or a Git repository; a Git-mode store records its repository in its `config` as `omp-undo-redo.commondir`):

```sh
git --git-dir=<store> for-each-ref --format="%(refname) %(objectname)" refs/omp-undo-redo/
git --git-dir=<store> update-ref -d <exact-ref> <expected-object-id>
```

Replace the placeholders with the exact ref and object ID printed by the first command. Do not delete a ref by name alone. Removing a ref makes its objects eligible for later Git reclamation; it does not immediately or securely erase the object data. Unreadable host identity or Linux runtime-scope state, malformed leases, and future ref versions remain manual-cleanup cases.

> **Warning**
> On Windows and macOS, never copy or share the `omp-undo-redo/host-id` file (in `%LOCALAPPDATA%` or `~/Library/Application Support`) between machines: cloned virtual machines, synced dotfiles, shared network homes. Two machines with the same host ID and hostname working in the same repository look like one machine, so each treats the other's live sessions as dead and deletes their pending checkpoint refs. On Linux the boot ID marks the other machine as remote, so its pending refs are removed only after it goes 7 days without refreshing them (for example, while suspended mid-turn).

## A `runtime/<pid>/` directory without `runtime.json`

A `runtime/<pid>/` directory without a `runtime.json` marker is never replaced or deleted, so a process given that pid publishes no runtime action state (logged as `runtime-dir-foreign` with `OMP_UNDO_REDO_DEBUG=1`). Undo and redo work as usual. Version 1.7.0 and earlier could leave such a directory after a crash or a shutdown that could not delete every file; it holds only `sessions/` and `.tmp` files and is safe to delete by hand.

## No runtime action state after an upgrade, a reboot or in a container

A `runtime/<pid>/` whose `runtime.json` comes from another runtime scope (another container sharing `~/.omp`, a previous boot) or from an earlier version that recorded none is not this process's to replace until its marker and its directory are both 24 h old. Until then, a process given that pid publishes no runtime action state (`runtime-dir-foreign` with `OMP_UNDO_REDO_DEBUG=1`), and undo and redo work as usual. A directory whose pid is not running in any container that shares the folder is safe to delete by hand. A directory from another hostname is never replaced or reaped. On Windows and macOS, the first start after upgrading past a version that did not record the boot treats every older directory this way.

## A snapshot store created with permissive file modes

Stores are created owner-only (`0700`, with `core.sharedRepository=0600`), but private repositories created by an earlier version keep their original object modes. If the store was ever created with a permissive umask, close every OMP and Pi process, then delete `<storeRoot>/repos`. That deletes all undo file history; the store is recreated owner-only on next use.

## Collecting a debug trace

Set `OMP_UNDO_REDO_DEBUG=1` before starting the agent to append every git command the extension runs (working directory, arguments, the environment overrides it sets, exit code, duration, and up to 8 KiB of stderr) as one JSON line to `<storeRoot>/debug.log`, along with the error of a turn whose recording failed. Lines are written synchronously, so a crash keeps the last ones. Stdin and stdout are never logged, so no file contents, but the working directory, the store paths, arguments and stderr name your folders, files and commit hashes: review the log before attaching it to an issue. The log is not rotated: turn it off once you have the trace.
