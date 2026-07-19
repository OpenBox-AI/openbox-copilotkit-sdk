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
      // Deprecated boolean (use `enforcement` instead — see below). `true`
      // enforces ONLY the frontend AG-UI delivery gate: block/halt verdicts
      // emit the redacted governance_blocked envelope into SSE before the
      // TOOL_CALL_* reaches the frontend. It never gates server-side tool
      // execution — for that, wrap the tool with
      // createOpenBoxCopilotKit(...).serverTool() instead.
      enforceApprovals: false,
      // Equivalent, non-deprecated form:
      // enforcement: { frontendTools: "observe" }, // "enforce" to gate delivery
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
2. Constructs an `OpenBoxRuntimeController` and attaches it to the `CopilotRuntime` instance via a private symbol.
3. Wraps every agent in `runtime.agents` (record / Promise / `(ctx) => agents` factory shapes all handled) with a `Proxy<AbstractAgent>` so:
   - `.clone()` returns a cloned-and-re-wrapped agent (no in-place mutation; two `withOpenBoxRuntime` calls over the same agent record cannot cross-talk).
   - `.use(...)` defers OpenBox middleware install via `queueMicrotask` so it runs INNERMOST relative to A2UI / MCP / OpenGenUI middlewares (observes raw events; correct ordering for governance).
4. Composes any user-supplied `beforeRequestMiddleware` / `afterRequestMiddleware` in `try/finally` so OpenBox emissions run even when user middleware throws (observability never blind on the error path; user errors propagate AFTER OpenBox records `WorkflowFailed`).

### Dev vs. prod

- **`next dev`:** the SIGINT handler is cosmetic — `shutdown()` is an idempotent no-op resolved promise. Repeat `withOpenBoxRuntime` calls under HMR produce independent controllers; no global state to coordinate as of 0.2.0-beta.0.
- **`next start` / standalone:** wire SIGINT + SIGTERM if you intend to add client-side cleanup later. Today `shutdown()` resolves immediately; the SDK has no buffered state to flush.

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

> **Out of date since `0.4.0`.** `OpenBoxRuntimeController` (the first argument to `createOpenBoxMiddleware`) grew several required fields in `0.4.0` (`runtime`, `runContext`, `telemetryQueue`, `serverToolOwnership`, `interruptStore`, `runTerminalState`, `childAgentClients` — see [api-reference.md](./api-reference.md#openboxruntimecontroller)). The `{ client, defaults, logger }` object built below no longer satisfies that type. There is currently no documented supported recipe for hand-building a full controller outside `withOpenBoxRuntime`/`createOpenBoxCopilotKit`; if you need Pattern 2's manual-attach shape, treat the snippet below as illustrative of the *intent* only, and track [openbox-copilotkit-sdk#issues](https://github.com/OpenBox-AI/openbox-copilotkit-sdk/issues) for a corrected example.

```ts
import {
  CopilotRuntime,
  createCopilotEndpoint,
  MastraAgent,
} from "@copilotkit/runtime/v2";
import {
  createOpenBoxMiddleware,
  OpenBoxClient,
  parseOpenBoxConfig,
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

// 2. Build the OpenBoxRuntimeController.
// NOTE: this object shape predates 0.4.0's richer OpenBoxRuntimeController —
// see the callout above. `parseOpenBoxConfig`/`OpenBoxClient` above are
// themselves deprecated facades (MIGRATION.md).
const runtime = {
  client,
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
| A server-side tool call must be **prevented from executing** on a BLOCK/HALT/rejected-approval verdict | `createOpenBoxCopilotKit(...).serverTool()` — see [api-reference.md](./api-reference.md#createopenboxcopilotkitoptions) |

## Server-tool governance (`createOpenBoxCopilotKit`)

Pattern 1 and Pattern 2 both observe the AG-UI stream — including `enforcement.frontendTools: "enforce"` (or the deprecated `enforceApprovals: true`), which only gates *delivery to the frontend*. Neither prevents a server-side tool's `execute` from running: the middleware never stands between a server-side call and its side effect. If you need that guarantee, wrap the specific tool:

```ts
import { createOpenBoxCopilotKit } from "@openbox-ai/openbox-copilotkit";

const bundle = await createOpenBoxCopilotKit({
  enforcement: { mode: "enforce" }, // gates bundle.serverTool()-wrapped tools only
});

const governedWeatherTool = bundle.serverTool(weatherTool);
// governedWeatherTool.execute now evaluates (and, on REQUIRE_APPROVAL, awaits
// approval for) the call BEFORE weatherTool's real execute runs. A non-allow
// verdict (including CONSTRAIN) throws instead of running execute.
```

`enforcement.mode: "telemetry"` (the default) never gates — `execute` always runs, and the wrapper only adds best-effort ActivityStarted/Completed telemetry. See [`MIGRATION.md`](../MIGRATION.md#boundary-truthfulness--read-this-if-you-rely-on-this-sdk-for-governance) for the full three-boundary breakdown (wrapped server tool / frontend delivery gate / observation-only).

## Multi-agent delegation (Handoff)

By default a CopilotKit run is one OpenBox session. When CopilotKit delegates to a
subagent (e.g. a Mastra weather agent), opt into **multi-agent mode** to group the
parent run and the child run under one `multi_agent_session_id` and record a
parent → child `Handoff` edge. Disabled by default — single-agent governance is
unchanged unless you set `multiAgent.enabled`.

### Identity model (read this first)

The orchestrator and each subagent must be **distinct OpenBox agents**, each with
its own API key + DID:

| Role | OpenBox agent | Auth for normal events | Role in Handoff |
|---|---|---|---|
| Parent / orchestrator | e.g. `copilotkit-gateway` | CopilotKit API key + DID | `from_agent_did` |
| Child / subagent | e.g. `mastra-weather-agent` | Mastra API key + DID | authenticated emitter → `to_agent` |

OpenBox Core derives the handoff's `to_agent` from the **authenticated emitter** of
the Handoff request — the wire never carries `to_agent_did`. So the Handoff must be
sent as the child. If both runtimes share one identity, the handoff becomes
self-to-self.

### Configure (Pattern 1)

```ts
const { runtime, shutdown } = await withOpenBoxRuntime(
  { agents },
  {
    // Parent CopilotKit identity (becomes from_agent_did).
    agentDid: process.env.OPENBOX_COPILOTKIT_AGENT_DID,
    agentPrivateKey: process.env.OPENBOX_COPILOTKIT_AGENT_PRIVATE_KEY,
    middlewareOptions: {
      multiAgent: {
        enabled: true,
        // Optional — defaults to the runtime agentDid above.
        // parentAgentDid: process.env.OPENBOX_COPILOTKIT_AGENT_DID,
        // Optional — defaults to `mas:${runId}`.
        // multiAgentSessionId: (ctx) => `mas:${ctx.runId}`,
        handoffTools: {
          // Map a delegate tool name to the subagent it invokes.
          weatherTool: {
            childAgentName: "mastra-weather-agent",
            childWorkflowType: "weather-agent",
            childTaskQueue: "mastra",
            // Child credentials enable PARENT-SIDE Handoff emission (below).
            childApiKey: process.env.OPENBOX_MASTRA_API_KEY,
            childAgentDid: process.env.OPENBOX_MASTRA_AGENT_DID,
            childAgentPrivateKey: process.env.OPENBOX_MASTRA_AGENT_PRIVATE_KEY,
          },
        },
        // Or resolve dynamically instead of a static map:
        // resolveHandoff: (call, ctx) => call.name === "weatherTool" ? {...} : null,

        // Forward the grouping context to the child runtime. The SDK only
        // OBSERVES tool calls — it cannot inject into the child invocation — so
        // use this hook to bridge the gap (e.g. stash ctx keyed by
        // parentActivityId for the delegate tool to set on the child's
        // RuntimeContext). Anything you return is merged into the Handoff
        // metadata under `forwarded_context`.
        forwardContext: (ctx) => {
          pendingChildContext.set(ctx.parentActivityId, ctx);
          return { correlation_id: ctx.parentActivityId };
        },
      },
    },
  }
);
```

### Two emission modes

- **Parent-side (child credentials configured):** the SDK signs the `Handoff`
  request with the child's identity (via a child-scoped client) so OpenBox resolves
  `to_agent` correctly. Self-contained — the demo works from CopilotKit alone.
- **Context-export (no child credentials):** the SDK does **not** send the Handoff
  (it would mis-resolve under the parent identity). Instead it surfaces an
  `OpenBoxMultiAgentContext` on the `onEvent` hook (embedded in the Handoff
  payload's `metadata.openbox_multi_agent_context`). A remote child runtime reads
  that context and emits the `Handoff` itself.

### Completing the group on the child side

`multi_agent_session_id` grouping requires **both** sessions to carry the same id.
CopilotKit (parent) stamps it on its stream and **owns the `Handoff`** (emitted
parent-side via the child-scoped client above — the child does not emit one, so
there is no double handoff). The child runtime only needs the grouping context,
which `forwardContext` propagates. The child then:

1. stamps the same `multi_agent_session_id` on its `WorkflowStarted` + lifecycle events,
2. stamps `parent_workflow_id` (from the forwarded context) on its workflow events.

The one piece of glue you wire in your app: read what `forwardContext` stashed and
set it on the child invocation (e.g. Mastra `RuntimeContext`). No child-SDK code
change is required.

### Backend-compatible timeline signals

In multi-agent mode the parent emits **array-shaped** `signal_args`
(`["<text>"]`) for the timeline-visible `user_input` / `agent_output` signals —
the shape the OpenBox timeline reads — so CopilotKit messages
render in the run detail. With multi-agent disabled the
legacy `{ value }` shape is preserved unchanged.

### Expected event order (prompt: "what is the weather in tokyo?")

```text
parent  WorkflowStarted          multi_agent_session_id
parent  SignalReceived:user_input
parent  ActivityStarted:weatherTool
child   Handoff                  multi_agent_session_id, from_agent_did = parent
child   WorkflowStarted          multi_agent_session_id, parent_workflow_id
child   ActivityStarted/Completed:getWeather
child   WorkflowCompleted        multi_agent_session_id, parent_workflow_id
parent  ActivityCompleted:weatherTool
parent  WorkflowCompleted        multi_agent_session_id
```

## See also

- [API reference](./api-reference.md) — full signatures.
- [Installation](./installation.md) — `next.config.ts` and `.env`.
- [Troubleshooting](./troubleshooting.md) — the common adopter scenarios.
- [`MIGRATION.md`](../MIGRATION.md) — the `0.4.0` boundary-truthfulness writeup and the deprecated-field alias table.
