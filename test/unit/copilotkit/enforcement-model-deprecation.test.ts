/**
 * Deprecation test (phase 5a): `enforceApprovals: true` must map ONLY to
 * frontend AG-UI `TOOL_CALL_END` enforcement, plus a one-time runtime
 * warning that server tools are NOT covered — never universal server-tool
 * enforcement. `bundle.serverTool()`'s own `enforcementOptions` (an entirely
 * separate parameter, unrelated to `OpenBoxMiddlewareOptions.enforceApprovals`)
 * is the only thing that governs a wrapped tool's `execute`.
 */
import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, it, vi } from "vitest";

import { GOVERNANCE_BLOCKED_ERROR_CODE } from "../../../src/copilotkit/governance-blocked-error.js";
import { createOpenBoxMiddleware } from "../../../src/copilotkit/openbox-middleware.js";
import { serverTool } from "../../../src/copilotkit/server-tool.js";

import {
  ScriptedAgent,
  buildController,
  buildRunAgentInput,
  collectEvents
} from "./test-utils.js";

const TOOL_NAME = "setThemeColor";
const TOOL_CALL_ID = "call-1";

const BLOCK_VERDICT = { reason: "policy denied", verdict: "block" } as const;

function scriptedToolCallEvents(): BaseEvent[] {
  return [
    { toolCallId: TOOL_CALL_ID, toolCallName: TOOL_NAME, type: EventType.TOOL_CALL_START } as BaseEvent,
    { delta: '{"color":"blue"}', toolCallId: TOOL_CALL_ID, type: EventType.TOOL_CALL_ARGS } as BaseEvent,
    { toolCallId: TOOL_CALL_ID, type: EventType.TOOL_CALL_END } as BaseEvent,
    { type: EventType.RUN_FINISHED } as BaseEvent
  ];
}

function findBlockedFrame(events: BaseEvent[]): BaseEvent | undefined {
  return events.find(
    e => e.type === EventType.RUN_ERROR && (e as { code?: string }).code === GOVERNANCE_BLOCKED_ERROR_CODE
  );
}

describe("enforceApprovals:true (deprecated) -- frontend-only enforcement + warning", () => {
  it("warns once that server tools are not covered, and still blocks the frontend TOOL_CALL_END gate", async () => {
    const evaluateMock = vi.fn().mockResolvedValue(BLOCK_VERDICT);
    const { controller, logger } = buildController({ evaluateMock });

    const middleware = createOpenBoxMiddleware(controller, {
      enforceApprovals: true,
      frontendToolNames: [TOOL_NAME]
    });

    const events = await collectEvents(
      middleware.run(buildRunAgentInput(), new ScriptedAgent({ events: scriptedToolCallEvents() }))
    );

    expect(findBlockedFrame(events)).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "deprecated_enforce_approvals" })
    );
  });

  it("does NOT warn when enforcement.frontendTools is explicitly set (the replacement wins, silencing the deprecated boolean)", async () => {
    const evaluateMock = vi.fn().mockResolvedValue({ verdict: "allow" });
    const { controller, logger } = buildController({ evaluateMock });

    createOpenBoxMiddleware(controller, {
      enforceApprovals: true,
      enforcement: { frontendTools: "observe" },
      frontendToolNames: [TOOL_NAME]
    });

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "deprecated_enforce_approvals" })
    );
  });

  it("enforcement.frontendTools explicit wins over the deprecated boolean: 'observe' means the block verdict never gates the frontend call", async () => {
    const evaluateMock = vi.fn().mockResolvedValue(BLOCK_VERDICT);
    const { controller } = buildController({ evaluateMock });

    const middleware = createOpenBoxMiddleware(controller, {
      enforceApprovals: true,
      enforcement: { frontendTools: "observe" },
      frontendToolNames: [TOOL_NAME]
    });

    const events = await collectEvents(
      middleware.run(buildRunAgentInput(), new ScriptedAgent({ events: scriptedToolCallEvents() }))
    );

    // Observe mode: a BLOCK verdict is recorded as telemetry only -- no
    // governance_blocked frame, and the tool call's TOOL_CALL_END still forwards.
    expect(findBlockedFrame(events)).toBeUndefined();
    expect(events.some(e => e.type === EventType.TOOL_CALL_END)).toBe(true);
  });

  it("never treats enforceApprovals:true as universal server-tool enforcement -- a bundle.serverTool()-wrapped tool's execute is UNAFFECTED by the middleware's enforceApprovals flag", async () => {
    // Same controller/evaluateMock the frontend gate above uses to block --
    // proves the wrapped tool's execute running is not because governance
    // allowed it, but because `serverTool()`'s OWN enforcement mode (default
    // "telemetry", entirely separate from `enforceApprovals`) never gates.
    const evaluateMock = vi.fn().mockResolvedValue(BLOCK_VERDICT);
    const { controller } = buildController({ evaluateMock });

    // The middleware is configured with the deprecated flag exactly as a
    // real caller might mistakenly assume covers "everything".
    createOpenBoxMiddleware(controller, { enforceApprovals: true });

    const executeSpy = vi.fn(async (args: { amount: number }) => ({ charged: args.amount }));
    const tool: {
      execute: (args: { amount: number }, executionOptions?: { toolCallId?: string }) => Promise<{ charged: number }>;
      name: string;
    } = { execute: executeSpy, name: "chargeCard" };
    const wrapped = serverTool(
      tool,
      controller
      // No enforcementOptions passed -- defaults to `{ mode: "telemetry" }`,
      // independent of the middleware's `enforceApprovals` above.
    );

    const result = await wrapped.execute({ amount: 500 }, { toolCallId: "call-charge-1" });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ charged: 500 });
  });
});
