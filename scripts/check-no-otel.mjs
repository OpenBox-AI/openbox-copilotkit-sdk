#!/usr/bin/env node
// Greps SDK source for any `@opentelemetry/*` runtime import. Matches
// `from "@opentelemetry/..."`, `require("@opentelemetry/...")`, and dynamic
// `import("@opentelemetry/...")` syntax — pure-prose mentions inside backticked
// comments do not match. Exits 1 with a list of files+lines if any are found.
//
// This SDK emits directly through the OpenBox client and must not install a
// global OpenTelemetry runtime.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = ["src"];

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
        hits.push({
          file: relative(repoRoot, f),
          line: line.trim(),
          lineNum: idx + 1
        });
      }
    });
  }
}

if (hits.length > 0) {
  console.error("check-no-otel: forbidden @opentelemetry/* imports found in SDK source:");
  for (const h of hits) {
    console.error(`  ${h.file}:${h.lineNum}  ${h.line}`);
  }
  console.error(
    "\nDo not introduce OpenTelemetry runtime imports into this package."
  );
  process.exit(1);
}

console.log("check-no-otel: OK — zero @opentelemetry/* imports in SDK source.");
