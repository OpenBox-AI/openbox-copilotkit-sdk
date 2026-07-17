/**
 * RT-F1 SPIKE (the §24 gate for Phase 5's hard server-tool enforcement).
 *
 * Phase 1 already proved AsyncLocalStorage propagates into a REAL BuiltInAgent's
 * `streamText` -> tool `execute` pump for a single run. This spike proves the
 * remaining requirement: under >=2 CONCURRENT real-agent runs sharing one
 * controller, each wrapped tool `execute` reads its OWN run's
 * `currentRunContext()` — correct AND isolated, never cross-contaminated.
 *
 * If this FAILS, Phase 5 cannot correlate a server tool to its run via the
 * per-run ALS (D7) and hard server-tool enforcement must be descoped
 * (proposal §24 STOP) — thread correlation explicitly instead.
 *
 * Why this is a valid propagation test (not an "ALS is always green" trap): the
 * context is bound ONLY by the middleware wrapping `source.subscribe` in
 * `enterRunContext` (Phase 3b). `execute` runs deep inside BuiltInAgent's
 * fire-and-forget pump, several async hops away. The `await` before reading the
 * context forces both runs to be in-flight simultaneously, so a leaked/global
 * binding would surface as crosstalk. The `expect(...).toBeDefined()` assertions
 * would fail if the binding never reached `execute` at all.
 */
import { BuiltInAgent, defineTool } from "@copilotkit/runtime/v2";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createOpenBoxMiddleware } from "../../src/copilotkit/openbox-middleware.js";

import {
  buildController,
  buildRunAgentInput,
  collectEvents
} from "../unit/copilotkit/test-utils.js";

import type { OpenBoxRuntimeController } from "../../src/copilotkit/types.js";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

const TOOL_NAME = "recordRunContext";

function toolCallStream(toolCallId: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { input: JSON.stringify({ probe: true }), toolCallId, toolName: TOOL_NAME, type: "tool-call" },
    {
      finishReason: { raw: "tool-calls", unified: "tool-calls" },
      type: "finish",
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 4, total: 4 },
        outputTokens: { reasoning: 0, text: 0, total: 2 }
      }
    }
  ];
}

/**
 * A real BuiltInAgent whose server tool records the run context visible INSIDE
 * `execute`. The `await` delay guarantees both runs' executes overlap in flight.
 */
function makeProbeAgent(
  controller: OpenBoxRuntimeController,
  toolCallId: string,
  sink: { observed?: { workflowId: string; runId: string } }
): BuiltInAgent {
  const tool = defineTool({
    description: "Records the OpenBox per-run context observed inside execute.",
    execute: async () => {
      // Force overlap so a global/leaked binding would cross-contaminate.
      await new Promise(resolve => setTimeout(resolve, 10));
      sink.observed = controller.runContext.currentRunContext();
      return { recorded: true };
    },
    name: TOOL_NAME,
    parameters: z.object({ probe: z.boolean() })
  });
  const model = new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(toolCallStream(toolCallId)) })
  });
  return new BuiltInAgent({ maxSteps: 1, model, tools: [tool] });
}

describe("RT-F1 spike: per-run context isolation under concurrent real BuiltInAgent runs", () => {
  it("each concurrent run's wrapped execute reads its OWN workflowId/runId", async () => {
    // ONE controller (one runtime), shared across both runs — the production shape.
    const { controller } = buildController();
    const middleware = createOpenBoxMiddleware(controller, {});

    const sinkA: { observed?: { workflowId: string; runId: string } } = {};
    const sinkB: { observed?: { workflowId: string; runId: string } } = {};

    const runA = collectEvents(
      middleware.run(
        buildRunAgentInput({ runId: "run-A", threadId: "thread-A" }),
        makeProbeAgent(controller, "call-A", sinkA)
      )
    );
    const runB = collectEvents(
      middleware.run(
        buildRunAgentInput({ runId: "run-B", threadId: "thread-B" }),
        makeProbeAgent(controller, "call-B", sinkB)
      )
    );

    await Promise.all([runA, runB]);

    // Binding reached execute at all (not undefined) — sensitivity guard.
    expect(sinkA.observed, "run A execute saw no run context").toBeDefined();
    expect(sinkB.observed, "run B execute saw no run context").toBeDefined();

    // Correct AND isolated — no crosstalk despite overlapping in-flight executes.
    expect(sinkA.observed).toEqual({ runId: "run-A", workflowId: "thread-A" });
    expect(sinkB.observed).toEqual({ runId: "run-B", workflowId: "thread-B" });
  });
});
