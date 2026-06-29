import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { GovernanceVerdictResponse } from "../../../src/types/governance-verdict-response.js";
import { Verdict } from "../../../src/types/verdict.js";
import { OpenBoxVerdictSchema } from "../../../src/verdict/openbox-verdict.js";
import {
  mapVerdict,
  VerdictMappingError
} from "../../../src/verdict/verdict-mapper.js";

const FIXTURES_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../fixtures/governance-verdict-responses"
);

function loadFixture(name: string): GovernanceVerdictResponse {
  const raw = JSON.parse(
    readFileSync(join(FIXTURES_DIR, name), "utf8")
  ) as Record<string, unknown>;
  return GovernanceVerdictResponse.fromObject(raw);
}

describe("mapVerdict — fixture matrix", () => {
  const files = readdirSync(FIXTURES_DIR).filter(name => name.endsWith(".json"));

  it("loads at least 18 fixtures covering the action × field permutation matrix", () => {
    expect(files.length).toBeGreaterThanOrEqual(18);
  });

  for (const file of files) {
    it(`maps ${file} to a schema-valid OpenBoxVerdict`, () => {
      const response = loadFixture(file);
      const verdict = mapVerdict(response);
      expect(() => OpenBoxVerdictSchema.parse(verdict)).not.toThrow();
    });
  }
});

describe("mapVerdict — per-action behavior", () => {
  it("maps allow with optional reason", () => {
    const verdict = mapVerdict(loadFixture("allow-with-reason.json"));
    expect(verdict).toEqual({ reason: "policy_passed", type: "allow" });
  });

  it("maps allow when reason is absent", () => {
    const verdict = mapVerdict(loadFixture("allow-minimal.json"));
    expect(verdict).toEqual({ type: "allow" });
  });

  it("maps block with replacement from metadata.replacement_content", () => {
    const verdict = mapVerdict(loadFixture("block-with-replacement.json"));
    expect(verdict.type).toBe("block");
    if (verdict.type === "block") {
      expect(verdict.replacement?.message).toMatch(/cannot perform/);
    }
  });

  it("maps block with a tool_result replacement", () => {
    const verdict = mapVerdict(
      loadFixture("block-with-tool-result-replacement.json")
    );
    if (verdict.type !== "block") {
      throw new Error("expected block");
    }
    expect(verdict.replacement?.tool_result).toEqual({
      error: "blocked_by_policy",
      ok: false
    });
  });

  it("maps constrain with structured constraints", () => {
    const verdict = mapVerdict(
      loadFixture("constrain-redact-and-rewrite.json")
    );
    expect(verdict.type).toBe("constrain");
    if (verdict.type === "constrain") {
      expect(verdict.constraints).toEqual([
        { path: "$.user.email", type: "redact" },
        { path: "$.amount", type: "rewrite", value: 100 }
      ]);
    }
  });

  it("accepts an empty constraints array as a valid constrain", () => {
    const verdict = mapVerdict(loadFixture("constrain-empty-constraints.json"));
    if (verdict.type !== "constrain") {
      throw new Error("expected constrain");
    }
    expect(verdict.constraints).toEqual([]);
  });

  it("falls back to add-metadata raw_constraint on malformed entries", () => {
    const warn = vi.fn();
    const verdict = mapVerdict(
      loadFixture("constrain-with-malformed-fallback.json"),
      { logger: { warn } }
    );
    if (verdict.type !== "constrain") {
      throw new Error("expected constrain");
    }
    expect(verdict.constraints).toEqual([
      { path: "$.password", type: "redact" },
      {
        key: "raw_constraint",
        type: "add-metadata",
        value: {
          details: "should fall back to raw_constraint",
          type: "unknown-op"
        }
      }
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("synthesizes a 'pending' approval_id when Core didn't supply one", () => {
    const verdict = mapVerdict(loadFixture("require-approval-without-id.json"));
    if (verdict.type !== "require_approval") {
      throw new Error("expected require_approval");
    }
    expect(verdict.approval_id).toBe("pending");
    expect(verdict.mode).toBe("polling");
    expect(verdict.on_approved).toBe("allow");
    expect(verdict.on_rejected).toBe("block");
    expect(verdict.on_expired).toBe("block");
    expect(verdict.on_failed).toBe("block");
  });

  it("preserves Core's approval_id when present", () => {
    const verdict = mapVerdict(loadFixture("require-approval-minimal.json"));
    if (verdict.type !== "require_approval") {
      throw new Error("expected require_approval");
    }
    expect(verdict.approval_id).toBe("appr-123");
  });

  it("carries constraints through require_approval mapping", () => {
    const verdict = mapVerdict(
      loadFixture("require-approval-with-constraints.json")
    );
    if (verdict.type !== "require_approval") {
      throw new Error("expected require_approval");
    }
    expect(verdict.constraints).toEqual([
      { path: "$.token", type: "redact" }
    ]);
  });

  it("defaults halt_scope to copilot_run", () => {
    const verdict = mapVerdict(loadFixture("halt-minimal.json"));
    if (verdict.type !== "halt") {
      throw new Error("expected halt");
    }
    expect(verdict.halt_scope).toBe("copilot_run");
    expect(verdict.code).toBeUndefined();
  });

  it("extracts halt code from metadata when present", () => {
    const verdict = mapVerdict(loadFixture("halt-with-code.json"));
    if (verdict.type !== "halt") {
      throw new Error("expected halt");
    }
    expect(verdict.code).toBe("SAFETY_RAIL_TRIPPED");
  });

  it("normalizes legacy action:'continue' to allow", () => {
    const verdict = mapVerdict(loadFixture("allow-via-legacy-continue.json"));
    expect(verdict.type).toBe("allow");
  });

  it("normalizes legacy action:'stop' to halt", () => {
    const verdict = mapVerdict(loadFixture("halt-via-legacy-stop.json"));
    expect(verdict.type).toBe("halt");
  });

  it("normalizes legacy action:'require-approval' to require_approval", () => {
    const verdict = mapVerdict(
      loadFixture("require-approval-via-legacy-hyphen.json")
    );
    expect(verdict.type).toBe("require_approval");
  });
});

describe("mapVerdict — error paths", () => {
  it("throws VerdictMappingError when constrain lacks a reason", () => {
    const response = new GovernanceVerdictResponse({
      constraints: [],
      verdict: Verdict.CONSTRAIN
    });
    expect(() => mapVerdict(response)).toThrow(VerdictMappingError);
  });

  it("throws VerdictMappingError when require_approval lacks a reason", () => {
    const response = new GovernanceVerdictResponse({
      verdict: Verdict.REQUIRE_APPROVAL
    });
    expect(() => mapVerdict(response)).toThrow(VerdictMappingError);
  });

  it("throws VerdictMappingError when block lacks a reason", () => {
    const response = new GovernanceVerdictResponse({
      verdict: Verdict.BLOCK
    });
    expect(() => mapVerdict(response)).toThrow(VerdictMappingError);
  });

  it("throws VerdictMappingError when halt lacks a reason", () => {
    const response = new GovernanceVerdictResponse({
      verdict: Verdict.HALT
    });
    expect(() => mapVerdict(response)).toThrow(VerdictMappingError);
  });

  it("falls back to safe block for an unrecognized verdict (non-strict)", () => {
    const error = vi.fn();
    const response = new GovernanceVerdictResponse({
      verdict: "throttle" as unknown as ReturnType<typeof Verdict.fromString>
    });
    const verdict = mapVerdict(response, { logger: { error } });
    expect(verdict).toEqual({
      reason: "unknown_verdict_action:throttle",
      type: "block"
    });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("throws on an unrecognized verdict when strictMode is on", () => {
    const response = new GovernanceVerdictResponse({
      verdict: "throttle" as unknown as ReturnType<typeof Verdict.fromString>
    });
    expect(() => mapVerdict(response, { strictMode: true })).toThrow(
      VerdictMappingError
    );
  });
});

describe("mapVerdict — property-style coverage", () => {
  it("returns a schema-valid verdict for every (verdict × constraint-count) combination", () => {
    const verdicts: Array<ReturnType<typeof Verdict.fromString>> = [
      Verdict.ALLOW,
      Verdict.CONSTRAIN,
      Verdict.REQUIRE_APPROVAL,
      Verdict.BLOCK,
      Verdict.HALT
    ];
    const constraintCounts = [0, 1, 3, 10];

    for (const v of verdicts) {
      for (const count of constraintCounts) {
        const constraints =
          v === Verdict.CONSTRAIN || v === Verdict.REQUIRE_APPROVAL
            ? Array.from({ length: count }, (_, i) => ({
                path: `$.field${i}`,
                type: "redact" as const
              }))
            : undefined;
        const response = new GovernanceVerdictResponse({
          ...(constraints
            ? { constraints: constraints as Record<string, unknown>[] }
            : {}),
          reason: "synthetic",
          verdict: v
        });
        const mapped = mapVerdict(response);
        expect(() => OpenBoxVerdictSchema.parse(mapped)).not.toThrow();
      }
    }
  });
});
