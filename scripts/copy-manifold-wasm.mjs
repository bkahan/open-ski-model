// Copies manifold-3d's WASM binary into public/ so the browser can fetch
// it at /manifold.wasm. Runs on install and before dev/build.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const src = require.resolve("manifold-3d/manifold.wasm");
const root = dirname(fileURLToPath(import.meta.url));
const dest = join(root, "..", "public", "manifold.wasm");
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
