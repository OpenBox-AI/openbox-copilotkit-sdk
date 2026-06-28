import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import { WorkflowEventType } from "../../../src/types/workflow-event-type.js";
import { createOpenBoxMiddleware } from "../../../src/copilotkit/openbox-middleware.js";

import {
  ScriptedAgent,
  buildController,
  buildRunAgentInput,
  collectEvents
} from "./test-utils.js";

function scriptedToolCallEvents(toolName: string): BaseEvent[] {
  return [
    {
      toolCallId: `${toolName}-call`,
      toolCallName: toolName,
      type: EventType.TOOL_CALL_START
    } as BaseEvent,
    {
      delta: "{}",
      toolCallId: `${toolName}-call`,
      type: EventType.TOOL_CALL_ARGS
    } as BaseEvent,
    {
      toolCallId: `${toolName}-call`,
      type: EventType.TOOL_CALL_END
    } as BaseEvent,
    { type: EventType.RUN_FINISHED } as BaseEvent
  ];
}

function findActivityStarted(
  evaluateCalls: unknown[][],
  toolName: string
): Record<string, unknown> | undefined {
  return evaluateCalls
    .map(args => args[0] as Record<string, unknown>)
    .find(
      payload =>
        payload.event_type === WorkflowEventType.ACTIVITY_STARTED &&
        payload.activity_type === toolName
    );
}

describe("frontend-tool allowlist", () => {
  it("default config labels every observed tool frontend: false", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller);
    const agent = new ScriptedAgent({
      events: scriptedToolCallEvents("setThemeColor")
    });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const activityStarted = findActivityStarted(
      evaluateMock.mock.calls,
      "setThemeColor"
    );
    expect(activityStarted?.frontend).toBe(false);
    expect(activityStarted?.tool_origin).toBe("copilotkit-observed");
  });

  it("allowlist via frontendToolNames marks matching tool frontend: true", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller, {
      frontendToolNames: ["setThemeColor"]
    });
    const agent = new ScriptedAgent({
      events: scriptedToolCallEvents("setThemeColor")
    });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const activityStarted = findActivityStarted(
      evaluateMock.mock.calls,
      "setThemeColor"
    );
    expect(activityStarted?.frontend).toBe(true);
  });

  it("allowlist via frontendToolNames does NOT mark non-matching tool frontend: true", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller, {
      frontendToolNames: ["setThemeColor"]
    });
    const agent = new ScriptedAgent({
      events: scriptedToolCallEvents("backend_query")
    });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const activityStarted = findActivityStarted(
      evaluateMock.mock.calls,
      "backend_query"
    );
    expect(activityStarted?.frontend).toBe(false);
  });

  it("isFrontendTool callback overrides the allowlist", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller, {
      frontendToolNames: ["setThemeColor"],
      isFrontendTool: call => call.name === "backend_query"
    });
    const backendAgent = new ScriptedAgent({
      events: scriptedToolCallEvents("backend_query")
    });
    const themeAgent = new ScriptedAgent({
      events: scriptedToolCallEvents("setThemeColor")
    });

    await collectEvents(middleware.run(buildRunAgentInput(), backendAgent));
    await collectEvents(
      middleware.run(
        buildRunAgentInput({ runId: "run-2", threadId: "thread-2" }),
        themeAgent
      )
    );

    expect(
      findActivityStarted(evaluateMock.mock.calls, "backend_query")?.frontend
    ).toBe(true);
    expect(
      findActivityStarted(evaluateMock.mock.calls, "setThemeColor")?.frontend
    ).toBe(false);
  });
});
