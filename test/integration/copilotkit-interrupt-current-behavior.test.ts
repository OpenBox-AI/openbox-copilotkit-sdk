import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BaseEvent } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import { createOpenBoxMiddleware } from "../../src/copilotkit/openbox-middleware.js";
import { WorkflowEventType } from "../../src/types/workflow-event-type.js";

import {
  ScriptedAgent,
  buildController,
  buildRunAgentInput,
  collectEvents
} from "../unit/copilotkit/test-utils.js";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/interrupt");

interface InterruptFixture {
  description: string;
  events: BaseEvent[];
}

function loadFixture(name: string): InterruptFixture {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), "utf8")) as InterruptFixture;
}

async function recordEvaluatePayloads(events: BaseEvent[]): Promise<Record<string, unknown>[]> {
  const { controller, evaluateMock } = buildController();
  const middleware = createOpenBoxMiddleware(controller, { frontendToolNames: [] });
  const agent = new ScriptedAgent({ events });
  await collectEvents(middleware.run(buildRunAgentInput(), agent));
  return evaluateMock.mock.calls.map(call => call[0] as Record<string, unknown>);
}

function byEventType(
  payloads: Record<string, unknown>[],
  type: string
): Record<string, unknown>[] {
  return payloads.filter(p => p["event_type"] === type);
}

/**
 * FREEZE (Phase 1 — defect B3). The 0.3.0 RUN_FINISHED handler
 * (`openbox-middleware.ts` `case EventType.RUN_FINISHED`) ignores
 * `event.outcome` entirely: it flushes pending tool calls as
 * `ActivityCompleted(status:"completed")` and always emits `WorkflowCompleted`.
 * So an INTERRUPTED run is reported as a successful completion. These tests
 * assert that (buggy) current behavior; Phase 4 INVERTS the marked assertions.
 */
describe("interrupt handling — current 0.3.0 behavior (defect B3, frozen)", () => {
  it("reports an interrupt as a successful workflow completion (BuiltInAgent shape)", async () => {
    const { events } = loadFixture("run-finished-interrupt");
    const payloads = await recordEvaluatePayloads(events);

    const completedActivities = byEventType(payloads, WorkflowEventType.ACTIVITY_COMPLETED);
    // BUG B3: the suspended (never-resulted) tool is flushed as "completed".
    expect(completedActivities.length).toBeGreaterThan(0);
    expect(completedActivities[0]?.["status"]).toBe("completed");
    // PHASE-4 WILL INVERT: an interrupted tool must NOT emit ActivityCompleted(completed)
    //                      (expected "aborted" / no completion).

    // BUG B3: interrupt outcome still produces a WorkflowCompleted.
    expect(byEventType(payloads, WorkflowEventType.WORKFLOW_COMPLETED).length).toBe(1);
    // PHASE-4 WILL INVERT: an interrupted run emits 0 WorkflowCompleted.
  });

  it("also mis-reports the non-BuiltInAgent interrupt shape (id !== toolCallId) as completed", async () => {
    const { events } = loadFixture("run-finished-interrupt-non-builtin");
    const payloads = await recordEvaluatePayloads(events);

    // Same B3 defect regardless of interrupt-id keying — documents that Phase 4
    // must key on the interrupt `id`, not `toolCallId`.
    expect(byEventType(payloads, WorkflowEventType.WORKFLOW_COMPLETED).length).toBe(1);
    // PHASE-4 WILL INVERT: 0 WorkflowCompleted for an interrupted run.
  });

  it("correctly completes a successful run whose RUN_FINISHED has no outcome (RT-F11 — must NOT regress)", async () => {
    const { events } = loadFixture("run-finished-success-no-outcome");
    const payloads = await recordEvaluatePayloads(events);

    // This is CORRECT behavior and must stay green through Phase 4: a success
    // RUN_FINISHED (no `outcome`) yields exactly one WorkflowCompleted.
    expect(byEventType(payloads, WorkflowEventType.WORKFLOW_COMPLETED).length).toBe(1);
  });
});
