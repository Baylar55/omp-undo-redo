# Security Policy

## Supported versions

Only the latest published version is supported. The extension is tested with OMP 16.5.2 and Node.js 20 or newer.

## Reporting a vulnerability

Please do not report security vulnerabilities in a public issue. Use the repository's GitHub security advisory/private reporting feature: <https://github.com/Baylar55/omp-undo-redo/security/advisories/new>.

Include a concise description, affected version, reproduction steps, impact, and any proposed mitigation. Remove tokens, credentials, private session data, and unrelated personal information before sending a report. If the private channel is unavailable, open a minimal issue asking for a private contact without including vulnerability details.

Maintainers will acknowledge reports when practical, investigate, and coordinate disclosure after a fix or mitigation is available. Please allow reasonable time for triage before public disclosure.

## Scope

The extension navigates OMP's in-memory session tree and restores worktree file contents between recorded checkpoints. It does not promise to roll back shell commands, network requests, editor state, or other external effects. Reports about those limitations are not security vulnerabilities, but may be filed as normal issues when they describe a reproducible defect.

## Snapshot storage

Checkpoints hold verbatim file content. In Git workspaces they capture tracked and untracked non-ignored files (bound by the repository's `.gitignore`, so an unignored `.env.local` is included) and live outside the repository, in a snapshot store under `<storeRoot>/repos/<sha256(commonDir)>.git` that borrows the objects the repository's `HEAD` reaches (`GIT_ALTERNATE_OBJECT_DIRECTORIES`) and holds everything else: no snapshot ref or snapshot-only object is ever written to the repository, so `git push --mirror`, `git clone --mirror`, `git bundle create --all` and `git log --all` cannot export or show them. Snapshots that versions before this layout wrote into the repository (`refs/omp-undo-redo/`, `.git/omp-undo-redo/`) are moved into the store and deleted from the repository on the next session start in it; until then an all-refs push still exports them. In non-Git workspaces (Private-Git mode) they live under `<storeRoot>/repos/<sha256(cwd)>.git` and, because such a workspace rarely has a `.gitignore`, they capture every file outside the built-in ignore list — including `.env`, private keys, and credential files — in plaintext for the retention window (`OMP_UNDO_REDO_RETENTION_DAYS`, default 2 days). Both kinds of store follow the same expiry: it is enforced when OMP next starts a session, in any workspace, after the window lapses; the background `git gc` that follows deletes the objects. Stores evicted because their workspace or repository vanished stay as `.evicted-<timestamp>` trash for a further 7 days.

The store root and its `repos/` directory are therefore created owner-only (`0700`, POSIX; Windows uses the inherited ACL) and each store sets `core.sharedRepository=0600`. Private repositories created by an earlier version kept the process umask's modes: on a shared host, remove `<storeRoot>/repos` once so it is recreated hardened.
