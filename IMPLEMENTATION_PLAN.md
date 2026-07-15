# Implementation Plan

## Goal

Provide predictable `/undo` and `/redo` navigation for OMP sessions without modifying OMP's core or promising rollback of external effects.

## Design

1. Register one compiled extension entry through the package manifest's `omp.extensions` field.
2. Observe the current session branch through the official OMP session/extension context APIs.
3. Define an undo checkpoint as the entry immediately before the latest completed user interaction.
4. Navigate with OMP's tree-navigation API, allowing lifecycle cancellation to remain authoritative.
5. Record only valid navigation targets in an in-memory redo state. Clear that state when the user creates a new branch, reloads the extension, or performs unrelated navigation.
6. Expose exactly two argument-free slash commands: `/undo` and `/redo`.

## Compatibility and safety

- Target Node.js 20 or newer and test against OMP 16.5.2.
- Use public OMP APIs only; do not depend on internal modules or mutate session files.
- Keep redo state ephemeral and validate targets before navigation.
- Document that files and other external effects are never reverted.

## Verification and release

Use deterministic unit tests for checkpoint selection, target validation, redo invalidation, and command outcomes. Run type-checking, lint, formatting checks, tests, build, and package dry-run before release. Publish only the manifest-declared compiled entry and the package documentation/license files.
