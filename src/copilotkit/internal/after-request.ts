import { OpenBoxCopilotKitEmitter } from "../openbox-emitter.js";
import { getOpenBoxRuntime } from "../runtime-symbol.js";
import type { OpenBoxRuntimeController } from "../types.js";

/** Minimal structural shape of the reconstructed CopilotKit message. */
export interface MessageLike {
  content?: string | undefined;
  id: string;
  role: string;
  toolCalls?: unknown;
  toolCallId?: string | undefined;
}

/** Structural projection of CopilotKit's after-request middleware parameters. */
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
 * Verdict returned by a user-supplied `outputGuardrail`. The verdict is
 * recorded as metadata, but cannot rewrite a response that has already
 * streamed to the client.
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
   * activity metadata; a block/halt classification logs a warning but cannot
   * rewrite the already-streamed response.
   *
   * For pre-stream enforcement, use `createOpenBoxMiddleware`.
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
 *      logged but do not propagate because this hook runs after streaming.
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
    // Runtime is not OpenBox-wrapped, so no-op rather than throw.
    return async () => {};
  }

  const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

  return async (params) => {
    try {
      const runId = params.runId;

      // RT-F14 dedup guard: this hook is a FALLBACK for when the AG-UI
      // stream itself produced no terminal output signal. Read + release
      // this run's dedup entry UNCONDITIONALLY (before any early return
      // below) — this registry's last consumer is always `after-request` in
      // a request's lifecycle, so it must release the entry regardless of
      // whether there is a final message to report, or memory would leak
      // for every run that hits an early return.
      const terminalState = runId ? controller.runTerminalState.get(runId) : undefined;
      if (runId) {
        controller.runTerminalState.clearRun(runId);
      }

      const message = findFinalAssistantMessage(params.messages);
      if (!message) {
        return;
      }

      const workflowId = params.threadId;
      if (!workflowId || !runId) {
        // Without both ids this hook cannot attach the signal to a workflow.
        return;
      }

      // Skip emission when the middleware already emitted `agent_output`
      // (normal successful run — never double-emit `assistant_message`) OR
      // when the run ended suspended (an interrupt outcome — the run is not
      // done, so there is no "final" assistant message to report yet).
      if (terminalState?.outputEmitted || terminalState?.interrupted) {
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
            note: "openbox after-request guardrail returned a block/halt verdict after the response streamed",
            reason: verdict.reason,
            workflow_id: workflowId
          });
        }
      } catch (err) {
        controller.logger.warn?.({
          err,
          event: "OpenBoxOutputGuardrailThrew",
          note: "openbox after-request guardrail threw after the response streamed",
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
