/**
 * FREEZE TEST — Phase 1 ("freeze the contract") of the OpenBox governance
 * migration. This test PINS the current 0.3.0 DEFECTIVE behavior so later phases
 * can prove they changed it.
 *
 * SETUP: a REAL CopilotKit `BuiltInAgent` (runtime v2) is driven by a mock LLM
 * (`MockLanguageModelV3`) scripted to emit a single tool call to a SERVER tool
 * (`chargeCard`, whose `execute` is a vitest spy). That agent is wrapped by the
 * OpenBox AG-UI middleware with `enforceApprovals: true`, backed by a controller
 * whose `client.evaluate` returns a `{ verdict: "block" }` verdict (shape mirrors
 * test/fixtures/governance-verdict-responses/block-minimal.json, which
 * `shouldBlock` -> `Verdict.shouldStop` recognizes).
 *
 * DEFECTS FROZEN HERE:
 *
 *   B1 — AG-UI observation is NOT a pre-execution gate. The middleware only
 *        OBSERVES the agent's event stream. Inside `BuiltInAgent`, the AI SDK
 *        `streamText` pump invokes the tool's `execute` as it parses the model's
 *        tool-call — at or before the point it emits the AG-UI TOOL_CALL_* events.
 *        By the time the middleware sees TOOL_CALL_END and calls `evaluate`, the
 *        server-side side effect has already happened.
 *
 *   B2 — A BLOCK / REQUIRE_APPROVAL verdict never WAITS for or cancels execution.
 *        The middleware injects a redacted `governance_blocked` error frame into
 *        the DOWNSTREAM observable (post-hoc) and unsubscribes, but the agent's
 *        fire-and-forget pump is never paused or aborted, so the tool still runs.
 *
 * PROOF the spy fires from the REAL pump (not from this test calling it): the
 * tool call originates from `MockLanguageModelV3.doStream` -> AI SDK `streamText`
 * -> tool `execute`. We assert (a) the mock model's `doStream` was invoked, and
 * (b) `execute` received exactly the args the model scripted. The test never calls
 * `execute` itself.
 *
 * PHASE 4/5 will INVERT the defect assertions: a wrapped + BLOCKED server tool
 * must end with an `execute` call count of 0. Every assertion that a later phase
 * must flip is tagged `// PHASE-4/5 WILL INVERT:` inline.
 */

import { EventType, type BaseEvent } from "@ag-ui/client";
import { BuiltInAgent, defineTool } from "@copilotkit/runtime/v2";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createOpenBoxMiddleware } from "../../src/copilotkit/openbox-middleware.js";

import {
  buildController,
  buildRunAgentInput,
  collectEvents
} from "../unit/copilotkit/test-utils.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

const SERVER_TOOL_NAME = "chargeCard";
const SCRIPTED_TOOL_CALL_ID = "call-charge-card-1";
const SCRIPTED_AMOUNT = 4200;

const GOVERNANCE_BLOCKED_ERROR_CODE = "governance_blocked";

// BLOCK verdict as the wire object the middleware's `shouldBlock` reads. Mirrors
// test/fixtures/governance-verdict-responses/block-minimal.json.
const BLOCK_VERDICT = {
  reason: "Tool call exceeds risk threshold",
  verdict: "block"
} as const;

/**
 * Low-level LanguageModelV3 stream parts for a single server-tool call. The AI
 * SDK v6 `streamText` pump inside BuiltInAgent parses the `tool-call` part,
 * validates its `input` against the tool's Zod schema, and invokes `execute`.
 */
const scriptedToolCallStream: LanguageModelV3StreamPart[] = [
  { type: "stream-start", warnings: [] },
  {
    input: JSON.stringify({ amount: SCRIPTED_AMOUNT }),
    toolCallId: SCRIPTED_TOOL_CALL_ID,
    toolName: SERVER_TOOL_NAME,
    type: "tool-call"
  },
  {
    finishReason: { raw: "tool-calls", unified: "tool-calls" },
    type: "finish",
    usage: {
      inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
      outputTokens: { reasoning: 0, text: 0, total: 4 }
    }
  }
];

describe("BuiltInAgent server-tool gate (frozen 0.3.0 defect)", () => {
  it("runs the server tool's execute even though AG-UI verdict is BLOCK", async () => {
    // Server-side side effect under governance. This is the spy that MUST NOT
    // fire once B1/B2 are fixed.
    const executeSpy = vi.fn(async (input: { amount: number }) => ({
      amount: input.amount,
      status: "charged"
    }));

    const chargeCard = defineTool({
      description:
        "Charge the customer's saved card. Real server-side side effect.",
      execute: executeSpy,
      name: SERVER_TOOL_NAME,
      parameters: z.object({ amount: z.number() })
    });

    // A REAL BuiltInAgent driven by the mock model. `maxSteps: 1` keeps it to a
    // single tool-calling step (no second model round-trip).
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream(scriptedToolCallStream)
      })
    });
    const agent = new BuiltInAgent({
      maxSteps: 1,
      model,
      tools: [chargeCard]
    });

    // Controller whose evaluate() always returns BLOCK; enforceApprovals arms the
    // middleware to inject a governance_blocked frame on a stop verdict.
    const evaluateMock = vi.fn().mockResolvedValue(BLOCK_VERDICT);
    const { controller } = buildController({ evaluateMock });
    const middleware = createOpenBoxMiddleware(controller, {
      enforceApprovals: true
    });

    const events: BaseEvent[] = await collectEvents(
      middleware.run(buildRunAgentInput(), agent)
    );

    // Governance DID fire and DID decide to block: the middleware emitted the
    // redacted governance_blocked error frame downstream. Proves enforcement ran.
    const blockedFrame = events.find(
      event =>
        event.type === EventType.RUN_ERROR &&
        (event as BaseEvent & { code?: string }).code ===
          GOVERNANCE_BLOCKED_ERROR_CODE
    );
    expect(blockedFrame).toBeDefined();

    // The agent's fire-and-forget streamText pump runs the tool independently of
    // the middleware's downstream block, so wait for it to settle before asserting.
    await vi.waitFor(() => {
      // PHASE-4/5 WILL INVERT: after the pre-execution gate lands, a BLOCKED
      // server tool must NOT execute -> expect(executeSpy).not.toHaveBeenCalled().
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    // Proof the call came from the REAL pump: the mock model was actually driven,
    // and execute received exactly the args the model scripted (routed through
    // BuiltInAgent -> AI SDK streamText -> execute). The test never calls execute.
    expect(model.doStreamCalls.length).toBe(1);
    expect(executeSpy.mock.calls[0]?.[0]).toEqual({ amount: SCRIPTED_AMOUNT });

    // PHASE-4/5 WILL INVERT: the tool result must never materialize for a BLOCKED
    // call. Today it does, because execute ran to completion.
    await expect(executeSpy.mock.results[0]?.value).resolves.toEqual({
      amount: SCRIPTED_AMOUNT,
      status: "charged"
    });
  });
});
