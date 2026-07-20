/**
 * Versioned contract (peer-seam) test: pins that a REAL BuiltInAgent tool
 * `execute` is invoked with a SECOND `executionOptions` argument carrying
 * `toolCallId`, on the exact peers this SDK is built against (CopilotKit
 * 1.61.2 / AI SDK 6.0.214 — see package.json devDependencies).
 *
 * Why this matters: `@copilotkit/runtime/v2`'s OWN `ToolDefinition.execute`
 * type declares only ONE parameter (`(args) => Promise<unknown>`) — but
 * `convertToolDefinitionsToVercelAITools` (dist/agent/index.mjs) forwards the
 * SAME function reference straight into the AI SDK's `tool()` call
 * (`execute: tool.execute`, no wrapping). At runtime, the AI SDK v6
 * `streamText` tool-execution pump always calls `execute(input, options)`
 * where `options.toolCallId` is a real, always-present field
 * (`ToolExecutionOptions` in `@ai-sdk/provider-utils`). `serverTool()`
 * (`src/copilotkit/server-tool.ts`) depends ENTIRELY on this undocumented
 * (from CopilotKit's own type's perspective) seam to recover per-call
 * correlation for its enforce-mode gate.
 *
 * If a peer upgrade silently drops this seam, THIS test fails first — loudly,
 * in CI — rather than surfacing as a confusing missing-correlation fail-safe
 * in production. Per the phase-05 risk mitigation: a peer that drops this
 * seam must disable hard server-tool enforcement (fail-safe), never fall
 * back to late AG-UI blocking (that would resurrect the B1 overclaim).
 */
import { BuiltInAgent, defineTool } from "@copilotkit/runtime/v2";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildRunAgentInput, collectEvents } from "../unit/copilotkit/test-utils.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

const TOOL_NAME = "pinnedExecutionOptionsProbe";
const TOOL_CALL_ID = "call-pin-execution-options-1";

function toolCallStream(): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      input: JSON.stringify({ probe: true }),
      toolCallId: TOOL_CALL_ID,
      toolName: TOOL_NAME,
      type: "tool-call"
    },
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

describe("contract: executionOptions.toolCallId reaches a real BuiltInAgent tool execute (CopilotKit 1.61.2 / AI SDK 6.0.214)", () => {
  it("passes a second executionOptions argument carrying the scripted toolCallId", async () => {
    const seenExecutionOptions: unknown[] = [];
    const tool = defineTool({
      description: "Pins the AI SDK execute(args, executionOptions) seam server-tool.ts depends on.",
      execute: async (_args: unknown, executionOptions?: unknown) => {
        seenExecutionOptions.push(executionOptions);
        return { ok: true };
      },
      name: TOOL_NAME,
      parameters: z.object({ probe: z.boolean() })
    });

    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: convertArrayToReadableStream(toolCallStream()) })
    });
    // Called directly (no OpenBox middleware) -- this test pins the RAW
    // CopilotKit/AI-SDK peer contract, independent of this SDK's own wrapper.
    const agent = new BuiltInAgent({ maxSteps: 1, model, tools: [tool] });

    await collectEvents(agent.run(buildRunAgentInput()));

    expect(seenExecutionOptions).toHaveLength(1);
    const executionOptions = seenExecutionOptions[0];
    expect(executionOptions).toBeDefined();
    expect((executionOptions as { toolCallId?: unknown }).toolCallId).toBe(TOOL_CALL_ID);
  });
});
