import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const distRoot = join(repoRoot, "dist");

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let dirStat;
  try {
    dirStat = await stat(dir);
  } catch {
    return out;
  }
  if (!dirStat.isDirectory()) return out;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (e.isFile() && /\.(js|mjs|cjs|d\.ts)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("dist/ is OTel-free", () => {
  it("contains no @opentelemetry/* import or require string in any built artifact", async () => {
    const files = await walk(distRoot);
    if (files.length === 0) {
      // No build artifacts yet (e.g. fresh clone before npm run build). The
      // ci:check pipeline runs build before test so this scenario is rare.
      // Skipping is safer than failing here — the check:no-otel script
      // already covers the source-side check.
      return;
    }

    const hits: Array<{ file: string; line: number; snippet: string }> = [];
    for (const f of files) {
      const content = await readFile(f, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        if (/@opentelemetry\//.test(line)) {
          hits.push({
            file: f.replace(repoRoot + "/", ""),
            line: idx + 1,
            snippet: line.trim().slice(0, 120)
          });
        }
      });
    }

    expect(hits, hits.map(h => `${h.file}:${h.line}  ${h.snippet}`).join("\n")).toEqual([]);
  });
});
