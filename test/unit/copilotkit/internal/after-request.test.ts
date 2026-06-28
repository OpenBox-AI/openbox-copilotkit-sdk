import { describe, expect, it, vi } from "vitest";

import {
  openBoxAfterRequest,
  type MessageLike
} from "../../../../src/copilotkit/internal/after-request.js";
import { attachOpenBoxRuntime } from "../../../../src/copilotkit/runtime-symbol.js";
import { WorkflowEventType } from "../../../../src/types/workflow-event-type.js";
import { buildController } from "../test-utils.js";

function buildRuntime() {
  const built = buildController();
  const runtime: Record<string, unknown> = {};
  attachOpenBoxRuntime(runtime, built.controller);
  return { ...built, runtime };
}

function buildParams(override: {
  messages?: MessageLike[];
  runId?: string;
  threadId?: string;
}) {
  const response = new Response("", {
    headers: { "content-type": "text/event-stream" }
  });
  return {
    messages: override.messages,
    path: "/api/copilotkit/runtime",
    response,
    runId: override.runId,
    runtime: {},
    threadId: override.threadId
  };
}

const ASSISTANT_MESSAGE: MessageLike = {
  content: "Hello from the assistant",
  id: "msg-final",
  role: "assistant"
};

describe("openBoxAfterRequest", () => {
  it("emits a SIGNAL_RECEIVED event for the final assistant message", async () => {
    const { evaluateMock, runtime } = buildRuntime();
    const fn = openBoxAfterRequest(runtime);

    await fn({
      ...buildParams({
        messages: [
          { content: "Hi", id: "msg-user", role: "user" },
          ASSISTANT_MESSAGE
        ],
        runId: "run-A",
        threadId: "thread-A"
      }),
      runtime
    });

    expect(evaluateMock).toHaveBeenCalledTimes(1);
    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.event_type).toBe(WorkflowEventType.SIGNAL_RECEIVED);
    expect(payload.workflow_id).toBe("thread-A");
    expect(payload.run_id).toBe("run-A");
    expect(payload.signal_name).toBe("assistant_message");
    const signalArgs = payload.signal_args as { value: { content: string; id: string } };
    expect(signalArgs.value.content).toBe("Hello from the assistant");
    expect(signalArgs.value.id).toBe("msg-final");
  });

  it("uses params.threadId as the workflow id (no body peek)", async () => {
    const { evaluateMock, runtime } = buildRuntime();
    const fn = openBoxAfterRequest(runtime);

    await fn({
      ...buildParams({
        messages: [ASSISTANT_MESSAGE],
        runId: "run-B",
        threadId: "thread-explicit"
      }),
      runtime
    });

    expect(evaluateMock.mock.calls[0]?.[0]).toMatchObject({
      workflow_id: "thread-explicit"
    });
  });

  it("walks the messages list in reverse to find the final assistant message", async () => {
    const { evaluateMock, runtime } = buildRuntime();
    const fn = openBoxAfterRequest(runtime);

    await fn({
      ...buildParams({
        messages: [
          { content: "Earlier assistant", id: "msg-a", role: "assistant" },
          { content: "User reply", id: "msg-u", role: "user" },
          { content: "Final assistant", id: "msg-f", role: "assistant" }
        ],
        runId: "run-C",
        threadId: "thread-C"
      }),
      runtime
    });

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const signalArgs = payload.signal_args as { value: { id: string } };
    expect(signalArgs.value.id).toBe("msg-f");
  });

  it("is a no-op when there is no assistant message in the messages list", async () => {
    const { evaluateMock, runtime } = buildRuntime();
    const fn = openBoxAfterRequest(runtime);

    await fn({
      ...buildParams({
        messages: [{ content: "user only", id: "msg-u", role: "user" }],
        runId: "run-D",
        threadId: "thread-D"
      }),
      runtime
    });

    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it("is a no-op when messages is missing or empty", async () => {
    const { evaluateMock, runtime } = buildRuntime();
    const fn = openBoxAfterRequest(runtime);

    await fn({ ...buildParams({ runId: "r", threadId: "t" }), runtime });
    await fn({
      ...buildParams({ messages: [], runId: "r", threadId: "t" }),
      runtime
    });

    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it("skips emission when threadId or runId is missing (AG-UI middleware path owns this signal)", async () => {
    const { evaluateMock, runtime } = buildRuntime();
    const fn = openBoxAfterRequest(runtime);

    await fn({
      ...buildParams({ messages: [ASSISTANT_MESSAGE], threadId: "t" }),
      runtime
    });
    await fn({
      ...buildParams({ messages: [ASSISTANT_MESSAGE], runId: "r" }),
      runtime
    });

    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it("invokes outputGuardrail and records the verdict (does NOT throw into the response path)", async () => {
    const { runtime } = buildRuntime();
    const guardrail = vi.fn().mockResolvedValue({
      classification: "block",
      reason: "policy violation"
    });
    const fn = openBoxAfterRequest(runtime, { outputGuardrail: guardrail });

    await expect(
      fn({
        ...buildParams({
          messages: [ASSISTANT_MESSAGE],
          runId: "run-G",
          threadId: "thread-G"
        }),
        runtime
      })
    ).resolves.toBeUndefined();

    expect(guardrail).toHaveBeenCalledWith(ASSISTANT_MESSAGE);
  });

  it("does not call outputGuardrail when none is configured", async () => {
    const { runtime } = buildRuntime();
    const fn = openBoxAfterRequest(runtime);

    await fn({
      ...buildParams({
        messages: [ASSISTANT_MESSAGE],
        runId: "run-H",
        threadId: "thread-H"
      }),
      runtime
    });
    // No throw, no extra side effects to assert beyond the resolved promise.
  });

  it("swallows an outputGuardrail throw without propagating into v2", async () => {
    const { logger, runtime } = buildRuntime();
    const fn = openBoxAfterRequest(runtime, {
      outputGuardrail: () => {
        throw new Error("guardrail boom");
      }
    });

    await expect(
      fn({
        ...buildParams({
          messages: [ASSISTANT_MESSAGE],
          runId: "run-I",
          threadId: "thread-I"
        }),
        runtime
      })
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalled();
  });

  it("swallows an evaluate failure (fail-open) without breaking the response path", async () => {
    const evaluateMock = vi
      .fn()
      .mockRejectedValue(new Error("upstream openbox api down"));
    const built = buildController({ evaluateMock });
    const runtime: Record<string, unknown> = {};
    attachOpenBoxRuntime(runtime, built.controller);
    const fn = openBoxAfterRequest(runtime);

    await expect(
      fn({
        ...buildParams({
          messages: [ASSISTANT_MESSAGE],
          runId: "run-J",
          threadId: "thread-J"
        }),
        runtime
      })
    ).resolves.toBeUndefined();
  });

  it("returns a no-op fn when the runtime has no OpenBox controller attached", async () => {
    const runtime = {};
    const fn = openBoxAfterRequest(runtime);

    await expect(
      fn({
        ...buildParams({
          messages: [ASSISTANT_MESSAGE],
          runId: "run-K",
          threadId: "thread-K"
        }),
        runtime
      })
    ).resolves.toBeUndefined();
  });
});
