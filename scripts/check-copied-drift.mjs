#!/usr/bin/env node
// Validates that every row in COPIED_FROM.md still matches the local file's SHA-256.
// Does NOT read openbox-mastra-sdk (independence rule). The "Source SHA-256"
// column is informational metadata only; only "Local SHA-256" is enforced.
//
// Exit codes:
//   0 — every recorded row matches its local file (or excluded file is absent)
//   1 — at least one drift detected (recorded SHA-256 != local SHA-256, or excluded file present)

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "COPIED_FROM.md");

const manifest = await readFile(manifestPath, "utf8");

const tableRows = [];
const excludedRows = [];

let section = null;
for (const rawLine of manifest.split("\n")) {
  const line = rawLine.trim();
  if (line.startsWith("## ")) {
    if (/^## (Per-file status|Fixture directories)/.test(line)) {
      section = "files";
    } else if (line.startsWith("## Excluded from copy")) {
      section = "excluded";
    } else {
      section = null;
    }
    continue;
  }
  if (!line.startsWith("|")) continue;
  if (line.startsWith("|---")) continue;
  if (line.startsWith("| Path |")) continue;

  const cells = line
    .split("|")
    .slice(1, -1)
    .map(c => c.trim());

  if (section === "files") {
    // Per-file status table: Path | Source path | Source commit | Source SHA-256 | Local SHA-256 | Status | Notes
    // Fixture table:        Path | Source path | Source SHA-256 | Local SHA-256 | Status
    if (cells.length === 7) {
      const [path, , , , localSha, status] = cells;
      tableRows.push({ path: stripCode(path), localSha: stripCode(localSha), status });
    } else if (cells.length === 5) {
      const [path, , , localSha, status] = cells;
      tableRows.push({ path: stripCode(path), localSha: stripCode(localSha), status });
    }
  } else if (section === "excluded") {
    if (cells.length === 2) {
      excludedRows.push({ path: stripCode(cells[0]), reason: cells[1] });
    }
  }
}

function stripCode(value) {
  return value.replace(/^`|`$/g, "").trim();
}

async function sha256(filePath) {
  const buf = await readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

let failures = 0;

for (const row of tableRows) {
  const filePath = join(repoRoot, row.path);
  if (!existsSync(filePath)) {
    console.error(`MISSING: ${row.path} (recorded ${row.status})`);
    failures++;
    continue;
  }
  const actual = await sha256(filePath);
  if (actual !== row.localSha) {
    console.error(
      `DRIFT:   ${row.path}\n  recorded: ${row.localSha}\n  actual:   ${actual}\n  status:   ${row.status}`
    );
    failures++;
  }
}

for (const row of excludedRows) {
  // Excluded entries may name directories or label-only entries — only fail if
  // the path literally resolves to an existing file.
  if (row.path.endsWith("/") || row.path.includes(" ")) continue;
  const filePath = join(repoRoot, row.path);
  if (existsSync(filePath)) {
    console.error(
      `UNEXPECTED: ${row.path} is listed as Excluded but exists locally — ${row.reason}`
    );
    failures++;
  }
}

if (failures > 0) {
  console.error(`\ncheck-copied-drift: ${failures} failure(s).`);
  process.exit(1);
}

console.log(
  `check-copied-drift: OK — ${tableRows.length} tracked file(s) match recorded SHA-256.`
);
