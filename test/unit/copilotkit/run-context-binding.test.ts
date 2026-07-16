import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import { createOpenBoxMiddleware } from "../../../src/copilotkit/openbox-middleware.js";

import { ScriptedAgent, buildController, buildRunAgentInput, collectEvents } from "./test-utils.js";

/**
 * Proves `#processStream` binds the per-run context store (D7) by wrapping
 * `source.subscribe` — using `input.threadId`/`input.runId` captured at
 * `run()` entry, not the RUN_STARTED handler — so `currentRunContext()`
 * resolves to this run's ids for the whole async lifetime of its event
 * processing, and that two interleaved runs sharing the same controller
 * never cross-observe each other's context (standard `AsyncLocalStorage`
 * isolation — already unit-tested directly on `RunContextStore` itself in
 * `run-context-store.test.ts`; this file proves the MIDDLEWARE actually
 * wires it at the `source.subscribe` boundary).
 *
 * `onEvent` is used as the observation point here because it fires
 * synchronously from inside the emitter, itself called from inside
 * `#handleEvent`, itself called from inside the `next`/`complete` callbacks
 * passed to `source.subscribe` — i.e. from within the bound scope. Whether a
 * REAL tool `execute()` sees this context (Phase 5's server-tool wrapper) is
 * proven by the Phase 5 real-agent spike, not by this unit test.
 */
describe("run-context binding — #processStream wraps source.subscribe", () => {
  it("currentRunContext() resolves to this run's ids for every emission inside the subscribe scope, and does not leak once the run ends", async () => {
    const { controller } = buildController();
    const observed: Array<{ runId: string; workflowId: string } | undefined> = [];
    const middleware = createOpenBoxMiddleware(controller, {
      onEvent: () => {
        observed.push(controller.runContext.currentRunContext());
      }
    });
    const agent = new ScriptedAgent({
      events: [{ type: EventType.RUN_FINISHED } as BaseEvent]
    });

    await collectEvents(
      middleware.run(buildRunAgentInput({ runId: "run-X", threadId: "thread-X" }), agent)
    );

    expect(observed.length).toBeGreaterThan(0);
    for (const ctx of observed) {
      expect(ctx).toEqual({ runId: "run-X", workflowId: "thread-X" });
    }

    // The context does not leak past the run's own subscribe() scope.
    expect(controller.runContext.currentRunContext()).toBeUndefined();
  });

  it("isolates two interleaved concurrent runs on the SAME middleware instance — neither observes the other's ids", async () => {
    const { controller } = buildController();
    const observations: Array<{
      eventWorkflowId: string;
      ctx: { runId: string; workflowId: string } | undefined;
    }> = [];
    const middleware = createOpenBoxMiddleware(controller, {
      onEvent: emission => {
        observations.push({
          ctx: controller.runContext.currentRunContext(),
          eventWorkflowId: emission.workflowId
        });
      }
    });

    const buildAgent = (label: string) =>
      new ScriptedAgent({
        events: [
          { messageId: label, role: "assistant", type: EventType.TEXT_MESSAGE_START } as BaseEvent,
          {
            delta: `hello from ${label}`,
            messageId: label,
            type: EventType.TEXT_MESSAGE_CONTENT
          } as BaseEvent,
          { messageId: label, type: EventType.TEXT_MESSAGE_END } as BaseEvent,
          { type: EventType.RUN_FINISHED } as BaseEvent
        ]
      });

    await Promise.all([
      collectEvents(
        middleware.run(buildRunAgentInput({ runId: "run-A", threadId: "thread-A" }), buildAgent("A"))
      ),
      collectEvents(
        middleware.run(buildRunAgentInput({ runId: "run-B", threadId: "thread-B" }), buildAgent("B"))
      )
    ]);

    const observedA = observations.filter(o => o.eventWorkflowId === "thread-A");
    const observedB = observations.filter(o => o.eventWorkflowId === "thread-B");
    expect(observedA.length).toBeGreaterThan(0);
    expect(observedB.length).toBeGreaterThan(0);

    for (const { ctx } of observedA) {
      expect(ctx).toEqual({ runId: "run-A", workflowId: "thread-A" });
    }
    for (const { ctx } of observedB) {
      expect(ctx).toEqual({ runId: "run-B", workflowId: "thread-B" });
    }
  });
});
