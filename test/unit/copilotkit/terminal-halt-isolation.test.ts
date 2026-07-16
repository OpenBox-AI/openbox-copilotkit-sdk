import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import { createOpenBoxMiddleware } from "../../../src/copilotkit/openbox-middleware.js";

import {
  ScriptedAgent,
  buildController,
  buildRunAgentInput,
  collectEvents
} from "./test-utils.js";

/**
 * RT-F14: `openbox-middleware.ts` calls the BASE `ContextStore.clearHalt`
 * on every run terminal so the base's per-run HALT set stays bounded (the
 * base provides no stop-signal FIFO — see `openbox-sdk-ts/src/context/index.ts`).
 * These tests use the REAL base `ContextStore` (via the test controller's
 * `runtime.contextStore` stand-in — see `test-utils.ts`), never a mock of
 * its own halt-scoping logic, to prove the CONSUMER-side call is correctly
 * scoped: clearing run A's halt must never clear a concurrent run B's halt
 * on the SAME workflow.
 */
describe("terminal HALT isolation (RT-F14)", () => {
  it("clearHalt on run A's terminal event does not affect a concurrent run B on the same workflow", async () => {
    const { controller } = buildController();
    const middleware = createOpenBoxMiddleware(controller);
    const contextStore = controller.runtime.contextStore;
    const workflowId = "thread-shared";

    contextStore.requestHalt(workflowId, "run-A");
    contextStore.requestHalt(workflowId, "run-B");
    expect(contextStore.isHaltRequested(workflowId, "run-A")).toBe(true);
    expect(contextStore.isHaltRequested(workflowId, "run-B")).toBe(true);

    const agent = new ScriptedAgent({ events: [{ type: EventType.RUN_FINISHED } as BaseEvent] });
    await collectEvents(
      middleware.run(buildRunAgentInput({ runId: "run-A", threadId: workflowId }), agent)
    );

    expect(contextStore.isHaltRequested(workflowId, "run-A")).toBe(false);
    expect(contextStore.isHaltRequested(workflowId, "run-B")).toBe(true);
  });

  it("clears HALT on a RUN_ERROR terminal too", async () => {
    const { controller } = buildController();
    const middleware = createOpenBoxMiddleware(controller);
    const contextStore = controller.runtime.contextStore;
    const workflowId = "thread-error";

    contextStore.requestHalt(workflowId, "run-C");

    const agent = new ScriptedAgent({
      events: [{ code: "boom", message: "explosion", type: EventType.RUN_ERROR } as BaseEvent]
    });
    await collectEvents(
      middleware.run(buildRunAgentInput({ runId: "run-C", threadId: workflowId }), agent)
    );

    expect(contextStore.isHaltRequested(workflowId, "run-C")).toBe(false);
  });

  it("clears HALT on an interrupted run's terminal event too (the run's stream is still over)", async () => {
    const { controller } = buildController();
    const middleware = createOpenBoxMiddleware(controller);
    const contextStore = controller.runtime.contextStore;
    const workflowId = "thread-interrupt";

    contextStore.requestHalt(workflowId, "run-D");

    const agent = new ScriptedAgent({
      events: [
        {
          outcome: {
            interrupts: [{ id: "int-1", reason: "approval_required" }],
            type: "interrupt"
          },
          type: EventType.RUN_FINISHED
        } as unknown as BaseEvent
      ]
    });
    await collectEvents(
      middleware.run(buildRunAgentInput({ runId: "run-D", threadId: workflowId }), agent)
    );

    expect(contextStore.isHaltRequested(workflowId, "run-D")).toBe(false);
  });

  it("isolates HALT across 2 concurrent runs sharing a runtime, run by run", async () => {
    const { controller } = buildController();
    const middleware = createOpenBoxMiddleware(controller);
    const contextStore = controller.runtime.contextStore;
    const workflowId = "thread-concurrent";

    contextStore.requestHalt(workflowId, "run-E");
    contextStore.requestHalt(workflowId, "run-F");

    const agentE = new ScriptedAgent({ events: [{ type: EventType.RUN_FINISHED } as BaseEvent] });
    const agentF = new ScriptedAgent({ events: [{ type: EventType.RUN_FINISHED } as BaseEvent] });

    await Promise.all([
      collectEvents(
        middleware.run(buildRunAgentInput({ runId: "run-E", threadId: workflowId }), agentE)
      ),
      collectEvents(
        middleware.run(buildRunAgentInput({ runId: "run-F", threadId: workflowId }), agentF)
      )
    ]);

    expect(contextStore.isHaltRequested(workflowId, "run-E")).toBe(false);
    expect(contextStore.isHaltRequested(workflowId, "run-F")).toBe(false);
  });
});
