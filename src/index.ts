import "./infra/compat.js";

export { default } from "./extension.js";
export type { OmpUndoRedoDependencies } from "./extension.js";

/** @deprecated Internal, test-only; removed from the package entry in the next major. */
export { readRetentionDays } from "./history/retention.js";
/** @deprecated Internal, test-only; removed from the package entry in the next major. */
export { resolveBackend } from "./store/backend.js";
