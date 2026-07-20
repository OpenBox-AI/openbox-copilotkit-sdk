#!/usr/bin/env node
// Guards against a SECOND signing/Core-endpoint implementation creeping into
// production `src/` (RT-F15e, phase-06 plan). Ownership after the
// openbox-sdk-ts adoption: the base SDK (`@openbox-ai/openbox-sdk-ts`) owns
// Core's HTTP endpoints, the `X-OpenBox-Agent-*` / `X-OpenBox-Body-SHA256`
// header NAMES (its `HEADER_*` constants), canonical-request assembly
// (`buildCanonicalString`), and Ed25519 signing (`AgentIdentity`). This
// package may only ever DELEGATE to those primitives, never reimplement them.
//
// Three checks against every `src/**/*.{ts,js,mjs,cjs,tsx,jsx}` file:
//
//   1. A hardcoded Core governance/auth endpoint path STRING LITERAL (e.g.
//      "/api/v1/governance/evaluate") outside ENDPOINT_LITERAL_ALLOWLIST.
//   2. A hardcoded `X-OpenBox-Agent-*` / `X-OpenBox-Body-SHA256` header-name
//      STRING LITERAL anywhere — a base-delegating file always references the
//      symbolic `HEADER_*` constant, never spells the wire name out itself.
//   3. A file that references 2+ of the `HEADER_*` identifiers (i.e. it
//      assembles the identity envelope) without importing BOTH
//      `buildCanonicalString` and `AgentIdentity` from
//      `@openbox-ai/openbox-sdk-ts/identity` in the same file — i.e. it
//      builds the envelope without delegating canonicalization + signing to
//      base.
//
// Rules 1/2 require the literal to sit directly inside a quote/backtick pair,
// so a doc comment like `` `GET /api/v1/auth/validate` `` (backtick wraps
// "GET " + the path, not the bare path) does not match — pure-prose mentions
// are not flagged, only actual string-literal values.
//
// Exactly two legacy facades are permitted to reference Core's endpoint paths
// directly (client/openbox-client.ts still issues the HTTP calls itself;
// identity/agent-identity.ts is its sibling facade) — both are deprecated,
// documented in MIGRATION.md, removed at 1.0.0, and delegate every
// crypto/canonicalization primitive to `@openbox-ai/openbox-sdk-ts/identity`.
// Nothing else may hardcode a Core endpoint path.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = "src";

const ENDPOINT_LITERAL_ALLOWLIST = new Set([
  "src/client/openbox-client.ts",
  "src/identity/agent-identity.ts"
]);

const ENDPOINT_LITERAL_PATTERN =
  /["'`]\/api\/v1\/(?:governance\/(?:evaluate|approval)|auth\/validate)["'`]/;

const HEADER_NAME_LITERAL_PATTERN =
  /["'`]X-OpenBox-(?:Agent-(?:DID|Timestamp|Nonce|Signature)|Body-SHA256)["'`]/i;

const HEADER_CONSTANT_NAMES = [
  "HEADER_DID",
  "HEADER_TIMESTAMP",
  "HEADER_NONCE",
  "HEADER_BODY_SHA256",
  "HEADER_SIGNATURE"
];

const BASE_IDENTITY_IMPORT_PATTERN =
  /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@openbox-ai\/openbox-sdk-ts\/identity["']/g;

async function walk(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function importedIdentityNames(content) {
  const names = new Set();
  BASE_IDENTITY_IMPORT_PATTERN.lastIndex = 0;
  let match;
  while ((match = BASE_IDENTITY_IMPORT_PATTERN.exec(content))) {
    for (const raw of match[1].split(",")) {
      const name = raw.replace(/^\s*type\s+/, "").trim();
      if (name) {
        names.add(name);
      }
    }
  }
  return names;
}

function countHeaderConstantRefs(content) {
  let count = 0;
  for (const name of HEADER_CONSTANT_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(content)) {
      count += 1;
    }
  }
  return count;
}

const dir = join(repoRoot, target);
let dirStat;
try {
  dirStat = await stat(dir);
} catch {
  console.log("check-no-duplicate-signing: OK — no src/ directory found.");
  process.exit(0);
}
if (!dirStat.isDirectory()) {
  console.log("check-no-duplicate-signing: OK — src is not a directory.");
  process.exit(0);
}

const files = (await walk(dir)).filter(f => /\.(ts|js|mjs|cjs|tsx|jsx)$/.test(f));
const violations = [];

for (const file of files) {
  const relPath = relative(repoRoot, file).split("\\").join("/");
  const content = await readFile(file, "utf8");
  const lines = content.split("\n");

  if (!ENDPOINT_LITERAL_ALLOWLIST.has(relPath)) {
    lines.forEach((line, idx) => {
      if (ENDPOINT_LITERAL_PATTERN.test(line)) {
        violations.push({
          file: relPath,
          line: idx + 1,
          rule: "hardcoded Core endpoint path outside the allowlisted facades",
          text: line.trim()
        });
      }
    });
  }

  lines.forEach((line, idx) => {
    if (HEADER_NAME_LITERAL_PATTERN.test(line)) {
      violations.push({
        file: relPath,
        line: idx + 1,
        rule: "hardcoded X-OpenBox-Agent-*/Body-SHA256 header-name literal (use the base HEADER_* constant instead)",
        text: line.trim()
      });
    }
  });

  if (countHeaderConstantRefs(content) >= 2) {
    const identityImports = importedIdentityNames(content);
    const delegatesCanonicalization = identityImports.has("buildCanonicalString");
    const delegatesSigning = identityImports.has("AgentIdentity");
    if (!delegatesCanonicalization || !delegatesSigning) {
      const firstHeaderLine = lines.findIndex(line =>
        HEADER_CONSTANT_NAMES.some(name => new RegExp(`\\b${name}\\b`).test(line))
      );
      violations.push({
        file: relPath,
        line: firstHeaderLine >= 0 ? firstHeaderLine + 1 : 1,
        rule:
          "assembles the OpenBox identity header envelope without importing both `buildCanonicalString` and `AgentIdentity` from `@openbox-ai/openbox-sdk-ts/identity` (canonical signing-byte assembly must delegate to base)",
        text: "(whole-file check)"
      });
    }
  }
}

if (violations.length > 0) {
  console.error("check-no-duplicate-signing: forbidden re-implementation found:");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]  ${v.text}`);
  }
  console.error(
    "\nCore endpoints, X-OpenBox-Agent-* header construction, and canonical signing-byte " +
      "assembly must delegate to @openbox-ai/openbox-sdk-ts (identity/client subpaths) — see MIGRATION.md."
  );
  process.exit(1);
}

console.log(
  "check-no-duplicate-signing: OK — no re-implemented Core endpoints, header construction, or signing-byte assembly outside the base-delegating facades."
);
