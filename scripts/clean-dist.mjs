import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const distPath = fileURLToPath(new URL("../dist", import.meta.url));
await rm(distPath, { recursive: true, force: true });
