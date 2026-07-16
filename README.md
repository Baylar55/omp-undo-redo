# OMP Undo/Redo

A small Oh My Pi (OMP) extension for moving through the current session's conversation tree. It adds two slash commands without changing OMP's files or session format.

## Requirements

- Node.js 20 or newer.
- Oh My Pi 16.5.2. This extension was tested against OMP 16.5.2; other OMP releases are not guaranteed.

## Installation

Install `@baylarsadigov/omp-undo-redo` from npm, then let OMP discover the extension through the package's plugin manifest. The published manifest contains:

```sh
npm install @baylarsadigov/omp-undo-redo
```

```json
{
  "omp": {
    "extensions": ["./dist/index.js"]
  }
}
```

Do not add a second entry for the extension when the package manifest is already being used. OMP loads the compiled entry through that manifest; no source checkout or undocumented OMP command is required.

## Usage

The extension exposes exactly these commands:

- `/undo` — move to the latest user-prompt boundary, removing that prompt's assistant/tool activity from the active context. The prompt itself remains as the supported OMP session-tree boundary. If the current context is already at that boundary, it reports that undo is unavailable.
- `/redo` — restore the most recently undone context checkpoint. Redo is single-use in order: after a new branch or any navigation that is not the matching redo, the in-memory redo history is cleared.

Commands take no arguments. They navigate OMP's session tree through the official extension API and do not create a new model turn.
Both commands wait for the current agent turn to become idle; if OMP remains busy, the command leaves the session unchanged and shows a warning.

## Limitations

Undo/redo changes session-tree position only. It does **not** revert files, shell commands, network requests, editor state, or any other external effect. Redo history is kept in memory and is reset when OMP or the extension is reloaded; it is not persisted to disk. Navigation can also be cancelled by OMP lifecycle handlers.

## Development

Install dependencies with npm, then use the scripts in `package.json`:

- `npm run build` compiles `src/` to `dist/`.
- `npm run typecheck` checks TypeScript without emitting files.
- `npm test` runs the deterministic test suite.
- `npm run lint` and `npm run format:check` check style.
- `npm run verify` runs the repository verification sequence.

The implementation uses only public OMP extension APIs. Keep changes focused, preserve the package manifest, and do not commit generated `dist/` output unless a release process explicitly requires it.

## Release

A release consists of a reviewed change, a clean verification run, an updated `CHANGELOG.md` entry, and a published npm package containing `dist/`, `README.md`, `LICENSE`, and `CHANGELOG.md`. The package manifest is the source of truth for the extension entry point and peer compatibility. Never place npm tokens, registry credentials, or other secrets in the repository or release logs.

## Security

Please read [SECURITY.md](./SECURITY.md) before reporting a vulnerability. Do not disclose credentials or sensitive data in a public issue. For normal bugs and feature requests, use the [GitHub issue tracker](https://github.com/baylarsadigov/omp-undo-redo/issues).

## License

Released under the [MIT License](./LICENSE). Copyright © 2026 Baylar Sadigov.
