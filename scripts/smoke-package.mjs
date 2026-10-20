// Packs the package, checks the tarball's file set and loads every declared entry
// from the extracted tarball, so a "files", "main", "exports" or extensions
// regression fails here instead of being published. Run after `npm run build`.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));

// Listed here, not read from package.json "files", so dropping one from "files" fails.
// A new shipped top-level file goes in ROOT_FILES, a new shipped directory in TREE_DIRS.
const ROOT_FILES = [
  "package.json",
  "index.js",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "SECURITY.md",
];
const TREE_DIRS = ["dist", "docs"];
// Names npm always strips (checked against `npm pack --dry-run`, npm 11); not expected.
const NPM_STRIPPED =
  /^(\.DS_Store|\._.*|.*\.orig|\..*\.swp|npm-debug\.log|\.npmrc|\.gitignore|\.npmignore|\.lock-wscript|\.wafpickle-.*|\.git|\.svn|\.hg|CVS|archived-packages)$/;
// npm strips config.gypi only under build/; elsewhere it ships.
const NPM_STRIPPED_PATH = /(^|\/)build\/config\.gypi$/;
// OS junk npm does ship: kept out of `expected`, so a packed copy fails as Unexpected.
// Case-insensitive: Windows creates these in any case.
const OS_JUNK = /^(Thumbs\.db|desktop\.ini)$/i;

async function walk(dir, rel) {
  const out = [];
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    const path = `${rel}/${entry.name}`;
    if (NPM_STRIPPED.test(entry.name) || NPM_STRIPPED_PATH.test(path) || OS_JUNK.test(entry.name))
      continue;
    out.push(...(entry.isDirectory() ? await walk(dir, path) : [path]));
  }
  return out;
}

// Minimal ustar reader: regular files only, plus pax `path=` overrides for long names.
function untar(buf) {
  const files = new Map();
  let paxPath;
  for (let off = 0; off + 512 <= buf.length;) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) => {
      const raw = header.subarray(start, start + len);
      const end = raw.indexOf(0);
      return raw.toString("utf8", 0, end === -1 ? len : end);
    };
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
      continue;
    }
    if (type === "g") continue;
    const prefix = field(345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    paxPath = undefined;
    if (type === "0" || type === "") files.set(name, body);
    else throw new Error(`Unexpected tar entry type '${type}' for ${name}.`);
  }
  return files;
}

function smokeEntry(label, factory) {
  if (typeof factory !== "function") throw new Error(`${label} has no default export function.`);
  const registered = new Set();
  factory({
    on() {},
    registerCommand(name, config) {
      if (typeof config?.handler !== "function") {
        throw new Error(`${label}: command '${name}' registered without a callable handler.`);
      }
      registered.add(name);
    },
  });
  for (const name of ["undo", "redo"]) {
    if (!registered.has(name))
      throw new Error(`${label}: required command '${name}' was not registered.`);
  }
}

const expected = new Set(ROOT_FILES);
for (const dir of TREE_DIRS) for (const file of await walk(root, dir)) expected.add(file);

const tmp = await mkdtemp(join(tmpdir(), "omp-undo-redo-pack-"));
try {
  // shell: npm is npm.cmd on Windows. The destination goes through env, so no path is shell-parsed.
  // --ignore-scripts: pack the dist just built instead of rebuilding it in prepack.
  const pack = spawnSync("npm pack --json --ignore-scripts", {
    cwd: root,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, npm_config_pack_destination: tmp },
  });
  if (pack.status !== 0) {
    throw new Error(
      `npm pack failed (${pack.error?.message ?? `exit ${pack.status}`}):\n${pack.stderr}`,
    );
  }
  const [{ filename }] = JSON.parse(pack.stdout);
  const entries = untar(gunzipSync(await readFile(join(tmp, filename))));

  const packed = new Map();
  for (const [name, body] of entries) {
    if (!name.startsWith("package/")) throw new Error(`Tarball entry outside package/: ${name}`);
    packed.set(name.slice("package/".length), body);
  }
  const missing = [...expected].filter((file) => !packed.has(file));
  const unexpected = [...packed.keys()].filter((file) => !expected.has(file));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Packed file set is wrong.\nMissing: ${missing.join(", ") || "none"}\nUnexpected: ${unexpected.join(", ") || "none"}`,
    );
  }

  // Every name is in `expected` (built from our own tree), so these writes stay under pkgDir.
  const pkgDir = join(tmp, "package");
  for (const [file, body] of packed) {
    await mkdir(dirname(join(pkgDir, file)), { recursive: true });
    await writeFile(join(pkgDir, file), body);
  }

  const pkg = JSON.parse(packed.get("package.json").toString("utf8"));
  for (const key of ["omp", "pi"]) {
    if (!Array.isArray(pkg[key]?.extensions) || pkg[key].extensions.length === 0) {
      throw new Error(`package.json ${key}.extensions must list at least one entry.`);
    }
  }
  const typeFields = [
    ["types", pkg.types],
    ['exports["."].types', pkg.exports?.["."]?.types],
  ];
  const entryFields = [
    ["main", pkg.main],
    ['exports["."].default', pkg.exports?.["."]?.default],
    ...pkg.omp.extensions.map((entry, i) => [`omp.extensions[${i}]`, entry]),
    ...pkg.pi.extensions.map((entry, i) => [`pi.extensions[${i}]`, entry]),
  ];
  for (const [field, value] of [...typeFields, ...entryFields]) {
    if (typeof value !== "string") throw new Error(`package.json ${field} is missing.`);
    if (!packed.has(value.replace(/^\.\//, "")))
      throw new Error(`package.json ${field} (${value}) is not packed.`);
  }
  const entryPaths = new Set(["./index.js", ...entryFields.map(([, value]) => value)]);
  for (const entry of entryPaths) {
    const mod = await import(pathToFileURL(join(pkgDir, entry)).href);
    smokeEntry(`Packed entry ${entry}`, mod.default);
  }

  console.log(
    `Packed package smoke test passed (${packed.size} files, entries: ${[...entryPaths].join(", ")}).`,
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
