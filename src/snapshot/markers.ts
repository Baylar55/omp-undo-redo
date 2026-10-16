import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

/** Commit-message line holding, base64-encoded, the `core.excludesFile` and
 *  `info/exclude` rules a snapshot was captured under (in that order, so the
 *  later `info/exclude` wins as in git). Neither file lives in the tree, and a
 *  turn can edit either: restores check paths against the recorded rules
 *  (`recordedExcludeRules`), not just today's. Absent when there were none. */
export const EXCLUDE_RULES_LINE = "Exclude rules: ";

const UTF8_BOM = "\xEF\xBB\xBF";

/** Base64 of the effective exclude rules for `git`'s next `add`, comment and
 *  empty lines dropped; "" when there are none or git cannot name the files,
 *  which restores read like a snapshot taken before the rules were recorded.
 *  `env`: the env that `add` runs with. A file git cannot read counts as
 *  empty, as git skips it too. */
export async function excludeRules(git: GitRunner, env?: Record<string, string>): Promise<string> {
  const xdg = git.env?.XDG_CONFIG_HOME || process.env.XDG_CONFIG_HOME;
  const fallback = xdg ? join(xdg, "git", "ignore") : "~/.config/git/ignore";
  const [paths, global] = await Promise.all([
    invoke(git, ["rev-parse", "--show-toplevel", "--git-path", "info/exclude"], { env }),
    invoke(git, ["config", "--path", "--default", fallback, "--get", "core.excludesFile"], { env }),
  ]);
  if (paths.error || paths.code !== 0 || global.error || global.code !== 0) return "";
  const [top, exclude] = paths.stdout.split("\n").map((line) => line.trim());
  if (!top || !exclude) return "";
  // `--git-path` is relative to the cwd; git reads a relative excludesFile from the top.
  const files = [resolve(top, global.stdout.trim()), resolve(git.cwd ?? process.cwd(), exclude)];
  const contents = await Promise.all(files.map((file) => readFile(file, "latin1").catch(() => "")));
  // Latin-1 maps bytes 1:1, so any rule bytes survive the round trip.
  const rules = contents
    .map((text) => (text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text))
    .join("\n")
    .split("\n")
    .filter((line) => line.replace(/\r$/, "") !== "" && !line.startsWith("#"));
  return rules.length > 0 ? Buffer.from(rules.join("\n"), "latin1").toString("base64") : "";
}

/** The rules `excludeRules` recorded in `commit`'s message, empty when it
 *  recorded none; null when the commit is unreadable. Only the last line
 *  counts: `snapshotMessage` writes it there, after every path line. */
export async function recordedExcludeRules(git: GitRunner, commit: string): Promise<Buffer | null> {
  const object = await invoke(git, ["cat-file", "commit", commit]);
  if (object.error || object.code !== 0) return null;
  const last = object.stdout.trimEnd().split("\n").at(-1)!;
  return Buffer.from(
    last.startsWith(EXCLUDE_RULES_LINE) ? last.slice(EXCLUDE_RULES_LINE.length) : "",
    "base64",
  );
}

/** Paths a snapshot left out, relative to the worktree root. */
export interface OutsideSnapshot {
  nestedRepositories: string[];
  unreadableFiles: string[];
}

export function snapshotMessage(message: string, outside: OutsideSnapshot, rules = ""): string {
  const lines = [
    AUTOCRLF_OFF_LINE,
    ...outside.nestedRepositories.map((path) => `${NESTED_REPOSITORY_LINE}${path}`),
    ...outside.unreadableFiles.map((path) => `${UNREADABLE_FILE_LINE}${path}`),
    ...(rules ? [`${EXCLUDE_RULES_LINE}${rules}`] : []),
  ];
  return `${message}\n\n${lines.join("\n")}`;
}
