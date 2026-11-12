import { rm } from "node:fs/promises";
import type * as NodeOs from "node:os";
import type * as HostIdentityModule from "../src/store/host-identity.js";
import type { HostIdentity } from "../src/store/host-identity.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

// Node's homedir() reads HOME (USERPROFILE on Windows) on every call; Bun's
// ignores runtime changes, so vi.stubEnv("HOME") would not reach src under Bun.
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof NodeOs>();
  const homedir = () =>
    process.env[process.platform === "win32" ? "USERPROFILE" : "HOME"] || os.homedir();
  return { ...os, homedir, default: { ...os, homedir } };
});

// This process's host ID file, on every platform under XDG_STATE_HOME (set
// below), so tests never read or create the user's own: macOS keeps it under
// homedir(), and stubbing HOME would also move git's global config.
vi.mock("../src/store/host-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HostIdentityModule>();
  let identity: Promise<HostIdentity> | undefined;
  const localHostIdentity = () =>
    (identity ??= actual.resolvePersistentHostId({ platform: "linux", env: process.env }));
  const localStoreHost = async () => actual.localStoreHost(await localHostIdentity());
  return { ...actual, localHostIdentity, localStoreHost };
});

// Every Git workspace gets a snapshot store under the store root, and runtime
// action state a dir under the runtime root; both default to ~/.omp. Always
// overridden: the README has users set these globally, and honoring them here
// would run tests (and housekeeping) against the real store.
// BLOB_DIR is the legacy alias of STORE_DIR; RETENTION_DAYS and DEBUG would
// change housekeeping and logging away from the defaults the suites assume.
delete process.env.OMP_UNDO_REDO_BLOB_DIR;
delete process.env.OMP_UNDO_REDO_RETENTION_DAYS;
delete process.env.OMP_UNDO_REDO_DEBUG;
const storeRoot = join(tmpdir(), `omp-undo-redo-test-store-${process.pid}`);
const runtimeRoot = join(tmpdir(), `omp-undo-redo-test-runtime-${process.pid}`);
const stateRoot = join(tmpdir(), `omp-undo-redo-test-state-${process.pid}`);
process.env.OMP_UNDO_REDO_STORE_DIR = storeRoot;
process.env.OMP_UNDO_REDO_RUNTIME_DIR = runtimeRoot;
// Where the host-identity mock above keeps the host-id file; also the default
// location on Windows and Linux, for any direct `resolvePersistentHostId()`.
process.env.LOCALAPPDATA = stateRoot;
process.env.XDG_STATE_HOME = stateRoot;
// Fixtures write loose ref files and packed-refs locks, files-backend concepts;
// a machine whose git default is reftable would break them.
process.env.GIT_DEFAULT_REF_FORMAT = "files";
// Detached sweeps may still hold them open on Windows; a leftover temp dir is harmless.
afterAll(() =>
  Promise.all(
    [storeRoot, runtimeRoot, stateRoot].map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}),
    ),
  ),
);

// Snapshot index leases live in %TEMP%/omp-undo-redo-index-* until
// session_shutdown, which most suites never emit. Each test file runs in its
// own worker process, so its leases are all released here. Imported late:
// a static import would load index-leases.js before a suite's vi.mock applies.
afterAll(async () => {
  const { releaseAllPersistentSnapshotIndices } = await import("../src/snapshot/index-leases.js");
  await releaseAllPersistentSnapshotIndices();
});
