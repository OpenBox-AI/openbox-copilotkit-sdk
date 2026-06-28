# Troubleshooting

The eight scenarios that account for almost every adopter ticket. Each entry follows the same shape: **symptom → diagnosis → fix**.

If you hit something not on this list, please open an issue with a `console.warn` excerpt and an SDK version.

## 1. Bundle errors or `fetch`-patch installed twice on hot reload

**Symptom**

- `next dev` reports `Module parse failed: Unexpected token` referencing `@opentelemetry/instrumentation-*` packages, or
- on every code change, you see two `[openbox-copilotkit] peer tracer provider detected, skipping OpenBox OTEL install` warnings, or
- `globalThis.fetch` is patched twice (visible if you `console.log(globalThis.fetch.toString())` — it's the wrapper twice over).

**Diagnosis**

Next's webpack bundler tries to inline the SDK's native OTEL instrumentations. They are CommonJS+native binding code that cannot be bundled. A side effect: when HMR loads a fresh module instance of the SDK per cycle, each instance maintains its own private `installedController` slot, so the `globalThis.fetch` patch reinstalls per cycle. (Idempotency is module-scoped, not process-scoped — see `setupOpenBoxOpenTelemetry` semantics in [api-reference.md](./api-reference.md#setupopenboxopentelemetryoptions).)

**Fix**

Add `@openbox-ai/openbox-copilotkit` to `next.config.ts` `serverExternalPackages`:

```ts
const nextConfig = {
  serverExternalPackages: [
    "@copilotkit/runtime",
    "@openbox-ai/openbox-copilotkit",
  ],
};
```

Restart `next dev` after editing `next.config.ts` (the config is read once at boot).

---

## 2. AsyncLocalStorage propagation in edge runtimes

**Symptom**

- Build error: `AsyncLocalStorage is not defined`, or
- Deploy succeeds but every emission records `agentId: undefined`, `tenantId: undefined`.

**Diagnosis**

This SDK uses Node `AsyncLocalStorage.enterWith()` to propagate per-request context through the AG-UI middleware chain. AsyncLocalStorage is **Node-only**; Vercel Edge, Cloudflare Workers, and Deno deploys do not implement `.enterWith` semantics.

**Fix**

Run the CopilotKit endpoint on the Node runtime. In Next:

```ts
// src/app/api/copilotkit/[[...slug]]/route.ts
export const runtime = "nodejs";   // NOT "edge"
```

The `next.config.ts` `serverExternalPackages` entry from scenario 1 also forces Node-runtime semantics for this package.

T0 does not target edge runtimes; T1 is unlikely to add edge support — the SDK depends on `@opentelemetry/sdk-node` which is Node-specific.

---

## 3. `useFrontendTool` calls show up as `frontend: false`

**Symptom**

OpenBox dashboard records every tool call as `frontend: false`, `tool_origin: "copilotkit-observed"`, even for tools you registered on the React side via `useCopilotAction` / `useFrontendTool`.

**Diagnosis**

The middleware **requires** an explicit allowlist. A non-Mastra runtime can route any `TOOL_CALL_*` event — including LangGraph / CrewAI / BuiltIn backend tools — so the SDK does not guess. Default is "all observed tools are backend tools."

**Fix**

Pass `frontendToolNames` (or `isFrontendTool` for dynamic detection) to `middlewareOptions`:

```ts
const { runtime, shutdown } = await withOpenBoxRuntime(
  { agents },
  {
    middlewareOptions: {
      // String-for-string match against the name registered with useFrontendTool.
      frontendToolNames: ["setThemeColor", "showSnackbar"],
      // Or, for a dynamic registry:
      // isFrontendTool: ({ name }) => myFrontendRegistry.has(name),
    },
  }
);
```

If both `isFrontendTool` and `frontendToolNames` are set, the callback wins.

---

## 4. Output guardrail block doesn't actually block

**Symptom**

You set `enforceApprovals: true`, but tool outputs that should be blocked still stream to the client.

**Diagnosis**

T0 enforces **before each `TOOL_CALL_START`** — inside `createOpenBoxMiddleware`, the verdict is awaited before the event reaches the AG-UI observable. A block/halt verdict halts the stream and emits the redacted `governance_blocked` envelope.

T0 does **not** enforce in `afterRequest`. CopilotKit runtime v2's `fetch-handler.ts` runs `callAfterRequestMiddleware` fire-and-forget AFTER the SSE response has flushed. By the time `afterRequest` runs, the bytes are already on the wire — no amount of throwing from inside it produces a 5xx.

**Fix**

If you need output-side enforcement, the policy must look at the **tool input** (before `TOOL_CALL_START`), not the tool output. The accepted T0 shape:

- `enforceApprovals: true` blocks the tool call's input.
- Tool output observability happens via `ActivityCompleted` emissions: subscribe via `middlewareOptions.onEvent` for adopter-side handling, or read the workflow buffer from the OpenBox dashboard. The `OpenBoxSpanProcessor` buffer itself is internal — it ships to OpenBox Core; T0 has no public adopter-side buffer-inspection hook.

Output-side enforcement is a T1 design item; tracked in the project plan under the per-verdict matrix work.

---

## 5. DID signing and custom `beforeRequestMiddleware` trust ordering

**Symptom**

You wired a custom `beforeRequestMiddleware` that injects `x-openbox-tenant-id: ${authedTenantId}` headers. With `OPENBOX_AGENT_DID` + `OPENBOX_AGENT_PRIVATE_KEY` set, those headers appear in the DID signature — but a request from an unauthed client also gets the headers because your middleware blindly trusts a query param.

**Diagnosis**

`withOpenBoxRuntime` composes user `beforeRequestMiddleware` **before** OpenBox signs the resulting request (Phase 5's `try/finally`). Anything user middleware writes lands inside the signature. A trust bug in user middleware becomes a trust bug in the DID signature.

**Fix — reserved-header rule**

When DID signing is on, **user middleware MUST NOT write `x-openbox-*` headers.** The DID signature signs over the request as it leaves Pattern 1's composition; anything user middleware writes lands inside it. T0 does not expose a tenant/user resolver through `WithOpenBoxRuntimeConfig` — your options are:

1. **Don't enable DID signing in deployments that also wire a custom `beforeRequestMiddleware`.** Leave `OPENBOX_AGENT_DID` / `OPENBOX_AGENT_PRIVATE_KEY` unset; the SDK falls back to API-key auth.
2. **Resolve tenant/user from a server-trusted source inside your `beforeRequestMiddleware` BEFORE you write any header.** Trusted sources include Next.js `cookies()` from `next/headers`, a JWT verified by your auth layer, or mTLS client-cert claims surfaced by your reverse proxy. Do NOT trust query params, request bodies, or unverified headers.
3. **Drop to Pattern 2** ([integration-patterns.md](./integration-patterns.md#pattern-2--manual-per-agent-middleware-attach)) and compose your own pre-OpenBox handler that runs the trusted resolver before `OpenBoxClient` constructs the DID envelope.

A public-surface tenant/user resolver hook is tracked for T1.

---

## 6. OTEL peer-detect skip log line

**Symptom**

```
[openbox-copilotkit] peer tracer provider detected, skipping OpenBox OTEL install
```

…and no OTEL spans show up in the OpenBox dashboard from this SDK.

**Diagnosis**

Another library — `openbox-mastra-sdk`, Datadog, Honeycomb, a custom OTEL setup — registered a global `TracerProvider` before this SDK initialised. The SDK does not clobber peer state it did not create; it returns a no-op controller and continues without OTEL.

**Important:** `client.evaluate(...)` emissions **still flow**. Governance, approvals, and the `workflow_type: "copilotkit"` event stream are unaffected. Only the OTEL-side of telemetry (HTTP/DB/file instrumentation spans) is skipped.

**Fix — option A: initialise this SDK first**

Make `withOpenBoxRuntime` run before any other OTEL-installing library in the same process. In Next, that usually means importing the route handler module before any third-party telemetry boot.

**Fix — option B: isolate processes**

Run the conflicting SDK in a separate Node process or worker. See scenario 8 below for the in-process reality of the Mastra demo.

---

## 7. `setupOpenBoxOpenTelemetry called twice with different configs`

**Symptom**

At app startup, the SDK throws:

```
setupOpenBoxOpenTelemetry called twice with different configs in the same process
— reconfigure flow not supported in T0. Call controller.shutdown() first.
```

**Diagnosis**

You called `withOpenBoxRuntime(..., cfgA)` and then `withOpenBoxRuntime(..., cfgB)` (different `apiUrl` or `apiKey`) in the same process without tearing down the first wrap. T0 explicitly does not support silent reconfigure — the original mastra-sdk teardown-on-second-call semantics are deliberately not preserved (silent global mutation is the failure mode that motivated the SDK redesign).

**Fix**

Tear down before re-wrapping:

```ts
const first = await withOpenBoxRuntime(opts, cfgA);
// ... time passes, you need a different config
await first.shutdown();
const second = await withOpenBoxRuntime(opts, cfgB);
```

For dev-time hot reload, prefer the SIGINT shutdown hook + a fresh process restart. The idempotent path (two calls with the same config) does **not** throw.

---

## 8. Co-running with another OpenBox-emitting SDK produces duplicate events

**Symptom**

You wired both `@openbox-ai/openbox-copilotkit` (this SDK) and `@openbox-ai/openbox-mastra-sdk` in the same demo. OpenBox dashboard shows two `workflow_type` streams (`copilotkit` and `mastra`) for every chat turn. Tool calls under `enforceApprovals: true` evaluate twice — once from each SDK.

**Diagnosis**

**This is expected and intended.** The two SDKs are **fully independent** by design (project locked this in 2026-06-28). No runtime dependency, no peer-coordination, no shared singletons. Each observes its own boundary:

- `openbox-mastra-sdk` sees the Mastra agent run — backend tool calls, LLM completions, Mastra workflow steps.
- This SDK sees the CopilotKit boundary — frontend tools, AG-UI final messages, HITL surfaces.

When both run in the same process:

- **Duplicate spans** — accepted.
- **Duplicate `workflow_type` event streams** — accepted. Filter by `workflow_type` in the OpenBox UI to view either side independently.
- **Double governance** — both SDKs evaluate the same tool call against `enforceApprovals`. Design your governance policies aware of this if you wire two SDKs (e.g. configure idempotent policies that don't accumulate state per-evaluation).

If you want a single event stream, run only one SDK. There is no "co-run de-dupe" feature, and there will not be one in T0 / T1.

---

## 9. "I run `mastra dev` and `next dev` as separate processes — why do I still see the peer-detect log?"

(Bonus scenario for the Mastra demo specifically.)

**Symptom**

You started Mastra and the Next.js app as two separate OS processes:

```bash
mastra dev          # port 4111
next dev            # port 3000
```

…and you still see `[openbox-copilotkit] peer tracer provider detected, skipping OpenBox OTEL install` from the Next process.

**Diagnosis**

**Two OS processes does not always mean two SDK runtimes.** In the `examples/integrations/mastra` demo, the Next.js route handler imports the Mastra instance **directly**:

```ts
// src/app/api/copilotkit/[[...slug]]/route.ts
import { mastra } from "@/mastra";
import { MastraAgent } from "@copilotkit/runtime/v2";

const agents = await MastraAgent.getLocalAgents({ mastra });
```

That import transitively loads `src/mastra/index.ts` **inside the Next.js process**. `src/mastra/index.ts` calls `withOpenBox(...)` from `openbox-mastra-sdk` and installs that SDK's OTEL in the Next process. When you then add `withOpenBoxRuntime(...)` from this SDK to the same route handler, **both SDKs live in the same Node process** and compete for the same `globalThis.fetch` patch and `trace.setGlobalTracerProvider()` slot.

The peer-detect skip from scenario 6 resolves the race safely — whichever SDK initialises first owns OTEL; the loser logs the skip line and still emits via `client.evaluate(...)` (governance + events flow; OTEL spans for the losing SDK do not).

The `mastra dev` process (the Mastra Playground on port 4111) is **unrelated** to this race — it's a separate development tool, not a peer of the Next.js process.

**Fix**

If you need truly independent OTEL exporters per SDK, run the CopilotKit runtime in a different Node process from the local Mastra import:

```ts
// route.ts — use remote agents instead of local
const agents = await MastraAgent.getRemoteAgents("http://localhost:4111");
```

This removes the transitive `withOpenBox(...)` install from the Next process. **Not required and not shipped in T0** — the demo accepts the in-process peer-detect skip as the expected behavior.

---

## Still stuck?

- Re-check [installation](./installation.md) for the required Node version and `next.config.ts` entry.
- Confirm your API key matches `obx_(live|test)_*`.
- Set the optional `logger` on `withOpenBoxRuntime` to a verbose `pino` or `console`-compatible sink — every internal warning routes through it.
- Open an issue with: SDK version (`npm ls @openbox-ai/openbox-copilotkit`), Node version, a minimal reproducible route handler, the relevant `console.warn` excerpts.
