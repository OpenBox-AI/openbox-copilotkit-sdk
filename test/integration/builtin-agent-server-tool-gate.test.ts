/**
 * Phase 5a enforcement matrix — the REAL pre-execution boundary
 * `bundle.serverTool()` adds, replacing the Phase-1 freeze's frozen 0.3.0
 * defect (B1: AG-UI observation is not a pre-execution gate).
 *
 * Two harnesses, matched to what each scenario actually needs to prove:
 *
 *   - A REAL `BuiltInAgent` + `MockLanguageModelV3` (same pattern as
 *     `test/integration/run-context-propagation-spike.test.ts`, the RT-F1
 *     spike this suite builds on) for scenarios that must prove the REAL AI
 *     SDK tool-execution pump's behavior: the UNWRAPPED boundary itself,
 *     ALLOW/BLOCK executing zero-or-once via the pump, concurrent-run
 *     correlation, and no-duplicate-activity (an observer/wrapper race).
 *   - A direct `serverTool()` call (wrapping `controller.runContext.enterRunContext`
 *     to simulate the per-run binding) for the pure governance-outcome matrix
 *     (REQUIRE_APPROVAL/CONSTRAIN/auth/outage policies/missing correlation) —
 *     these scenarios are entirely about what `evaluateLifecycle()` returns
 *     or throws, not about AI-SDK plumbing (mirrors
 *     `test/integration/copilotkit-approval-wait.test.ts`'s own precedent for
 *     the sibling frontend-gate matrix, which uses a `ScriptedAgent` rather
 *     than a real `BuiltInAgent` for the same reason).
 */

import { EventType, type BaseEvent } from "@ag-ui/client";
import { BuiltInAgent, defineTool } from "@copilotkit/runtime/v2";
import { CoreAdapter } from "@openbox-ai/openbox-sdk-ts/adapters";
import { ApprovalPoller, type ApprovalPollerOptions } from "@openbox-ai/openbox-sdk-ts/approvals";
import { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import { OpenBoxConfig, type OnApiError } from "@openbox-ai/openbox-sdk-ts/config";
import { ContextStore } from "@openbox-ai/openbox-sdk-ts/context";
import {
  APPROVAL_SCENARIOS,
  buildConformanceRuntime,
  FakeCore
} from "@openbox-ai/openbox-sdk-ts/conformance";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { CopilotKitGovernanceControlError } from "../../src/copilotkit/governance-control-error.js";
import { createOpenBoxMiddleware } from "../../src/copilotkit/openbox-middleware.js";
import {
  CopilotKitServerToolCorrelationError,
  serverTool
} from "../../src/copilotkit/server-tool.js";

import {
  buildController,
  buildRunAgentInput,
  collectEvents
} from "../unit/copilotkit/test-utils.js";

import type { OpenBoxRuntimeController } from "../../src/copilotkit/types.js";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

const SERVER_TOOL_NAME = "chargeCard";
const SCRIPTED_AMOUNT = 4200;
const CONFORMANCE_API_URL = "https://core.test";
const CONFORMANCE_API_KEY = "obx_test_conformance";

/** A structural server-tool shape for tests that call `serverTool()` directly (no BuiltInAgent). */
interface DirectServerTool {
  execute: (args: unknown, executionOptions?: { toolCallId?: string }) => Promise<unknown>;
  name: string;
}

function scriptedToolCallStream(
  toolCallId: string,
  amount = SCRIPTED_AMOUNT
): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      input: JSON.stringify({ amount }),
      toolCallId,
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
}

/** Real `BuiltInAgent` scripted to emit exactly one `chargeCard` tool call. */
function buildAgent(
  toolCallId: string,
  executeSpy: (args: { amount: number }) => Promise<unknown>
): { agent: BuiltInAgent; model: MockLanguageModelV3 } {
  const tool = defineTool({
    description: "Charge the customer's saved card. Real server-side side effect.",
    execute: executeSpy,
    name: SERVER_TOOL_NAME,
    parameters: z.object({ amount: z.number() })
  });
  const model = new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(scriptedToolCallStream(toolCallId)) })
  });
  return { agent: new BuiltInAgent({ maxSteps: 1, model, tools: [tool] }), model };
}

/** Bind `controller.runContext` for a direct (non-agent) `serverTool()` call. */
function withRunContext<T>(
  controller: OpenBoxRuntimeController,
  ctx: { runId: string; workflowId: string },
  fn: () => Promise<T>
): Promise<T> {
  return controller.runContext.enterRunContext(ctx, fn);
}

/**
 * An `OpenBoxRuntime` wired to `FakeCore` with an explicit `onApiError`
 * policy — `buildConformanceRuntime` always defaults to `fail_open`, so the
 * fail_closed/fail_closed_destructive scenarios (RT-F3) need this instead.
 */
function buildRuntimeWithPolicy(fakeCore: FakeCore, onApiError: OnApiError): OpenBoxRuntime {
  const config = OpenBoxConfig.resolve({
    apiKey: CONFORMANCE_API_KEY,
    apiUrl: CONFORMANCE_API_URL,
    onApiError
  });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    fetchImpl: fakeCore.fetchImpl,
    onApiError: config.onApiError,
    timeoutSeconds: config.timeoutSeconds
  });
  return new OpenBoxRuntime(config, { adapter: new CoreAdapter(), client, contextStore: new ContextStore() });
}

/** Same shape `test/integration/copilotkit-approval-wait.test.ts` uses for a real polling adapter. */
function buildPollingAdapter(fakeCore: FakeCore, pollerOptions: ApprovalPollerOptions = {}): CoreAdapter {
  const client = new OpenBoxClient(CONFORMANCE_API_URL, CONFORMANCE_API_KEY, { fetchImpl: fakeCore.fetchImpl });
  const poller = new ApprovalPoller(client, {
    backoffMultiplier: 1,
    maxWaitMs: 2000,
    pollIntervalMs: 1,
    ...pollerOptions
  });
  return new CoreAdapter({ approvalPoller: poller });
}

describe("UNWRAPPED server tool (documented boundary, reframed from the Phase-1 freeze)", () => {
  it("observation only: execute still runs even though the AG-UI verdict is BLOCK -- documented, not a defect", async () => {
    const executeSpy = vi.fn(async (input: { amount: number }) => ({
      amount: input.amount,
      status: "charged"
    }));
    const { agent, model } = buildAgent("call-unwrapped-1", executeSpy);

    const evaluateMock = vi.fn().mockResolvedValue({ reason: "risk threshold", verdict: "block" });
    const { controller } = buildController({ evaluateMock });
    // No `serverTool()` wrap -- this tool is UNWRAPPED. The frontend gate
    // (`enforceApprovals`) governs only the AG-UI TOOL_CALL_END frame; it
    // never touches the real pump's `execute` call. This IS the documented
    // boundary (Boundaries table, phase-05 plan): unwrapped/MCP/external
    // calls are observation-only, no pre-execution guarantee.
    const middleware = createOpenBoxMiddleware(controller, { enforceApprovals: true });

    const events: BaseEvent[] = await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const blockedFrame = events.find(
      e => e.type === EventType.RUN_ERROR && (e as { code?: string }).code === "governance_blocked"
    );
    expect(blockedFrame, "the frontend gate still recorded + blocked the AG-UI frame").toBeDefined();

    await vi.waitFor(() => {
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
    expect(model.doStreamCalls.length).toBe(1);
    expect(executeSpy.mock.calls[0]?.[0]).toEqual({ amount: SCRIPTED_AMOUNT });
  });
});

describe("wrapped server tool -- ALLOW/BLOCK/HALT via the real BuiltInAgent pump", () => {
  it("ALLOW: execute runs exactly once", async () => {
    const evaluateMock = vi.fn().mockResolvedValue({ verdict: "allow" });
    const { controller } = buildController({ evaluateMock });

    const executeSpy = vi.fn(async (input: { amount: number }) => ({
      amount: input.amount,
      status: "charged"
    }));
    const tool = defineTool({
      description: "Charge the customer's saved card.",
      execute: executeSpy,
      name: SERVER_TOOL_NAME,
      parameters: z.object({ amount: z.number() })
    });
    const wrapped = serverTool(tool, controller, { mode: "enforce" });
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: convertArrayToReadableStream(scriptedToolCallStream("call-allow-1")) })
    });
    const agent = new BuiltInAgent({ maxSteps: 1, model, tools: [wrapped] });

    const middleware = createOpenBoxMiddleware(controller, {});
    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[0]).toEqual({ amount: SCRIPTED_AMOUNT });
  });

  it("BLOCK: execute is called ZERO times -- the pre-execution gate actually stops the real pump (fixes B1)", async () => {
    const evaluateMock = vi.fn().mockResolvedValue({ reason: "risk threshold", verdict: "block" });
    const { controller } = buildController({ evaluateMock });

    const executeSpy = vi.fn(async (input: { amount: number }) => ({
      amount: input.amount,
      status: "charged"
    }));
    const { agent, model } = buildAgent("call-block-1", executeSpy);
    const wrappedTool = serverTool(
      (agent as unknown as { config: { tools: ReturnType<typeof defineTool>[] } }).config.tools[0]!,
      controller,
      { mode: "enforce" }
    );
    const wrappedAgent = new BuiltInAgent({ maxSteps: 1, model, tools: [wrappedTool] });

    const middleware = createOpenBoxMiddleware(controller, {});
    // The AI SDK's OWN tool-execution pump catches the wrapper's rejection
    // and emits a "tool-error" `fullStream` part; `BuiltInAgent.run()` has no
    // case for that part type (only "tool-result"), so it is silently
    // dropped and the run still reaches a normal RUN_FINISHED -- the
    // observable does NOT error. The truthful, asserted claim is narrower
    // (and is exactly B1's fix): `execute` itself never ran.
    await collectEvents(middleware.run(buildRunAgentInput(), wrappedAgent));

    expect(executeSpy).not.toHaveBeenCalled();
    expect(model.doStreamCalls.length).toBe(1);
  });

  it("HALT: execute is called ZERO times", async () => {
    const evaluateMock = vi.fn().mockResolvedValue({ reason: "emergency stop", verdict: "halt" });
    const { controller } = buildController({ evaluateMock });

    const executeSpy = vi.fn(async (input: { amount: number }) => ({ amount: input.amount }));
    const { agent, model } = buildAgent("call-halt-1", executeSpy);
    const wrappedTool = serverTool(
      (agent as unknown as { config: { tools: ReturnType<typeof defineTool>[] } }).config.tools[0]!,
      controller,
      { mode: "enforce" }
    );
    const wrappedAgent = new BuiltInAgent({ maxSteps: 1, model, tools: [wrappedTool] });

    const middleware = createOpenBoxMiddleware(controller, {});
    // Same silently-dropped "tool-error" shape as the BLOCK case above.
    await collectEvents(middleware.run(buildRunAgentInput(), wrappedAgent));

    expect(executeSpy).not.toHaveBeenCalled();
  });
});

describe("wrapped server tool -- REQUIRE_APPROVAL (real ApprovalPoller, direct call)", () => {
  it("approve: waitForDecision resolves allow-shaped -- execute runs once", async () => {
    const scenario = APPROVAL_SCENARIOS.find(s => s.name === "approved-after-one-pending-poll")!;
    const fakeCore = new FakeCore()
      .queueEvaluate({ body: scenario.evaluateResponse })
      .queueApproval(...scenario.pollResponses.map(body => ({ body })));
    const runtime = buildConformanceRuntime(fakeCore, { adapter: buildPollingAdapter(fakeCore) });
    const { controller } = buildController({ runtime });

    const executeSpy = vi.fn(async () => ({ ok: true }));
    const tool: DirectServerTool = { execute: executeSpy, name: SERVER_TOOL_NAME };
    const wrapped = serverTool(tool, controller, { mode: "enforce" });

    const result = await withRunContext(controller, { runId: "run-1", workflowId: "wf-1" }, () =>
      wrapped.execute({ amount: 10 }, { toolCallId: "call-approve-1" })
    );

    expect(result).toEqual({ ok: true });
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(fakeCore.approvalRequests).toHaveLength(2);
  });

  it("reject: execute is called ZERO times", async () => {
    const scenario = APPROVAL_SCENARIOS.find(s => s.name === "rejected")!;
    const fakeCore = new FakeCore()
      .queueEvaluate({ body: scenario.evaluateResponse })
      .queueApproval(...scenario.pollResponses.map(body => ({ body })));
    const runtime = buildConformanceRuntime(fakeCore, { adapter: buildPollingAdapter(fakeCore) });
    const { controller } = buildController({ runtime });

    const executeSpy = vi.fn(async () => ({ ok: true }));
    const tool: DirectServerTool = { execute: executeSpy, name: SERVER_TOOL_NAME };
    const wrapped = serverTool(tool, controller, { mode: "enforce" });

    await expect(
      withRunContext(controller, { runId: "run-1", workflowId: "wf-1" }, () =>
        wrapped.execute({ amount: 10 }, { toolCallId: "call-reject-1" })
      )
    ).rejects.toMatchObject({ reason: "approval_rejected" });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("expire: execute is called ZERO times", async () => {
    const scenario = APPROVAL_SCENARIOS.find(s => s.name === "expired")!;
    const fakeCore = new FakeCore()
      .queueEvaluate({ body: scenario.evaluateResponse })
      .queueApproval(...scenario.pollResponses.map(body => ({ body })));
    const runtime = buildConformanceRuntime(fakeCore, { adapter: buildPollingAdapter(fakeCore) });
    const { controller } = buildController({ runtime });

    const executeSpy = vi.fn(async () => ({ ok: true }));
    const tool: DirectServerTool = { execute: executeSpy, name: SERVER_TOOL_NAME };
    const wrapped = serverTool(tool, controller, { mode: "enforce" });

    await expect(
      withRunContext(controller, { runId: "run-1", workflowId: "wf-1" }, () =>
        wrapped.execute({ amount: 10 }, { toolCallId: "call-expire-1" })
      )
    ).rejects.toMatchObject({ reason: "approval_expired" });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("timeout: Core unreachable on every poll -- execute is called ZERO times", async () => {
    const fakeCore = new FakeCore()
      .queueEvaluate({ body: { approval_id: "appr-timeout", verdict: "require_approval" } })
      .failAllApprovals();
    const runtime = buildConformanceRuntime(fakeCore, {
      adapter: buildPollingAdapter(fakeCore, { maxConsecutiveFailures: 2 })
    });
    const { controller } = buildController({ runtime });

    const executeSpy = vi.fn(async () => ({ ok: true }));
    const tool: DirectServerTool = { execute: executeSpy, name: SERVER_TOOL_NAME };
    const wrapped = serverTool(tool, controller, { mode: "enforce" });

    await expect(
      withRunContext(controller, { runId: "run-1", workflowId: "wf-1" }, () =>
        wrapped.execute({ amount: 10 }, { toolCallId: "call-timeout-1" })
      )
    ).rejects.toMatchObject({ reason: "approval_timeout" });
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

describe("wrapped server tool -- CONSTRAIN (D5)", () => {
  it("CONSTRAIN returns normally from evaluateLifecycle -- the wrapper raises an explicit failure BEFORE execute, never a silent allow", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ body: { verdict: "constrain" } });
    const runtime = buildConformanceRuntime(fakeCore, { adapter: new CoreAdapter() });
    const { controller } = buildController({ runtime });

    const executeSpy = vi.fn(async () => ({ ok: true }));
    const tool: DirectServerTool = { execute: executeSpy, name: SERVER_TOOL_NAME };
    const wrapped = serverTool(tool, controller, { mode: "enforce" });

    await expect(
      withRunContext(controller, { runId: "run-1", workflowId: "wf-1" }, () =>
        wrapped.execute({ amount: 10 }, { toolCallId: "call-constrain-1" })
      )
    ).rejects.toMatchObject({ reason: "unsupported_verdict" });
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

describe("wrapped server tool -- auth/outage policies (RT-F3)", () => {
  it("auth 401 fails closed even under fail_open (never converted to allow) -- execute 0", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ body: {}, status: 401 });
    const runtime = buildRuntimeWithPolicy(fakeCore, "fail_open");
    const { controller } = buildController({ runtime });

    const executeSpy = vi.fn(async () => ({ ok: true }));
    const tool: DirectServerTool = { execute: executeSpy, name: SERVER_TOOL_NAME };
    const wrapped = serverTool(tool, controller, { mode: "enforce" });

    await expect(
      withRunContext(controller, { runId: "run-1", workflowId: "wf-1" }, () =>
        wrapped.execute({ amount: 10 }, { toolCallId: "call-401-1" })
      )
    ).rejects.toThrow(CopilotKitGovernanceControlError);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("genuine outage + fail_open: execute PROCEEDS (fallbackUsed) -- no spans on a lifecycle event, so nothing to fail closed on by policy", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ networkError: "core unreachable" });
    const runtime = buildRuntimeWithPolicy(fakeCore, "fail_open");
    const { controller } = buildController({ runtime });

    const executeSpy = vi.fn(async () => ({ ok: true }));
    const tool: DirectServerTool = { execute: executeSpy, name: SERVER_TOOL_NAME };
    const wrapped = serverTool(tool, controller, { mode: "enforce" });

    const result = await withRunContext(controller, { runId: "run-1", workflowId: "wf-1" }, () =>
      wrapped.execute({ amount: 10 }, { toolCallId: "call-outage-open-1" })
    );

    expect(result).toEqual({ ok: true });
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(fakeCore.evaluateRequests).toHaveLength(1);
  });

  it("genuine outage + fail_closed: execute 0", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ networkError: "core unreachable" });
    const runtime = buildRuntimeWithPolicy(fakeCore, "fail_closed");
    const { controller } = buildController({ runtime });

    const executeSpy = vi.fn(async () => ({ ok: true }));
    const tool: DirectServerTool = { execute: executeSpy, name: SERVER_TOOL_NAME };
    const wrapped = serverTool(tool, controller, { mode: "enforce" });

    await expect(
      withRunContext(controller, { runId: "run-1", workflowId: "wf-1" }, () =>
        wrapped.execute({ amount: 10 }, { toolCallId: "call-outage-closed-1" })
      )
    ).rejects.toThrow(CopilotKitGovernanceControlError);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("RT-F3 (documented, asserted): fail_closed_destructive + outage still PROCEEDS -- the server-tool/lifecycle gate carries no spans, so it can never be classified destructive; fail_closed is the setting for hard outage blocking", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ networkError: "core unreachable" });
    const runtime = buildRuntimeWithPolicy(fakeCore, "fail_closed_destructive");
    const { controller } = buildController({ runtime });

    const executeSpy = vi.fn(async () => ({ ok: true }));
    const tool: DirectServerTool = { execute: executeSpy, name: SERVER_TOOL_NAME };
    const wrapped = serverTool(tool, controller, { mode: "enforce" });

    const result = await withRunContext(controller, { runId: "run-1", workflowId: "wf-1" }, () =>
      wrapped.execute({ amount: 10 }, { toolCallId: "call-outage-destructive-1" })
    );

    expect(result).toEqual({ ok: true });
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("wrapped server tool -- fail-safe on missing run correlation (enforce mode)", () => {
  it("no per-run context AND no executionOptions.toolCallId -- fails safe, execute 0", async () => {
    const { controller } = buildController();
    const executeSpy = vi.fn(async () => ({ ok: true }));
    const tool: DirectServerTool = { execute: executeSpy, name: SERVER_TOOL_NAME };
    const wrapped = serverTool(tool, controller, { mode: "enforce" });

    // No `enterRunContext` scope, no `executionOptions` -- both halves of the
    // compat guard are absent simultaneously.
    await expect(wrapped.execute({ amount: 10 })).rejects.toThrow(
      CopilotKitServerToolCorrelationError
    );
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("per-run context present but executionOptions.toolCallId absent (peer-seam regression) -- fails safe, execute 0", async () => {
    const { controller } = buildController();
    const executeSpy = vi.fn(async () => ({ ok: true }));
    const tool: DirectServerTool = { execute: executeSpy, name: SERVER_TOOL_NAME };
    const wrapped = serverTool(tool, controller, { mode: "enforce" });

    await expect(
      withRunContext(controller, { runId: "run-1", workflowId: "wf-1" }, () =>
        wrapped.execute({ amount: 10 })
      )
    ).rejects.toThrow(CopilotKitServerToolCorrelationError);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("telemetry mode (the default) never fails safe on the SAME missing correlation -- it synthesizes generated ids and still runs execute", async () => {
    const { controller } = buildController();
    const executeSpy = vi.fn(async () => ({ ok: true }));
    const tool: DirectServerTool = { execute: executeSpy, name: SERVER_TOOL_NAME };
    // No `mode` -- defaults to "telemetry".
    const wrapped = serverTool(tool, controller);

    const result = await wrapped.execute({ amount: 10 });

    expect(result).toEqual({ ok: true });
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("wrapped server tool -- concurrency + no duplicate OpenBox activity", () => {
  it("concurrent wrapped runs keep correct (runId, toolCallId) correlation (extends RT-F1 through the wrapper)", async () => {
    const evaluateMock = vi.fn().mockResolvedValue({ verdict: "allow" });
    const { controller } = buildController({ evaluateMock });
    const middleware = createOpenBoxMiddleware(controller, {});

    const sinkA: { observed?: { runId: string; workflowId: string } | undefined } = {};
    const sinkB: { observed?: { runId: string; workflowId: string } | undefined } = {};

    function buildProbeAgent(
      toolCallId: string,
      sink: { observed?: { runId: string; workflowId: string } | undefined }
    ): BuiltInAgent {
      const tool = defineTool({
        description: "Records the OpenBox per-run context observed inside a WRAPPED execute.",
        execute: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          sink.observed = controller.runContext.currentRunContext();
          return { recorded: true };
        },
        name: SERVER_TOOL_NAME,
        parameters: z.object({ amount: z.number() })
      });
      const wrapped = serverTool(tool, controller, { mode: "enforce" });
      const model = new MockLanguageModelV3({
        doStream: async () => ({ stream: convertArrayToReadableStream(scriptedToolCallStream(toolCallId)) })
      });
      return new BuiltInAgent({ maxSteps: 1, model, tools: [wrapped] });
    }

    const runA = collectEvents(
      middleware.run(
        buildRunAgentInput({ runId: "run-A", threadId: "thread-A" }),
        buildProbeAgent("call-A", sinkA)
      )
    );
    const runB = collectEvents(
      middleware.run(
        buildRunAgentInput({ runId: "run-B", threadId: "thread-B" }),
        buildProbeAgent("call-B", sinkB)
      )
    );

    await Promise.all([runA, runB]);

    expect(sinkA.observed).toEqual({ runId: "run-A", workflowId: "thread-A" });
    expect(sinkB.observed).toEqual({ runId: "run-B", workflowId: "thread-B" });
  });

  it("a wrapped call emits NO duplicate OpenBox activity -- the AG-UI observer is suppressed on the owned (runId, toolCallId) key", async () => {
    const evaluateMock = vi.fn().mockResolvedValue({ verdict: "allow" });
    const { controller } = buildController({ evaluateMock });

    const executeSpy = vi.fn(async (input: { amount: number }) => ({ amount: input.amount }));
    const { agent } = buildAgent("call-dup-1", executeSpy);
    const wrappedTool = serverTool(
      (agent as unknown as { config: { tools: ReturnType<typeof defineTool>[] } }).config.tools[0]!,
      controller,
      { mode: "enforce" }
    );
    const wrappedAgent = new BuiltInAgent({ maxSteps: 1, model: (agent as unknown as { config: { model: MockLanguageModelV3 } }).config.model, tools: [wrappedTool] });

    const onEvent = vi.fn();
    const middleware = createOpenBoxMiddleware(controller, { onEvent });
    await collectEvents(middleware.run(buildRunAgentInput(), wrappedAgent));

    // The wrapper's OWN evaluate call (via `evaluateLifecycle`) does not
    // route through `onEvent` (it is a separate boundary — see
    // `server-tool.ts`), so `onEvent` here would only ever fire from the
    // AG-UI OBSERVER path. Assert it never recorded an ActivityStarted for
    // this call — the observer's `isOwned` suppression fired instead.
    const activityStartedEmissions = onEvent.mock.calls
      .map(args => args[0] as { activityId?: string; eventType: string })
      .filter(emission => emission.activityId === "call-dup-1");
    expect(activityStartedEmissions).toHaveLength(0);
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});
