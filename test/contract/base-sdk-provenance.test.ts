import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOCK_PATH = resolve(REPO_ROOT, "package-lock.json");
const BASE_PKG = "@openbox-ai/openbox-sdk-ts";
const LOCK_KEY = `node_modules/${BASE_PKG}`;

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(version: string): Semver {
  const [major = "0", minor = "0", patch = "0"] = version.split("-")[0]!.split(".");
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/** true when `v` >= `min` (both simple x.y.z). */
function gte(v: Semver, min: Semver): boolean {
  if (v.major !== min.major) return v.major > min.major;
  if (v.minor !== min.minor) return v.minor > min.minor;
  return v.patch >= min.patch;
}

/**
 * FREEZE (Phase 1 / RT-F15a/b).
 *
 * The migration depends on the base SDK carrying P0a/P0b/P0c, first shipped in
 * `1.0.1`. This asserts the *installed* base is >= 1.0.1 and < 2.0.0.
 *
 * NOTE (local-dev deviation — see _notes/decision-local-base-sdk-link-for-0.4.0-migration.md):
 * `1.0.1` is not yet on npm, so the base is currently linked `file:../openbox-sdk-ts`.
 * The "no local/`file:` specifier in the lockfile" invariant is therefore a
 * RELEASE gate (run with OPENBOX_RELEASE_CHECK=1), not a dev-cycle assertion —
 * the release swap to an exact `1.0.1` registry pin is user-owned.
 */
describe("base-sdk provenance", () => {
  it("installs @openbox-ai/openbox-sdk-ts >= 1.0.1 and < 2.0.0", () => {
    const pkg = require(`${BASE_PKG}/package.json`) as { name: string; version: string };
    expect(pkg.name).toBe(BASE_PKG);

    const v = parseSemver(pkg.version);
    expect(gte(v, { major: 1, minor: 0, patch: 1 }), `installed ${pkg.version} must be >= 1.0.1`).toBe(true);
    expect(v.major, `installed ${pkg.version} must be < 2.0.0`).toBeLessThan(2);
  });

  it.runIf(Boolean(process.env["OPENBOX_RELEASE_CHECK"]))(
    "RELEASE GATE: lockfile pins the base SDK from the registry (no file:/link specifier)",
    () => {
      const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as {
        packages: Record<string, { resolved?: string; link?: boolean; version?: string }>;
      };
      const entry = lock.packages[LOCK_KEY];
      expect(entry, `lockfile entry ${LOCK_KEY} missing`).toBeDefined();
      expect(entry?.link ?? false, "base SDK must not be a local link at release").toBe(false);
      expect(entry?.resolved ?? "", "base SDK must resolve from the npm registry at release").toMatch(
        /^https:\/\//
      );
      expect(entry?.version, "base SDK must be pinned exactly to 1.0.1 at release").toBe("1.0.1");
    }
  );
});
