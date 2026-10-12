export type RefSpec = { ref: string; expectedHash: string };

/** Parses `for-each-ref --format=%(refname)%00%(objectname)` output. Null when
 *  a line does not hold exactly one NUL: a malformed listing must never be
 *  mistaken for "no refs are present". */
export function parseRefLines(stdout: string): RefSpec[] | null {
  const refs: RefSpec[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("\0");
    if (separator < 0 || line.indexOf("\0", separator + 1) >= 0) return null;
    refs.push({ ref: line.slice(0, separator), expectedHash: line.slice(separator + 1) });
  }
  return refs;
}
