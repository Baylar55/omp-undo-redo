# Implementation Plan

## Goal

Provide predictable `/undo` and `/redo` navigation for OMP sessions with transactional file restoration when Git is available, without modifying OMP's core or promising rollback of external effects.

## Design

1. Register one compiled extension entry through the package manifest's `omp.extensions` field.
2. Observe the current session branch through the official OMP session/extension context APIs.
3. Define a completed turn as either a full Git checkpoint or a session-only checkpoint with an explicit file-checkpoint unavailability reason.
4. Navigate with OMP's tree-navigation API, allowing lifecycle cancellation to remain authoritative.
5. Apply Git file deltas only for full checkpoints; session-only checkpoints navigate session context without changing files.
6. Record checkpoints in one ordered in-memory history. Clear redo state when the user creates a new branch, reloads the extension, or performs unrelated navigation.
7. Expose exactly two argument-free slash commands: `/undo` and `/redo`.

## Compatibility and safety

- Target Node.js 20 or newer and test against OMP 16.5.2.
- Use public OMP APIs only; do not depend on internal modules or mutate session files.
- Git is required for file restoration, but session undo/redo remains available outside Git.
- Initialized unborn repositories are supported through an alternate empty index; an existing commit is not required.
- Preserve `HEAD`, branch refs, and the real Git index. Keep private checkpoint refs isolated under `refs/omp-undo-redo/`.
- Keep redo state ephemeral and validate targets before navigation.
- Report stable checkpoint failure reasons without exposing raw Git stderr.
- Document that external effects such as shell, network, editor, and ignored-file state are outside the checkpoint.

## Verification and release

Use deterministic unit and lifecycle tests for checkpoint selection, unborn repositories, session-only fallback, target validation, redo invalidation, cleanup, and command outcomes. Run type-checking, lint, formatting checks, tests, build, and package dry-run before release. Publish only the manifest-declared compiled entry and the package documentation/license files.
