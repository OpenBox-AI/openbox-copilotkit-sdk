# Integration Patterns

This SDK ships two attachment patterns. Pick **Pattern 1** unless you have a specific reason not to — it owns runtime construction and gives you the full `try/finally` composition for `before/afterRequestMiddleware`.

## Pattern 1 — Drop-in `withOpenBoxRuntime` (recommended)

`withOpenBoxRuntime(options, config)` takes the same `CopilotRuntimeOptions` you would have handed to `new CopilotRuntime(...)`, applies OpenBox governance + telemetry, and returns `{ runtime, shutdown }`.

**Best for:** the 95% case. One import, one wrap, one optional shutdown handler.

```ts
// src/app/api/copilotkit/[[...slug]]/route.ts
import { createCopilotEndpoint, MastraAgent } from "@copilotkit/runtime/v2";
import { withOpenBoxRuntime } from "@openbox-ai/openbox-copilotkit";
import { mastra } from "@/mastra";

const agents = await MastraAgent.getLocalAgents({ mastra });

const { runtime, shutdown } = await withOpenBoxRuntime(
  { agents },
  {
    middlewareOptions: {
      // Every useFrontendTool name from the React side — labels them
      // frontend: true and tool_origin: "copilotkit-observed" in OpenBox.
      frontendToolNames: ["setThemeColor"],
      // Telemetry-default is false. Flip to true to await client.evaluate +
      // client.pollApproval once tool-call args are complete — block/halt
      // verdicts emit the redacted governance_blocked envelope into SSE.
      enforceApprovals: false,
    },
    // Optional shared-export config — env-var fallbacks cover the common case.
    // apiKey: process.env.OPENBOX_API_KEY,
    // apiUrl: process.env.OPENBOX_URL,
    // onApiError: "fail_open",
  }
);

// Optional but recommended in long-lived processes.
process.on("SIGINT", async () => { await shutdown(); process.exit(0); });
process.on("SIGTERM", async () => { await shutdown(); process.exit(0); });

const app = createCopilotEndpoint({ runtime, basePath: "/api/copilotkit" });
export const { GET, POST } = app;
```

### What `withOpenBoxRuntime` does for you

1. Parses `OpenBoxConfig` (env-var fallbacks honored).
2. Sets up the OTEL controller (`setupOpenBoxOpenTelemetry`) — idempotent within the process; defers to a peer-registered tracer provider if one already exists.
3. Constructs an `OpenBoxRuntimeController` and attaches it to the `CopilotRuntime` instance via a private symbol.
4. Wraps every agent in `runtime.agents` (record / Promise / `(ctx) => agents` factory shapes all handled) with a `Proxy<AbstractAgent>` so:
   - `.clone()` returns a cloned-and-re-wrapped agent (no in-place mutation; two `withOpenBoxRuntime` calls over the same agent record cannot cross-talk).
   - `.use(...)` defers OpenBox middleware install via `queueMicrotask` so it runs INNERMOST relative to A2UI / MCP / OpenGenUI middlewares (observes raw events; correct ordering for governance).
5. Composes any user-supplied `beforeRequestMiddleware` / `afterRequestMiddleware` in `try/finally` so OpenBox emissions run even when user middleware throws (observability never blind on the error path; user errors propagate AFTER OpenBox records `WorkflowFailed`).

### Dev vs. prod

- **`next dev`:** the SIGINT handler tends to be cosmetic — Next reloads the module on file change, but the OTEL slot is idempotent within the SDK; a second `withOpenBoxRuntime` call with the same `apiUrl + apiKey` returns the existing controller. A second call with a **different** config throws (see [troubleshooting → setupOpenBoxOpenTelemetry called twice](./troubleshooting.md#7-setupopenboxopentelemetry-called-twice-with-different-configs)).
- **`next start` / standalone:** wire SIGINT + SIGTERM. `shutdown()` flushes the OTEL span processor and clears the runtime-attached controller; without it you can lose the last batch of telemetry on container stop.

### Constraint: options-only

`withOpenBoxRuntime` takes `CopilotRuntimeOptions`, not a constructed `CopilotRuntime`. Passing a `CopilotRuntime` instance throws `TypeError`:

```text
withOpenBoxRuntime: pass CopilotRuntimeOptions (not a constructed CopilotRuntime).
Example: const { runtime, shutdown } = await withOpenBoxRuntime({ agents }, openboxConfig).
```

The instance form would lose the AG-UI middleware attachment + the `before/afterRequestMiddleware` composition.

## Pattern 2 — Manual per-agent middleware attach

`createOpenBoxMiddleware(runtime, opts?)` returns an AG-UI `Middleware` you can attach via `agent.use(middleware)` yourself. Use this when you own runtime construction (e.g. you wire `before/afterRequestMiddleware` by hand outside this SDK) and only need the per-agent stream observer.

**Best for:** advanced operators who manage `CopilotRuntimeOptions` composition manually.

```ts
import {
  CopilotRuntime,
  createCopilotEndpoint,
  MastraAgent,
} from "@copilotkit/runtime/v2";
import {
  createOpenBoxMiddleware,
  OpenBoxClient,
  OpenBoxSpanProcessor,
  parseOpenBoxConfig,
  setupOpenBoxOpenTelemetry,
} from "@openbox-ai/openbox-copilotkit";
import { mastra } from "@/mastra";  // or any AbstractAgent registry

// 1. Build the wire-level dependencies yourself.
const cfg = parseOpenBoxConfig();
const client = new OpenBoxClient({
  apiKey: cfg.apiKey,
  apiUrl: cfg.apiUrl,
  onApiError: cfg.onApiError,
  agentDid: cfg.agentDid,
  agentPrivateKey: cfg.agentPrivateKey,
});
const spanProcessor = new OpenBoxSpanProcessor({});
const otelController = setupOpenBoxOpenTelemetry({
  governanceClient: client,
  spanProcessor,
});

// 2. Build the OpenBoxRuntimeController.
const runtime = {
  client,
  spanProcessor,
  defaults: {},
  logger: console,
};

// 3. Attach the AG-UI middleware to each agent yourself.
const middleware = createOpenBoxMiddleware(runtime, {
  frontendToolNames: ["setThemeColor"],
  enforceApprovals: false,
});

const agents = await MastraAgent.getLocalAgents({ mastra });
for (const agent of Object.values(agents)) {
  agent.use(middleware);
}

// 4. Wire the runtime + endpoint normally.
const copilotRuntime = new CopilotRuntime({ agents });
const app = createCopilotEndpoint({
  runtime: copilotRuntime,
  basePath: "/api/copilotkit",
});

// 5. Wire your own shutdown.
process.on("SIGINT", async () => {
  await otelController.shutdown();
  process.exit(0);
});
```

### What you give up with Pattern 2

- **No `try/finally` composition of `before/afterRequestMiddleware`.** Pattern 1 composes user middleware around OpenBox emissions so observability is never blind on the error path. Pattern 2 hands you the AG-UI middleware only — request-level middleware composition is yours to manage.
- **No automatic `.clone()` proxy.** If a CopilotKit request handler clones an agent per-request, your manually-attached middleware sticks (AG-UI agents preserve `_middleware` across `.clone()`); but two distinct controllers over the same agent record can cross-talk — Pattern 1's Proxy is what prevents that.
- **No automatic ordering relative to A2UI / MCP / OpenGenUI.** Pattern 1 schedules `.use(...)` via `queueMicrotask` so OpenBox lands INNERMOST after `configureAgentForRequest` runs. Manual attach lands wherever you call `.use(...)`; call it AFTER `configureAgentForRequest` if you want the same ordering.

If any of those guarantees matter to you, use Pattern 1.

## Picking between them

| Need | Use |
|---|---|
| Telemetry + governance with minimum footprint | **Pattern 1** |
| Composed `before/afterRequestMiddleware` (try/finally) | **Pattern 1** |
| Clone-safe per-request agent isolation | **Pattern 1** |
| Custom `CopilotRuntimeOptions` builder you don't want OpenBox to wrap | **Pattern 2** |
| Embedded in another framework that already constructs `CopilotRuntime` | **Pattern 2** |

## See also

- [API reference](./api-reference.md) — full signatures.
- [Installation](./installation.md) — `next.config.ts` and `.env`.
- [Troubleshooting](./troubleshooting.md) — the eight scenarios.
