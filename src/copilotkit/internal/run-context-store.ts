import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Minimal per-run correlation the server-tool wrapper needs to recover ids
 * the AI SDK's `execute(args, executionOptions)` does not supply (Decision
 * D7): `executionOptions` carries only `toolCallId`, never `workflowId`/
 * `runId`.
 */
export interface RunContext {
  readonly runId: string;
  readonly workflowId: string;
}

/**
 * Controller-owned, per-run `AsyncLocalStorage` store carrying only
 * `workflowId`/`runId` for the lifetime of one AG-UI run.
 *
 * Distinct from the base SDK's `ContextStore` (`@openbox-ai/openbox-sdk-ts/context`):
 * that store binds per-ACTIVITY scope for the whole runtime (and owns
 * abort/halt flags). This store is a small, separate seam — one instance per
 * controller (never a process-global) — that the AG-UI middleware seeds once
 * per run by wrapping `source.subscribe(...)` inside `#processStream` (Phase
 * 3), and that the `serverTool()` wrapper (Phase 5) reads to obtain
 * `workflowId`/`runId`, combining them with `executionOptions.toolCallId` to
 * build the activity id it evaluates against.
 */
export class RunContextStore {
  readonly #als = new AsyncLocalStorage<RunContext>();

  /**
   * Run `cb` with `ctx` bound for its entire async lifetime — `als.run`
   * propagates the bound context across every `await` inside `cb`, and two
   * overlapping `enterRunContext` calls never cross-observe each other's
   * context (standard `AsyncLocalStorage` isolation).
   */
  enterRunContext<T>(ctx: RunContext, cb: () => T): T {
    return this.#als.run(ctx, cb);
  }

  /** The run context bound to the current async flow, or `undefined` outside any scope. */
  currentRunContext(): RunContext | undefined {
    return this.#als.getStore();
  }
}
