import { OpenBoxCopilotKitEmitter } from "../openbox-emitter.js";
import { getOpenBoxRuntime } from "../runtime-symbol.js";
import type { OpenBoxRuntimeController } from "../types.js";

/**
 * Minimal structural shape of v2's reconstructed `Message`. The full type
 * lives in `@copilotkit/runtime/v2/runtime/core/middleware-sse-parser` which
 * is not exported from the package barrel.
 */
export interface MessageLike {
  content?: string | undefined;
  id: string;
  role: string;
  toolCalls?: unknown;
  toolCallId?: string | undefined;
}

/**
 * Structural projection of v2's `AfterRequestMiddlewareParameters`. `messages`
 * / `threadId` / `runId` are top-level on the params object — NOT nested
 * under `params.params` (the original Phase 4 draft had this wrong).
 */
export interface AfterRequestMiddlewareParametersLike {
  messages?: MessageLike[] | undefined;
  path: string;
  response: Response;
  runId?: string | undefined;
  runtime: object;
  threadId?: string | undefined;
}

export type OpenBoxAfterRequestFn = (
  params: AfterRequestMiddlewareParametersLike
) => Promise<void>;

/**
 * Verdict returned by a user-supplied `outputGuardrail`. T0 records the
 * verdict as activity metadata via the emitter but DOES NOT rewrite or
 * cancel the response — v2's `callAfterRequestMiddleware` is fire-and-forget
 * post-response (see `fetch-handler.ts:237-246`), so blocking is structurally
 * impossible at this point.
 */
export interface OutputGuardrailVerdict {
  /** Free-form classification (e.g. "allow", "redact", "block"). */
  classification?: string | undefined;
  /** Human-readable reason; recorded as activity metadata. */
  reason?: string | undefined;
}

export interface OpenBoxAfterRequestOptions {
  /**
   * Observation-only output guardrail. Called with the final assistant
   * message after the response has streamed. The verdict is recorded as
   * activity metadata; a block/halt classification logs a warning but
   * cannot rewrite the response in T0.
   *
   * For pre-stream enforcement, use `createOpenBoxMiddleware` (Phase 3)
   * which runs BEFORE events leave the agent observable.
   */
  outputGuardrail?:
    | ((
        message: MessageLike
      ) => OutputGuardrailVerdict | Promise<OutputGuardrailVerdict>)
    | undefined;
}

const SIGNAL_NAME = "assistant_message";

/**
 * Build a v2-compatible `AfterRequestMiddlewareFn` that:
 *
 *   1. Finds the final assistant message in `params.messages`.
 *   2. Emits a `SIGNAL_RECEIVED` event (signal_name = "assistant_message")
 *      via the OpenBox emitter so the assistant output is recorded in the
 *      governance event stream.
 *   3. Optionally calls `opts.outputGuardrail(message)` and records the
 *      verdict as metadata. Throwing or block/halt classifications are
 *      logged but do not propagate — v2 runs this middleware fire-and-forget
 *      post-response; there is no way to convert a verdict into a 5xx here.
 *
 * Always returns `void` (matches v2's `AfterRequestMiddlewareFn`). Never
 * throws into the v2 logger path — failures are swallowed after a warn log
 * to preserve the `onApiError: "fail_open"` contract.
 */
export function openBoxAfterRequest(
  runtime: object,
  opts: OpenBoxAfterRequestOptions = {}
): OpenBoxAfterRequestFn {
  const controller = getOpenBoxRuntime<OpenBoxRuntimeController>(runtime);

  if (!controller) {
    // Runtime is not OpenBox-wrapped — no-op rather than throw. Phase 5
    // guarantees the controller is attached before composing this fn into
    // the runtime, but the safety belt protects an out-of-order adopter
    // wiring without leaking errors into the response path.
    return async () => {};
  }

  const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

  return async (params) => {
    try {
      const message = findFinalAssistantMessage(params.messages);
      if (!message) {
        return;
      }

      const workflowId = params.threadId;
      const runId = params.runId;
      if (!workflowId || !runId) {
        // Without both ids we cannot register the workflow with the span
        // processor. Skip silently — the AG-UI middleware path (Phase 3)
        // owns the in-stream signal; this after-middleware is a redundant
        // observation surface for non-streaming/non-AG-UI flows.
        return;
      }

      await emitter.emitSignalReceived({
        payload: serializeMessage(message),
        runId,
        signalName: SIGNAL_NAME,
        workflowId
      });

      if (!opts.outputGuardrail) {
        return;
      }

      try {
        const verdict = await opts.outputGuardrail(message);
        const classification = verdict.classification?.toLowerCase() ?? "";

        if (classification === "block" || classification === "halt") {
          controller.logger.warn?.({
            classification: verdict.classification,
            event: "OpenBoxOutputGuardrailBlocked",
            note: "openbox after-request guardrail returned a block/halt verdict — T0 observation-only, response already streamed",
            reason: verdict.reason,
            workflow_id: workflowId
          });
        }
      } catch (err) {
        controller.logger.warn?.({
          err,
          event: "OpenBoxOutputGuardrailThrew",
          note: "openbox after-request guardrail threw — swallowed (T0 observation-only)",
          workflow_id: workflowId
        });
      }
    } catch (err) {
      controller.logger.warn?.({
        err,
        note: "openbox after-request: unexpected error — swallowed to preserve fail-open semantics"
      });
    }
  };
}

function findFinalAssistantMessage(
  messages: MessageLike[] | undefined
): MessageLike | undefined {
  if (!messages || messages.length === 0) {
    return undefined;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i];
    if (candidate?.role === "assistant") {
      return candidate;
    }
  }
  return undefined;
}

function serializeMessage(message: MessageLike): Record<string, unknown> {
  return {
    ...(message.content !== undefined ? { content: message.content } : {}),
    id: message.id,
    role: message.role,
    ...(message.toolCallId !== undefined
      ? { tool_call_id: message.toolCallId }
      : {}),
    ...(message.toolCalls !== undefined
      ? { tool_calls: message.toolCalls }
      : {})
  };
}
