import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SEMANTIC_TYPE_ATTR,
  SEMANTIC_TYPE_FUNCTION_CALL,
  SYNTHESIZER_ATTR,
  TOOL_SPAN_SYNTHESIZER_NAME
} from "../../../src/spans/semantic-types.js";
import {
  synthesizeToolSpan,
  type ToolCallArgsEventLike,
  type ToolCallTriple
} from "../../../src/spans/tool-span-synthesizer.js";

const FIXTURES_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../fixtures/agui-streams"
);

interface AguiFixtureEvent {
  content?: string;
  delta?: string;
  toolCallId: string;
  toolCallName?: string;
  type: string;
}

interface AguiFixture {
  events: AguiFixtureEvent[];
  note: string;
}

function loadStream(name: string): AguiFixture {
  return JSON.parse(
    readFileSync(join(FIXTURES_DIR, name), "utf8")
  ) as AguiFixture;
}

function triplesFromFixture(fixture: AguiFixture): Map<string, ToolCallTriple> {
  const triples = new Map<string, ToolCallTriple>();
  let ts = 1_000_000_000n;
  for (const event of fixture.events) {
    ts += 1_000n;
    switch (event.type) {
      case "TOOL_CALL_START": {
        triples.set(event.toolCallId, {
          activityId: event.toolCallId,
          args: [],
          attempt: 0,
          end: { toolCallId: event.toolCallId },
          endTimeUnixNano: ts,
          runId: "run-1",
          start: {
            toolCallId: event.toolCallId,
            toolCallName: event.toolCallName ?? "unknown"
          },
          startTimeUnixNano: ts,
          workflowId: "wf-1"
        });
        break;
      }
      case "TOOL_CALL_ARGS": {
        const existing = triples.get(event.toolCallId);
        if (existing && event.delta !== undefined) {
          existing.args.push({
            delta: event.delta,
            toolCallId: event.toolCallId
          } satisfies ToolCallArgsEventLike);
        }
        break;
      }
      case "TOOL_CALL_END": {
        const existing = triples.get(event.toolCallId);
        if (existing) {
          existing.endTimeUnixNano = ts;
        }
        break;
      }
      case "TOOL_CALL_RESULT": {
        const existing = triples.get(event.toolCallId);
        if (existing) {
          existing.end = {
            toolCallId: event.toolCallId,
            ...(event.content !== undefined
              ? { result: tryJson(event.content) ?? event.content }
              : {})
          };
          existing.endTimeUnixNano = ts;
        }
        break;
      }
      default:
        break;
    }
  }
  return triples;
}

function tryJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

describe("synthesizeToolSpan — AG-UI fixture coverage", () => {
  it("synthesizes a function_call span for the single-tool stream", () => {
    const triples = triplesFromFixture(loadStream("tool-call-single.json"));
    const triple = triples.get("call-1");
    if (!triple) {
      throw new Error("expected triple");
    }
    const span = synthesizeToolSpan(triple);
    expect(span.name).toBe("tool:setThemeColor");
    expect(span.attributes[SEMANTIC_TYPE_ATTR]).toBe(SEMANTIC_TYPE_FUNCTION_CALL);
    expect(span.attributes[SYNTHESIZER_ATTR]).toBe(TOOL_SPAN_SYNTHESIZER_NAME);
    expect(span.attributes["tool.name"]).toBe("setThemeColor");
    expect(span.attributes["tool.args_hash"]).toBe(
      createHash("sha256")
        .update('{"color":"blue"}')
        .digest("hex")
    );
    expect(span.attributes["tool.args_preview"]).toBe('{"color":"blue"}');
    expect(span.attributes["tool.result_hash"]).toBe(
      createHash("sha256").update('{"ok":true}').digest("hex")
    );
  });

  it("synthesizes distinct spans for parallel tool calls", () => {
    const triples = triplesFromFixture(loadStream("tool-call-parallel.json"));
    const tripleA = triples.get("call-a");
    const tripleB = triples.get("call-b");
    if (!tripleA || !tripleB) {
      throw new Error("expected both triples");
    }
    const a = synthesizeToolSpan(tripleA);
    const b = synthesizeToolSpan(tripleB);
    expect(a.span_id).not.toBe(b.span_id);
    expect(a.attributes["tool.call_id"]).toBe("call-a");
    expect(b.attributes["tool.call_id"]).toBe("call-b");
    expect(a.attributes["tool.name"]).toBe("setThemeColor");
    expect(b.attributes["tool.name"]).toBe("searchDocs");
  });

  it("concatenates streamed args deltas into one args_hash", () => {
    const triples = triplesFromFixture(
      loadStream("tool-call-streamed-args.json")
    );
    const triple = triples.get("call-1");
    if (!triple) {
      throw new Error("expected triple");
    }
    const span = synthesizeToolSpan(triple);
    const expected = createHash("sha256")
      .update('{"path":"/tmp/x.txt","contents":"hello"}')
      .digest("hex");
    expect(span.attributes["tool.args_hash"]).toBe(expected);
    expect(span.attributes["tool.args_preview"]).toBe(
      '{"path":"/tmp/x.txt","contents":"hello"}'
    );
  });

  it("synthesizes without result attrs when end carries no result", () => {
    const triples = triplesFromFixture(
      loadStream("tool-call-error-result.json")
    );
    const triple = triples.get("call-1");
    if (!triple) {
      throw new Error("expected triple");
    }
    const span = synthesizeToolSpan(triple);
    expect(span.attributes["tool.result_hash"]).toBeUndefined();
    expect(span.attributes["tool.result_preview"]).toBeUndefined();
  });
});

describe("synthesizeToolSpan — bounded preview + redaction", () => {
  it("truncates args_preview to 256 bytes max", () => {
    const longArg = "x".repeat(1000);
    const triple: ToolCallTriple = {
      activityId: "act-1",
      args: [{ delta: longArg, toolCallId: "call-1" }],
      end: { toolCallId: "call-1" },
      endTimeUnixNano: 2n,
      runId: "run-1",
      start: { toolCallId: "call-1", toolCallName: "tool" },
      startTimeUnixNano: 1n,
      workflowId: "wf-1"
    };
    const span = synthesizeToolSpan(triple);
    const preview = span.attributes["tool.args_preview"];
    expect(typeof preview).toBe("string");
    if (typeof preview === "string") {
      expect(preview.length).toBeLessThanOrEqual(256);
    }
  });

  it("redacts $..password from a JSON args preview", () => {
    const triple: ToolCallTriple = {
      activityId: "act-1",
      args: [
        {
          delta: '{"user":"alice","password":"hunter2"}',
          toolCallId: "call-1"
        }
      ],
      end: { toolCallId: "call-1" },
      endTimeUnixNano: 2n,
      runId: "run-1",
      start: { toolCallId: "call-1", toolCallName: "tool" },
      startTimeUnixNano: 1n,
      workflowId: "wf-1"
    };
    const span = synthesizeToolSpan(triple, {
      redactPaths: ["$..password"]
    });
    const preview = span.attributes["tool.args_preview"];
    if (typeof preview !== "string") {
      throw new Error("expected preview");
    }
    expect(preview).toContain("[REDACTED]");
    expect(preview).not.toContain("hunter2");
  });

  it("redacts nested keys via $..secret across depths", () => {
    const triple: ToolCallTriple = {
      activityId: "act-1",
      args: [
        {
          delta:
            '{"config":{"layer":{"secret":"abc"}},"items":[{"secret":"xyz"}]}',
          toolCallId: "call-1"
        }
      ],
      end: { toolCallId: "call-1" },
      endTimeUnixNano: 2n,
      runId: "run-1",
      start: { toolCallId: "call-1", toolCallName: "tool" },
      startTimeUnixNano: 1n,
      workflowId: "wf-1"
    };
    const span = synthesizeToolSpan(triple, { redactPaths: ["$..secret"] });
    const preview = span.attributes["tool.args_preview"];
    if (typeof preview !== "string") {
      throw new Error("expected preview");
    }
    expect(preview).not.toContain("abc");
    expect(preview).not.toContain("xyz");
  });

  it("emits error status when isError option is set", () => {
    const triple: ToolCallTriple = {
      activityId: "act-1",
      args: [],
      end: { toolCallId: "call-1" },
      endTimeUnixNano: 2n,
      runId: "run-1",
      start: { toolCallId: "call-1", toolCallName: "tool" },
      startTimeUnixNano: 1n,
      workflowId: "wf-1"
    };
    const span = synthesizeToolSpan(triple, { isError: true });
    expect(span.status).toBe("error");
  });

  it("computes duration_ms from start/end bigint nanos", () => {
    const triple: ToolCallTriple = {
      activityId: "act-1",
      args: [],
      end: { toolCallId: "call-1" },
      endTimeUnixNano: 5_000_000_000n,
      runId: "run-1",
      start: { toolCallId: "call-1", toolCallName: "tool" },
      startTimeUnixNano: 1_000_000_000n,
      workflowId: "wf-1"
    };
    const span = synthesizeToolSpan(triple);
    expect(span.attributes["tool.duration_ms"]).toBe(4000);
  });
});
