import type { AbstractAgent } from "@ag-ui/client";

import { createOpenBoxMiddleware } from "../openbox-middleware.js";
import type {
  OpenBoxMiddlewareOptions,
  OpenBoxRuntimeController
} from "../types.js";

type AgentWithUse = AbstractAgent & {
  use?: (...mw: unknown[]) => unknown;
};

type AgentWithClone = AbstractAgent & {
  clone?: () => AbstractAgent;
};

export interface WrapAgentInProxyOptions {
  controller: OpenBoxRuntimeController;
  /**
   * Per-wrap-instance idempotency marker. Created in
   * `wrapCopilotRuntimeOptions` so two wraps over the SAME underlying agent
   * record produce DIFFERENT proxies (one per controller); within a single
   * wrap the marker prevents accidental double-wrapping.
   */
  markerSymbol: symbol;
  middlewareOptions?: OpenBoxMiddlewareOptions | undefined;
}

/**
 * Wrap an `AbstractAgent` in a `Proxy` that:
 *
 *   1. Leaves the original agent fully untouched: no `.use()`, no `.clone`
 *      replacement, and no other in-place mutation.
 *   2. Intercepts `.clone()` so that each per-request clone:
 *        a. Comes from the original `clone()` (real per-request copy).
 *        b. Has `createOpenBoxMiddleware(controller)` attached via `.use()`
 *           SYNCHRONOUSLY — making OpenBox the first/innermost middleware on
 *           the clone.
 *        c. Is itself wrapped in a fresh proxy so that clone-of-clone keeps
 *           the same observation contract.
 *
 * Attaching at clone-time makes OpenBox observation deterministic for every
 * per-request clone.
 *
 * Edge cases:
 *   - Agents without `.use()` (custom AG-UI implementations): we log a warn
 *     and continue. Per-request observation is degraded for that agent only.
 *   - Agents without `.clone()`: we log a warn and return the proxy itself.
 *     OpenBox middleware is NOT attached for this case — observation is
 *     lost until the agent gains a real `.clone()` method.
 *   - Re-wrap protection: the proxy reports `true` for its own marker symbol
 *     so calling `wrapAgentInProxy` twice with the same marker is a no-op.
 *   - Self-cloning agents (an agent method that internally calls
 *     `this.clone()` or `this.use()` rather than going through an external
 *     caller): the proxy's `get` trap binds non-intercepted methods to
 *     `target`, so any `this.clone()` inside an agent method bypasses the
 *     interceptor. Custom adopters with self-cloning agents should externalize
 *     the call to keep observation intact.
 */
export function wrapAgentInProxy<T extends AbstractAgent>(
  agent: T,
  options: WrapAgentInProxyOptions
): T {
  const { markerSymbol } = options;

  if ((agent as unknown as Record<symbol, unknown>)[markerSymbol]) {
    return agent;
  }

  const proxy = new Proxy(agent, {
    get(target, prop, receiver) {
      if (prop === markerSymbol) {
        return true;
      }

      if (prop === "clone") {
        return () => cloneAndWrap(target, options, proxy);
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return value;
    }
  });

  return proxy;
}

function cloneAndWrap(
  target: AgentWithClone,
  options: WrapAgentInProxyOptions,
  selfProxy: AbstractAgent
): AbstractAgent {
  const realClone = target.clone;
  if (typeof realClone !== "function") {
    options.controller.logger.warn?.({
      agent: target.constructor?.name ?? "unknown",
      note: "openbox wrap-agent-in-proxy: target has no .clone() — returning the original proxy. OpenBox middleware is NOT attached for this agent (per-request observation lost). Add a .clone() implementation that returns a fresh instance to enable observation."
    });
    return selfProxy;
  }

  const cloned = realClone.call(target);
  attachOpenBoxToClone(cloned, options);
  return wrapAgentInProxy(cloned, options);
}

function attachOpenBoxToClone(
  cloned: AbstractAgent,
  options: WrapAgentInProxyOptions
): void {
  const target = cloned as AgentWithUse;
  if (typeof target.use !== "function") {
    options.controller.logger.warn?.({
      agent: cloned.constructor?.name ?? "unknown",
      note: "openbox wrap-agent-in-proxy: cloned agent has no .use() — middleware NOT attached, per-request observation degraded"
    });
    return;
  }

  try {
    target.use(
      createOpenBoxMiddleware(
        options.controller,
        options.middlewareOptions ?? {}
      )
    );
  } catch (err) {
    options.controller.logger.warn?.({
      err,
      note: "openbox wrap-agent-in-proxy: cloned agent .use() threw — middleware NOT attached, per-request observation degraded"
    });
  }
}
