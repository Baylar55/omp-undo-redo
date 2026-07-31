import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(rootDir, "src");
const distDir = join(rootDir, "dist");

async function getFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function normalizePath(p) {
  return p.replace(/\\/g, "/");
}

const srcFiles = await getFiles(srcDir);
const expectedDistFiles = new Set();

for (const srcFile of srcFiles) {
  const rel = normalizePath(relative(srcDir, srcFile));
  if (rel.endsWith(".ts")) {
    const base = rel.slice(0, -3);
    expectedDistFiles.add(`dist/${base}.js`);
    expectedDistFiles.add(`dist/${base}.d.ts`);
  }
}

const actualDistFilesRaw = await getFiles(distDir);
const actualDistFiles = new Set(actualDistFilesRaw.map((f) => normalizePath(relative(rootDir, f))));

const missing = [...expectedDistFiles].filter((f) => !actualDistFiles.has(f)).sort();
const unexpected = [...actualDistFiles].filter((f) => !expectedDistFiles.has(f)).sort();

if (missing.length > 0 || unexpected.length > 0) {
  console.error("Build output parity check failed:");
  if (missing.length > 0) {
    console.error("Missing expected dist files:");
    for (const f of missing) {
      console.error(`  - ${f}`);
    }
  }
  if (unexpected.length > 0) {
    console.error("Unexpected dist files:");
    for (const f of unexpected) {
      console.error(`  - ${f}`);
    }
  }
  process.exit(1);
}

console.log("Build output parity check passed.");
