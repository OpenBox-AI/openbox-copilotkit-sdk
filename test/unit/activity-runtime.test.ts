import { describe, expect, it } from "vitest";

import {
  appendGoalToActivityInput,
  applyRedaction,
  normalizeSpansForGovernance,
  serializeValue,
  type ToolExecutionContextLike,
  type WorkflowSuspendContext
} from "../../src/governance/activity-runtime.js";

describe("activity-runtime refactor (Phase 1)", () => {
  it("ToolExecutionContextLike accepts call sites the file uses (no @mastra/core/tools)", () => {
    const ctx: ToolExecutionContextLike = {
      agent: { toolCallId: "tool-call-1" },
      requestContext: { tenantId: "acme" },
      workflow: undefined
    };

    expect(ctx.agent?.toolCallId).toBe("tool-call-1");
  });

  it("WorkflowSuspendContext shape preserved for inline approvals", () => {
    const workflow: WorkflowSuspendContext = {
      runId: "run-1",
      workflowId: "wf-1",
      state: { step: 1 },
      setState: () => undefined,
      suspend: async payload => payload
    };

    expect(workflow.runId).toBe("run-1");
    expect(workflow.workflowId).toBe("wf-1");
  });
});

describe("activity-runtime pure helpers", () => {
  describe("serializeValue", () => {
    it("returns null/undefined unchanged", () => {
      expect(serializeValue(null)).toBeNull();
      expect(serializeValue(undefined)).toBeUndefined();
    });

    it("preserves primitives", () => {
      expect(serializeValue("hello")).toBe("hello");
      expect(serializeValue(42)).toBe(42);
      expect(serializeValue(true)).toBe(true);
    });

    it("encodes Uint8Array as utf-8 string", () => {
      const bytes = new TextEncoder().encode("payload");
      expect(serializeValue(bytes)).toBe("payload");
    });

    it("serializes Date to ISO string", () => {
      const d = new Date("2026-01-01T00:00:00.000Z");
      expect(serializeValue(d)).toBe("2026-01-01T00:00:00.000Z");
    });

    it("maps arrays recursively", () => {
      expect(serializeValue([1, "two", null])).toEqual([1, "two", null]);
    });

    it("serializes nested plain objects", () => {
      expect(serializeValue({ a: 1, b: { c: "x" } })).toEqual({
        a: 1,
        b: { c: "x" }
      });
    });

    it("coerces unknown types via String()", () => {
      expect(serializeValue(Symbol("s"))).toBe("Symbol(s)");
    });
  });

  describe("appendGoalToActivityInput", () => {
    it("returns input unchanged when goal is empty or whitespace", () => {
      expect(appendGoalToActivityInput({ x: 1 }, undefined)).toEqual({ x: 1 });
      expect(appendGoalToActivityInput([1], "   ")).toEqual([1]);
    });

    it("attaches goal to first object element of an array", () => {
      expect(appendGoalToActivityInput([{ a: 1 }, "tail"], "ship it")).toEqual([
        { a: 1, goal: "ship it" },
        "tail"
      ]);
    });

    it("returns array with single goal record when array is empty", () => {
      expect(appendGoalToActivityInput([], "ship it")).toEqual([
        { goal: "ship it" }
      ]);
    });

    it("preserves existing goal on first element", () => {
      const input = [{ goal: "existing" }];
      expect(appendGoalToActivityInput(input, "new")).toEqual([
        { goal: "existing" }
      ]);
    });

    it("wraps primitive array element in trailing goal record", () => {
      expect(appendGoalToActivityInput([1, 2], "ship")).toEqual([
        1,
        2,
        { goal: "ship" }
      ]);
    });

    it("wraps null/undefined input in array with goal record", () => {
      expect(appendGoalToActivityInput(undefined, "ship")).toEqual([
        { goal: "ship" }
      ]);
      expect(appendGoalToActivityInput(null, "ship")).toEqual([
        { goal: "ship" }
      ]);
    });

    it("merges goal into plain object input", () => {
      expect(appendGoalToActivityInput({ a: 1 }, "ship")).toEqual({
        a: 1,
        goal: "ship"
      });
    });

    it("preserves existing goal on object input", () => {
      expect(appendGoalToActivityInput({ goal: "kept" }, "new")).toEqual({
        goal: "kept"
      });
    });

    it("wraps scalar input in array with goal record", () => {
      expect(appendGoalToActivityInput("abc", "ship")).toEqual([
        "abc",
        { goal: "ship" }
      ]);
    });
  });

  describe("applyRedaction", () => {
    it("returns clone of redacted scalar", () => {
      expect(applyRedaction("orig", "redacted")).toBe("redacted");
    });

    it("merges redacted object fields onto original", () => {
      const original = { a: 1, b: { keep: true }, c: 3 };
      const redacted = { b: { masked: "***" } };
      expect(applyRedaction(original, redacted)).toEqual({
        a: 1,
        b: { keep: true, masked: "***" },
        c: 3
      });
    });

    it("maps arrays by index", () => {
      expect(applyRedaction(["a", "b"], ["x", "y"])).toEqual(["x", "y"]);
    });
  });

  describe("normalizeSpansForGovernance", () => {
    it("normalizes minimal span shape", () => {
      const normalized = normalizeSpansForGovernance([
        {
          name: "http.request",
          attributes: { "url.full": "https://x" },
          start_time: 1,
          end_time: 2
        }
      ]);

      expect(normalized).toHaveLength(1);
      const span = normalized[0];
      expect(span).toMatchObject({
        name: "http.request",
        start_time: 1,
        end_time: 2,
        duration_ns: 1
      });
      const attrs = span?.attributes as Record<string, unknown>;
      expect(attrs["http.url"]).toBe("https://x");
    });

    it("preserves explicit duration_ns when present", () => {
      const normalized = normalizeSpansForGovernance([
        {
          name: "db.query",
          attributes: {},
          start_time: 1,
          end_time: 2,
          duration_ns: 42
        }
      ]);
      expect(normalized[0]?.duration_ns).toBe(42);
    });
  });
});
