#!/usr/bin/env node
// Greps target src/ directories for any `@opentelemetry/*` import. Matches
// `from "@opentelemetry/..."`, `require("@opentelemetry/...")`, and dynamic
// `import("@opentelemetry/...")` syntax — pure-prose mentions inside backticked
// comments do not match. Exits 1 with a list of files+lines if any are found.
//
// OTel was removed in 0.2.0-beta.0 (see
// plans/260629-0501-drop-otel-from-openbox-copilotkit-sdk/). This guard
// mirrors check-no-mastra-imports.mjs and prevents re-introduction via copy
// drift from upstream openbox-mastra-sdk.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  "src/config",
  "src/client",
  "src/identity",
  "src/governance",
  "src/types"
];

const importPatterns = [
  /\bfrom\s+["']@opentelemetry\//,
  /\brequire\s*\(\s*["']@opentelemetry\//,
  /\bimport\s*\(\s*["']@opentelemetry\//
];

async function walk(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const hits = [];
for (const t of targets) {
  const dir = join(repoRoot, t);
  let dirStat;
  try {
    dirStat = await stat(dir);
  } catch {
    continue;
  }
  if (!dirStat.isDirectory()) continue;
  const files = await walk(dir);
  for (const f of files) {
    if (!/\.(ts|js|mjs|cjs|tsx|jsx)$/.test(f)) continue;
    const content = await readFile(f, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      if (importPatterns.some(re => re.test(line))) {
        hits.push({ file: relative(repoRoot, f), lineNum: idx + 1, line: line.trim() });
      }
    });
  }
}

if (hits.length > 0) {
  console.error("check-no-otel: forbidden @opentelemetry/* imports found in target dirs:");
  for (const h of hits) {
    console.error(`  ${h.file}:${h.lineNum}  ${h.line}`);
  }
  console.error(
    "\nOTel was removed in 0.2.0-beta.0. Do not re-introduce. See plans/260629-0501-drop-otel-from-openbox-copilotkit-sdk/."
  );
  process.exit(1);
}

console.log("check-no-otel: OK — zero @opentelemetry/* imports in target dirs.");
