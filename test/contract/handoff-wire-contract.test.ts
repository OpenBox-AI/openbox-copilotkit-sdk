import { describe, expect, it } from "vitest";

import { OpenBoxCopilotKitEmitter } from "../../src/copilotkit/openbox-emitter.js";
import { WorkflowEventType } from "../../src/types/workflow-event-type.js";

import { buildController } from "../unit/copilotkit/test-utils.js";

/**
 * FREEZE (Phase 1 / Decision D1).
 *
 * Core `ValidateHandoffPayload` requires exactly two fields on a Handoff:
 * `multi_agent_session_id` + `from_agent_did` (openbox-core
 * `internal/content/governance.go` `ValidateHandoffPayload`). The receiver
 * (`to_agent`) is derived server-side from the authenticated emitter's signed
 * AIP headers, NOT the payload. So the two-field marker is *sufficient*, not a
 * gap — this freezes that contract so Phase 5's migration to the base
 * `handoff({fromAgentDid, multiAgentSessionId})` factory (itself two-field —
 * `emitHandoff` now builds its WIRE envelope via `buildHandoffEnvelope`, see
 * `openbox-emitter.ts`) is a provably faithful swap. `emitHandoff`'s second
 * argument is a base `OpenBoxClient` (child-scoped in production; here it is
 * `controller.runtime.client` for convenience — this test only cares that
 * SOME base client's `.evaluate` receives the two required fields).
 */
describe("wire contract: Handoff carries the two Core-required fields", () => {
  it("emits from_agent_did + multi_agent_session_id (and the HANDOFF event_type)", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    await emitter.emitHandoff(
      {
        fromAgentDid: "did:openbox:parent-agent",
        multiAgentSessionId: "mas:run-1",
        runId: "run-1",
        workflowId: "thread-1"
      },
      controller.runtime.client
    );

    expect(evaluateMock).toHaveBeenCalledTimes(1);
    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(payload["from_agent_did"]).toBe("did:openbox:parent-agent");
    expect(payload["multi_agent_session_id"]).toBe("mas:run-1");
    expect(payload["event_type"]).toBe(WorkflowEventType.HANDOFF);
  });

  it("keeps an invalid handoff (missing from_agent_did) off the wire", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    const verdict = await emitter.emitHandoff(
      {
        fromAgentDid: "",
        multiAgentSessionId: "mas:run-1",
        runId: "run-1",
        workflowId: "thread-1"
      },
      controller.runtime.client
    );

    expect(verdict).toBeNull();
    expect(evaluateMock).not.toHaveBeenCalled();
  });
});
