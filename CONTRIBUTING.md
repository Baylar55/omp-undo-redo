# Contributing

Thanks for helping improve OMP Undo/Redo. Contributions should preserve the narrow scope of the extension: session-tree navigation and Git-backed or blob-backed file restoration, using public OMP extension APIs.

## Before opening a change

1. Read `README.md` and the applicable policy documents. Read `RELEASE.md` before a release change.
2. Open an issue for substantial behavior changes so the command contract can be agreed first.
3. Do not include npm credentials, API keys, session transcripts, or other private data in commits, tests, or issue reports.

## Development

Use Node.js 20 or newer. Install dependencies with npm and use the existing scripts in `package.json`; do not modify the OMP dependency package under `package/`. Keep source changes under `src/` and tests under `test/` (or the existing test layout).

At minimum, run the focused tests and type-check for the area you changed. Before submitting a release-oriented change, run `npm run verify`. Do not commit generated files, coverage output, local configuration, or credentials.

## Releases

Follow [`RELEASE.md`](./RELEASE.md) for version changes, protected-branch integration, Git tags, GitHub Releases, and npm publication. The runbook is the source of truth for maintainers and AI agents.

## Pull requests

- Explain the user-visible behavior and any compatibility impact.
- Add or update deterministic tests for new observable behavior.
- Keep `/undo` and `/redo` semantics and their documented limitations accurate.
- Keep documentation and `CHANGELOG.md` consistent with the implementation.
- Ensure CI passes and request review from a maintainer.

By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Security issues must follow [SECURITY.md](./SECURITY.md), not the public issue tracker.
