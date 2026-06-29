# Troubleshooting

The scenarios that account for almost every adopter ticket. Each entry follows the same shape: **symptom → diagnosis → fix**.

If you hit something not on this list, please open an issue with a `console.warn` excerpt and an SDK version.

## Bundle errors on `next dev`

**Symptom**

`next dev` reports `Module parse failed: Unexpected token` referencing the SDK package or `@copilotkit/runtime` internals.

**Diagnosis**

Next's webpack bundler tries to inline ESM Node-only modules. The SDK is published as ESM-only.

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

## AsyncLocalStorage propagation in edge runtimes

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

The `next.config.ts` `serverExternalPackages` entry above also forces Node-runtime semantics for this package.

T0 does not target edge runtimes; T1 is unlikely to add edge support — `AsyncLocalStorage.enterWith()` is Node-specific.

---

## `useFrontendTool` calls show up as `frontend: false`

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

## Output guardrail block doesn't actually block

**Symptom**

You set `enforceApprovals: true`, but tool outputs that should be blocked still stream to the client.

**Diagnosis**

T0 enforces once a tool call's args are complete — inside `createOpenBoxMiddleware`, the verdict is awaited before the OpenBox `ActivityStarted` record is emitted. A block/halt verdict halts the stream and emits the redacted `governance_blocked` envelope.

T0 does **not** enforce in `afterRequest`. CopilotKit runtime v2's `fetch-handler.ts` runs `callAfterRequestMiddleware` fire-and-forget AFTER the SSE response has flushed. By the time `afterRequest` runs, the bytes are already on the wire — no amount of throwing from inside it produces a 5xx.

**Fix**

If you need output-side enforcement, the policy must look at the **tool input** once args are complete, not the tool output. The accepted T0 shape:

- `enforceApprovals: true` blocks after the full tool-call input is known.
- Tool output observability happens via `ActivityCompleted.activity_output` when the AG-UI stream exposes `TOOL_CALL_RESULT`. The final assistant message still emits separately as `SignalReceived(agent_output)`.

Output-side enforcement is a T1 design item; tracked in the project plan under the per-verdict matrix work.

---

## DID signing and custom `beforeRequestMiddleware` trust ordering

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

## Co-running with another OpenBox SDK

**Note (0.2.0-beta.0):** This SDK no longer installs OpenTelemetry. If another OpenBox SDK in your process (e.g. `@openbox-ai/openbox-mastra-sdk`) installs its own OTel, there is no contention — that SDK owns the global tracer alone. Both SDKs emit governance events to the OpenBox API independently via `client.evaluate()`. Below describes the duplicate-event behavior that follows.

**Symptom**

You wired both `@openbox-ai/openbox-copilotkit` (this SDK) and `@openbox-ai/openbox-mastra-sdk` in the same demo. OpenBox dashboard shows two `workflow_type` streams (`copilotkit` and `mastra`) for every chat turn. Tool calls under `enforceApprovals: true` evaluate twice — once from each SDK.

**Diagnosis**

**This is expected and intended.** The two SDKs are **fully independent** by design (project locked this in 2026-06-28). No runtime dependency, no peer-coordination, no shared singletons. Each observes its own boundary:

- `openbox-mastra-sdk` sees the Mastra agent run — backend tool calls, LLM completions, Mastra workflow steps.
- This SDK sees the CopilotKit boundary — frontend tools, AG-UI final messages, HITL surfaces.

When both run in the same process:

- **Duplicate `workflow_type` event streams** — accepted. Filter by `workflow_type` in the OpenBox UI to view either side independently.
- **Double governance** — both SDKs evaluate the same tool call against `enforceApprovals`. Design your governance policies aware of this if you wire two SDKs (e.g. configure idempotent policies that don't accumulate state per-evaluation).

If you want a single event stream, run only one SDK. There is no "co-run de-dupe" feature, and there will not be one in T0 / T1.

---

## Still stuck?

- Re-check [installation](./installation.md) for the required Node version and `next.config.ts` entry.
- Confirm your API key matches `obx_(live|test)_*`.
- Set the optional `logger` on `withOpenBoxRuntime` to a verbose `pino` or `console`-compatible sink — every internal warning routes through it.
- Open an issue with: SDK version (`npm ls @openbox-ai/openbox-copilotkit`), Node version, a minimal reproducible route handler, the relevant `console.warn` excerpts.
