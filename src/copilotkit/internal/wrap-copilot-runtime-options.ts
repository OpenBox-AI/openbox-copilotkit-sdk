import type { AbstractAgent } from "@ag-ui/client";

import { OpenBoxClient } from "../../client/openbox-client.js";
import {
  parseOpenBoxConfig,
  type OpenBoxConfig,
  type OpenBoxConfigInput
} from "../../config/openbox-config.js";
import { setupOpenBoxOpenTelemetry } from "../../otel/setup-openbox-opentelemetry.js";
import { OpenBoxSpanProcessor } from "../../span/openbox-span-processor.js";
import type {
  OpenBoxLogger,
  OpenBoxMiddlewareOptions,
  OpenBoxRuntimeController,
  OpenBoxRuntimeDefaults
} from "../types.js";

import {
  openBoxAfterRequest,
  type AfterRequestMiddlewareParametersLike,
  type OpenBoxAfterRequestOptions
} from "./after-request.js";
import {
  openBoxBeforeRequest,
  type BeforeRequestMiddlewareParametersLike,
  type OpenBoxBeforeRequestOptions
} from "./before-request.js";
import { wrapAgentInProxy } from "./wrap-agent-in-proxy.js";

/**
 * Structural projection of a CopilotKit v2 `CopilotRuntimeOptions` agents
 * factory context. Mirrors `AgentFactoryContext` in
 * `@copilotkit/runtime/v2/runtime/core/runtime.ts` without importing the
 * package barrel (the SDK depends on the call-site shape, not the symbol).
 */
export interface AgentFactoryContextLike {
  request: Request;
}

export type AgentsRecord = Record<string, AbstractAgent>;

export type AgentsFactoryLike = (
  ctx: AgentFactoryContextLike
) => AgentsRecord | Promise<AgentsRecord>;

/**
 * The three `agents` shapes v2 accepts. `MaybePromise<Record>` is split into
 * `Record` and `Promise<Record>` to dispatch on at wrap time — the Promise
 * path is eagerly awaited so concurrent first-requests cannot race the
 * proxy-attachment.
 */
export type AgentsConfigLike =
  | AgentsRecord
  | Promise<AgentsRecord>
  | AgentsFactoryLike;

/**
 * Structural projection of a v2 `CopilotRuntimeOptions` — only the fields the
 * SDK reads or rewrites are typed. Other fields pass through as `unknown` via
 * the spread in the returned `options` object. The SDK does NOT import
 * `CopilotRuntimeOptions` directly to avoid coupling to a runtime peer
 * dependency at compile time.
 */
export interface CopilotRuntimeOptionsLike {
  agents: AgentsConfigLike;
  afterRequestMiddleware?: AfterRequestMiddlewareFnLike | undefined;
  beforeRequestMiddleware?: BeforeRequestMiddlewareFnLike | undefined;
}

export type BeforeRequestMiddlewareFnLike = (
  params: BeforeRequestMiddlewareParametersLike
) => Promise<Request | void> | Request | void;

export type AfterRequestMiddlewareFnLike = (
  params: AfterRequestMiddlewareParametersLike
) => Promise<void> | void;

/**
 * Caller-supplied overrides on top of `OpenBoxConfigInput`. These are the
 * knobs Phase 6's `withOpenBoxRuntime` re-exposes to adopters; everything
 * else lives in the OpenBox config / env vars.
 */
export interface WrapCopilotRuntimeOptionsExtras {
  /** Defaults consulted by AG-UI emissions when ALS context is absent. */
  defaults?: OpenBoxRuntimeDefaults | undefined;
  /** Logger forwarded to controller + emitter. Falls back to console. */
  logger?: OpenBoxLogger | undefined;
  /** Options passed through to `createOpenBoxMiddleware` per cloned agent. */
  middlewareOptions?: OpenBoxMiddlewareOptions | undefined;
  /** Options passed through to `openBoxAfterRequest` per request. */
  afterRequest?: OpenBoxAfterRequestOptions | undefined;
  /** Options passed through to `openBoxBeforeRequest` per request. */
  beforeRequest?: OpenBoxBeforeRequestOptions | undefined;
}

/**
 * Wrap output always has both middleware functions present — the user-shape
 * may omit them, but the wrap always inserts its composed versions.
 */
export type WrappedCopilotRuntimeOptions<
  TOptions extends CopilotRuntimeOptionsLike
> = Omit<
  TOptions,
  "agents" | "beforeRequestMiddleware" | "afterRequestMiddleware"
> & {
  agents: AgentsConfigLike;
  afterRequestMiddleware: AfterRequestMiddlewareFnLike;
  beforeRequestMiddleware: BeforeRequestMiddlewareFnLike;
};

export interface WrapCopilotRuntimeOptionsResult<
  TOptions extends CopilotRuntimeOptionsLike
> {
  controller: OpenBoxRuntimeController;
  options: WrappedCopilotRuntimeOptions<TOptions>;
  /** Tear down OTEL and any resources we own. Idempotent. */
  shutdown: () => Promise<void>;
}

const DEFAULT_LOGGER: OpenBoxLogger = {
  debug: (...args) => {
    console.debug("[openbox-copilotkit]", ...args);
  },
  error: (...args) => {
    console.error("[openbox-copilotkit]", ...args);
  },
  info: (...args) => {
    console.info("[openbox-copilotkit]", ...args);
  },
  warn: (...args) => {
    console.warn("[openbox-copilotkit]", ...args);
  }
};

/**
 * Build an OpenBox controller + a wrapped copy of the user's
 * `CopilotRuntimeOptions`. The wrapped options:
 *
 *   1. Compose user `before/afterRequestMiddleware` with OpenBox helpers via
 *      try/finally semantics — OpenBox observation runs regardless of user
 *      throws; user errors propagate after OpenBox records.
 *   2. Replace the `agents` config with a proxy-wrapped variant. The original
 *      record / Promise / factory is never mutated; per-request `clone()`
 *      calls produce fresh AG-UI agents with the OpenBox middleware attached
 *      as the INNERMOST observer (sees raw events before A2UI/MCP/OpenGenUI).
 *   3. Eagerly resolve Promise-shape agents at wrap time so the first
 *      concurrent requests cannot race the proxy attachment.
 *
 * Returns `{ options, controller, shutdown }`. The caller (Phase 6
 * `withOpenBoxRuntime`) is responsible for attaching the controller to the
 * constructed runtime via `attachOpenBoxRuntime` BEFORE serving any request;
 * the composed middleware looks the controller up at request time via the
 * private runtime symbol.
 *
 * INTERNAL — not exported from the public `index.ts`. The public surface is
 * `createOpenBoxMiddleware` + `withOpenBoxRuntime`.
 */
export async function wrapCopilotRuntimeOptions<
  TOptions extends CopilotRuntimeOptionsLike
>(
  options: TOptions,
  configInput: OpenBoxConfigInput = {},
  extras: WrapCopilotRuntimeOptionsExtras = {}
): Promise<WrapCopilotRuntimeOptionsResult<TOptions>> {
  const config: OpenBoxConfig = parseOpenBoxConfig(configInput);
  const logger = extras.logger ?? DEFAULT_LOGGER;
  const client = buildClient(config);
  const spanProcessor = new OpenBoxSpanProcessor();
  const otelController = setupOpenBoxOpenTelemetry({
    governanceClient: client,
    ignoredUrls: [client.apiUrl],
    onHookApiError: config.onApiError,
    spanProcessor
  });

  const controller: OpenBoxRuntimeController = {
    client,
    defaults: extras.defaults ?? {},
    logger,
    spanProcessor
  };

  const markerSymbol = Symbol("openbox.copilotkit.wrap");
  const middlewareOptions = extras.middlewareOptions;
  const wrappedAgents = await wrapAgents(options.agents, {
    controller,
    markerSymbol,
    middlewareOptions
  });

  const beforeOpts = extras.beforeRequest ?? {};
  const afterOpts = extras.afterRequest ?? {};

  const wrappedBefore = composeBeforeRequestMiddleware(
    options.beforeRequestMiddleware,
    beforeOpts,
    logger
  );
  const wrappedAfter = composeAfterRequestMiddleware(
    options.afterRequestMiddleware,
    afterOpts,
    logger
  );

  const nextOptions = {
    ...options,
    afterRequestMiddleware: wrappedAfter,
    agents: wrappedAgents,
    beforeRequestMiddleware: wrappedBefore
  } as unknown as WrappedCopilotRuntimeOptions<TOptions>;

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = async () => {
    if (!shutdownPromise) {
      shutdownPromise = otelController.shutdown();
    }
    await shutdownPromise;
  };

  return { controller, options: nextOptions, shutdown };
}

function buildClient(config: OpenBoxConfig): OpenBoxClient {
  return new OpenBoxClient({
    agentDid: config.agentDid,
    agentPrivateKey: config.agentPrivateKey,
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    evaluateMaxRetries: config.evaluateMaxRetries,
    evaluateRetryBaseDelayMs: config.evaluateRetryBaseDelayMs,
    onApiError: config.onApiError,
    timeoutSeconds: config.governanceTimeout
  });
}

interface WrapAgentsContext {
  controller: OpenBoxRuntimeController;
  markerSymbol: symbol;
  middlewareOptions?: OpenBoxMiddlewareOptions | undefined;
}

/**
 * Dispatch on the three `agents` shapes:
 *
 *   - Function (factory): return a new factory that wraps each call result.
 *     Per-call wrapping is correct — factories return NEW agent instances
 *     per request, so each instance needs its own proxy.
 *   - Promise: `await` at wrap time and treat as record. Eager resolution
 *     avoids the concurrent-first-request race (no factory case, no
 *     `runtime.agentsReady` API in v2).
 *   - Record: map each agent through `wrapAgentInProxy`.
 */
async function wrapAgents(
  agents: AgentsConfigLike,
  ctx: WrapAgentsContext
): Promise<AgentsConfigLike> {
  if (typeof agents === "function") {
    const factory = agents;
    return (factoryCtx: AgentFactoryContextLike) =>
      Promise.resolve(factory(factoryCtx)).then(result =>
        wrapRecord(result, ctx)
      );
  }

  if (isThenable(agents)) {
    const resolved = await agents;
    return wrapRecord(resolved, ctx);
  }

  return wrapRecord(agents, ctx);
}

function wrapRecord(
  record: AgentsRecord,
  ctx: WrapAgentsContext
): AgentsRecord {
  const entries = Object.entries(record).map(
    ([key, agent]) =>
      [
        key,
        wrapAgentInProxy(agent, {
          controller: ctx.controller,
          markerSymbol: ctx.markerSymbol,
          middlewareOptions: ctx.middlewareOptions
        })
      ] as const
  );
  return Object.fromEntries(entries);
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Try/finally composition: OpenBox observation runs regardless of whether
 * the user's `beforeRequestMiddleware` succeeded. If the user throws,
 * OpenBox still runs (so ALS context + DID signing still happen); the user's
 * error is re-thrown after OpenBox completes.
 *
 * If user middleware returns a modified `Request`, OpenBox sees the modified
 * request. If both user and OpenBox produce a request, OpenBox's takes
 * precedence (it owns the identity headers — must be the final word on the
 * outbound request).
 */
function composeBeforeRequestMiddleware(
  userBefore: BeforeRequestMiddlewareFnLike | undefined,
  beforeOpts: OpenBoxBeforeRequestOptions,
  logger: OpenBoxLogger
): BeforeRequestMiddlewareFnLike {
  return async params => {
    let userResult: Request | undefined;
    let userErr: unknown;

    if (userBefore) {
      try {
        const value = await userBefore(params);
        if (value) {
          userResult = value;
        }
      } catch (err) {
        userErr = err;
      }
    }

    const paramsForOpenBox: BeforeRequestMiddlewareParametersLike = userResult
      ? { ...params, request: userResult }
      : params;

    let openBoxResult: Request | undefined;
    try {
      const value = await openBoxBeforeRequest(
        params.runtime,
        beforeOpts
      )(paramsForOpenBox);
      if (value) {
        openBoxResult = value;
      }
    } catch (openBoxErr) {
      logger.warn?.({
        err: openBoxErr,
        note: "openbox wrap-copilot-runtime-options: before-request observation threw — swallowed"
      });
    }

    if (userErr) {
      throw toThrowable(userErr);
    }

    return openBoxResult ?? userResult;
  };
}

/**
 * After: same try/finally shape — observe regardless of user-middleware
 * outcome, then re-throw the user error if any. OpenBox errors are swallowed
 * (warn-logged) to preserve the `onApiError: "fail_open"` contract on the
 * response path.
 */
function composeAfterRequestMiddleware(
  userAfter: AfterRequestMiddlewareFnLike | undefined,
  afterOpts: OpenBoxAfterRequestOptions,
  logger: OpenBoxLogger
): AfterRequestMiddlewareFnLike {
  return async params => {
    let userErr: unknown;

    if (userAfter) {
      try {
        await userAfter(params);
      } catch (err) {
        userErr = err;
      }
    }

    try {
      await openBoxAfterRequest(params.runtime, afterOpts)(params);
    } catch (openBoxErr) {
      logger.warn?.({
        err: openBoxErr,
        note: "openbox wrap-copilot-runtime-options: after-request observation threw — swallowed"
      });
    }

    if (userErr) {
      throw toThrowable(userErr);
    }
  };
}

/**
 * Preserve user-thrown values across the OpenBox try/finally hop while
 * satisfying lint's `only-throw-error` rule. Real Error instances pass
 * through unchanged so callers' `instanceof` checks and stack traces are
 * intact; non-Error throws are wrapped in an Error that retains the
 * original value as `cause`.
 */
function toThrowable(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value), { cause: value });
}
