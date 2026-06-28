#!/usr/bin/env node
// Greps copied module directories for any `@mastra/*` import. Matches
// `from "@mastra/..."`, `require("@mastra/...")`, and dynamic `import("@mastra/...")`
// syntax — pure-prose mentions inside backticked comments do not match.
// Exits 1 with a list of files+lines if any are found.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  "src/config",
  "src/client",
  "src/identity",
  "src/governance",
  "src/otel",
  "src/span",
  "src/types"
];

const importPatterns = [
  /\bfrom\s+["']@mastra\//,
  /\brequire\s*\(\s*["']@mastra\//,
  /\bimport\s*\(\s*["']@mastra\//
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
  console.error("check-no-mastra-imports: forbidden @mastra/* imports found in copied modules:");
  for (const h of hits) {
    console.error(`  ${h.file}:${h.lineNum}  ${h.line}`);
  }
  console.error(
    "\nRefactor at copy time to drop the @mastra dependency (mirror the activity-runtime.ts pattern)."
  );
  process.exit(1);
}

console.log("check-no-mastra-imports: OK — zero @mastra/* imports in copied modules.");
