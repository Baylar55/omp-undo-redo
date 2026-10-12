import type { GitRunner } from "../types.js";
import { invoke } from "../infra/git-runner.js";

/** Commit-message lines naming paths a snapshot left out: a nested repository
 *  with no commit, and a file git could not read (locked by another process,
 *  no read permission), whose tree entry is stale or missing. */
export const NESTED_REPOSITORY_LINE = "Nested repository outside snapshot: ";

export const UNREADABLE_FILE_LINE = "Unreadable file outside snapshot: ";

/** Commit-message line of a snapshot captured with `core.autocrlf=false`:
 *  a file no text/eol attribute covers is stored as its bytes on disk.
 *  Snapshots without it went through the repository's `core.autocrlf`, and
 *  are restored through it. */
export const AUTOCRLF_OFF_LINE = "Captured with core.autocrlf=false";

/** The repository's effective `core.autocrlf`, null when git cannot run. */
export async function autocrlfSetting(git: GitRunner): Promise<"true" | "input" | "false" | null> {
  const result = await invoke(git, ["config", "--get", "core.autocrlf"]);
  if (result.error) return null;
  if (result.code !== 0) return "false";
  const value = result.stdout.trim().toLowerCase();
  if (value === "input") return "input";
  // Git's boolean spellings; a bare key means true.
  return ["false", "no", "off", "0"].includes(value) ? "false" : "true";
}

/** `-c` args that write files the way `addWorktree` read them: no
 *  `core.autocrlf` conversion for files no attribute covers, while text
 *  attributes keep the line ending `setting` gave them (`core.autocrlf`
 *  overrides `core.eol` for those: true writes CRLF, input LF). */
export function autocrlfOffConfig(setting: "true" | "input" | "false"): string[] {
  const eol = { true: ["-c", "core.eol=crlf"], input: ["-c", "core.eol=lf"], false: [] }[setting];
  return ["-c", "core.autocrlf=false", ...eol];
}

/** Paths a snapshot left out, relative to the worktree root. */
export interface OutsideSnapshot {
  nestedRepositories: string[];
  unreadableFiles: string[];
}

export function snapshotMessage(message: string, outside: OutsideSnapshot): string {
  const lines = [
    AUTOCRLF_OFF_LINE,
    ...outside.nestedRepositories.map((path) => `${NESTED_REPOSITORY_LINE}${path}`),
    ...outside.unreadableFiles.map((path) => `${UNREADABLE_FILE_LINE}${path}`),
  ];
  return `${message}\n\n${lines.join("\n")}`;
}
