# OMP Undo/Redo

[![npm version](https://img.shields.io/npm/v/%40baylarsadigov%2Fomp-undo-redo)](https://www.npmjs.com/package/@baylarsadigov/omp-undo-redo)
[![CI](https://github.com/Baylar55/omp-undo-redo/actions/workflows/ci.yml/badge.svg)](https://github.com/Baylar55/omp-undo-redo/actions/workflows/ci.yml)

Official npm package: [@baylarsadigov/omp-undo-redo](https://www.npmjs.com/package/@baylarsadigov/omp-undo-redo)

A small Oh My Pi (OMP) extension for moving through the current session's conversation tree. It adds two slash commands without changing OMP's files or session format.

## Requirements

- Node.js 20 or newer.
- Oh My Pi 16.5.2. This extension was tested against OMP 16.5.2; other OMP releases are not guaranteed.

## Installation

Install the extension through OMP's plugin manager. Running `npm install` in an arbitrary project only downloads the package; it does not register the extension with OMP:

```sh
omp plugin install @baylarsadigov/omp-undo-redo
```

To pin an exact release:

```sh
omp plugin install @baylarsadigov/omp-undo-redo@1.0.15
```

To update an existing installation, run the same command with the new version, or use:

```sh
omp plugin upgrade @baylarsadigov/omp-undo-redo
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

## Usage

The extension exposes exactly these commands:

- `/undo` — move to the latest user-prompt boundary, removing that prompt's assistant/tool activity from the active context. The prompt itself remains as the supported OMP session-tree boundary. If the current context is already at that boundary, it reports that undo is unavailable.
- `/redo` — restore the most recently undone context checkpoint. Redo is single-use in order: after a new branch or any navigation that is not the matching redo, the in-memory redo history is cleared.

Commands take no arguments. They navigate OMP's session tree through the official extension API and do not create a new model turn.
Both commands wait for the current agent turn to become idle; if OMP remains busy, the command leaves the session unchanged and shows a warning.

## Limitations

Undo/redo uses temporary Git checkpoints around each turn, then mixed-resets the active branch back to its original `HEAD`. Restoring a checkpoint returns files to the exact before/after state while leaving the branch history unchanged and keeping local changes unstaged. It does not revert shell commands, network requests, editor state, or other external effects. Checkpoints are kept in memory and reset when OMP or the extension is reloaded. Navigation can also be cancelled by OMP lifecycle handlers.

## Development

Install dependencies with npm, then use the scripts in `package.json`:

- `npm run build` compiles `src/` to `dist/`.
- `npm run typecheck` checks TypeScript without emitting files.
- `npm test` runs the deterministic test suite.
- `npm run lint` and `npm run format:check` check style.
- `npm run verify` runs the repository verification sequence.

The implementation uses only public OMP extension APIs. Keep changes focused, preserve the package manifest, and do not commit generated `dist/` output unless a release process explicitly requires it.

## Release

A release consists of a reviewed change, a clean verification run, an updated `CHANGELOG.md` entry, and a published npm package containing `index.js`, `dist/`, `README.md`, `LICENSE`, and `CHANGELOG.md`. The package manifest is the source of truth for the extension entry point and peer compatibility. Never place npm tokens, registry credentials, or other secrets in the repository or release logs.

## Security

Please read [SECURITY.md](./SECURITY.md) before reporting a vulnerability. Do not disclose credentials or sensitive data in a public issue. For normal bugs and feature requests, use the [GitHub issue tracker](https://github.com/Baylar55/omp-undo-redo/issues).

## License

Released under the [MIT License](./LICENSE). Copyright © 2026 Baylar Sadigov.
