import { describe, expect, it } from "vitest";

import {
  OpenBoxConstraintSchema,
  OpenBoxVerdictSchema,
  type OpenBoxConstraint,
  type OpenBoxVerdict
} from "../../../src/verdict/openbox-verdict.js";

describe("OpenBoxVerdictSchema", () => {
  it("round-trips an allow verdict with optional reason", () => {
    const value: OpenBoxVerdict = { reason: "ok", type: "allow" };
    expect(OpenBoxVerdictSchema.parse(value)).toEqual(value);
  });

  it("round-trips a block verdict with replacement", () => {
    const value: OpenBoxVerdict = {
      reason: "blocked",
      replacement: { message: "denied" },
      type: "block"
    };
    expect(OpenBoxVerdictSchema.parse(value)).toEqual(value);
  });

  it("round-trips a constrain verdict with all constraint shapes", () => {
    const value: OpenBoxVerdict = {
      constraints: [
        { path: "$.email", type: "redact" },
        { path: "$.amount", type: "rewrite", value: 1 },
        { path: "$.history", type: "remove-context" },
        { args: { mode: "ro" }, type: "narrow-tool-args" },
        { key: "raw", type: "add-metadata", value: { nested: true } }
      ],
      reason: "constrain it",
      type: "constrain"
    };
    expect(OpenBoxVerdictSchema.parse(value)).toEqual(value);
  });

  it("round-trips a require_approval verdict with defaults present", () => {
    const value: OpenBoxVerdict = {
      approval_id: "appr-1",
      mode: "polling",
      on_approved: "allow",
      on_expired: "block",
      on_failed: "block",
      on_rejected: "block",
      reason: "needs review",
      type: "require_approval"
    };
    expect(OpenBoxVerdictSchema.parse(value)).toEqual(value);
  });

  it("round-trips a halt verdict with halt_scope and code", () => {
    const value: OpenBoxVerdict = {
      code: "TRIPPED",
      halt_scope: "copilot_run",
      reason: "halt requested",
      type: "halt"
    };
    expect(OpenBoxVerdictSchema.parse(value)).toEqual(value);
  });

  it("rejects a constrain verdict missing reason", () => {
    const invalid = {
      constraints: [],
      type: "constrain"
    } satisfies Record<string, unknown>;
    expect(() => OpenBoxVerdictSchema.parse(invalid)).toThrow();
  });

  it("rejects an unknown discriminator", () => {
    const invalid = { reason: "x", type: "throttle" };
    expect(() => OpenBoxVerdictSchema.parse(invalid)).toThrow();
  });
});

describe("OpenBoxConstraintSchema", () => {
  it("accepts each canonical constraint shape", () => {
    const shapes: OpenBoxConstraint[] = [
      { path: "$.x", type: "redact" },
      { path: "$.x", replacement: "[***]", type: "redact" },
      { path: "$.x", type: "rewrite", value: 0 },
      { path: "$.x", type: "remove-context" },
      { args: {}, type: "narrow-tool-args" },
      { key: "k", type: "add-metadata", value: null }
    ];
    for (const shape of shapes) {
      expect(OpenBoxConstraintSchema.parse(shape)).toEqual(shape);
    }
  });

  it("rejects narrow-tool-args without args", () => {
    expect(() =>
      OpenBoxConstraintSchema.parse({ type: "narrow-tool-args" })
    ).toThrow();
  });

  it("rejects add-metadata without key", () => {
    expect(() =>
      OpenBoxConstraintSchema.parse({ type: "add-metadata", value: 1 })
    ).toThrow();
  });
});
