# Installation

## Install

```bash
npm install @openbox-ai/openbox-copilotkit
```

`@copilotkit/runtime` and `@ag-ui/client` are peer dependencies — install them in the host app if you haven't already:

```bash
npm install @copilotkit/runtime @ag-ui/client
```

## Runtime requirements

- **Node.js `>=24.10.0`.** The SDK uses `AsyncLocalStorage.enterWith()` and ESM-only OTEL packages.
- **Server-only.** Edge runtimes (Vercel Edge, Cloudflare Workers) are unsupported — AsyncLocalStorage is Node-only.
- **CopilotKit `runtime/v2`.** The v1 endpoint factories are not supported in T0.

## `next.config.ts` — `serverExternalPackages`

The SDK ships native OTEL instrumentations (`@opentelemetry/instrumentation-http`, `-fs`, etc.) that Next's bundler cannot inline. Add it to `serverExternalPackages` to keep it on the Node runtime:

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@copilotkit/runtime",
    "@openbox-ai/openbox-copilotkit",
  ],
};

export default nextConfig;
```

Skipping this entry typically surfaces as bundle errors, or — under HMR that loads a fresh module instance per cycle — a re-patched `globalThis.fetch` (idempotency is module-scoped, not process-scoped). See [troubleshooting](./troubleshooting.md#1-bundle-errors-or-fetch-patch-installed-twice-on-hot-reload).

## Environment variables

```bash
# .env.local

# Required — fetched at runtime by parseOpenBoxConfig.
OPENBOX_API_KEY=obx_live_...          # or obx_test_*
OPENBOX_URL=https://api.openbox.ai

# Optional — opt-in DID-signed governance requests. Both required together.
OPENBOX_AGENT_DID=did:openbox:...
OPENBOX_AGENT_PRIVATE_KEY=...
```

When `OPENBOX_AGENT_DID` and `OPENBOX_AGENT_PRIVATE_KEY` are set, the SDK signs every governance request with five identity headers (`X-OpenBox-Agent-DID`, `X-OpenBox-Agent-Timestamp`, `X-OpenBox-Agent-Nonce`, `X-OpenBox-Body-SHA256`, `X-OpenBox-Agent-Signature`). Read [troubleshooting → "DID signing + custom beforeRequestMiddleware trust ordering"](./troubleshooting.md#5-did-signing-and-custom-beforerequestmiddleware-trust-ordering) before you ship DID signing with custom middleware.

## The canonical adopter diff

This is the complete change set for a CopilotKit app that already has a `runtime/v2` route handler:

```diff
  // src/app/api/copilotkit/[[...slug]]/route.ts
  import { createCopilotEndpoint, CopilotRuntime } from "@copilotkit/runtime/v2";
+ import { withOpenBoxRuntime } from "@openbox-ai/openbox-copilotkit";

  const agents = { /* ... your MastraAgent / LangGraphAgent / BuiltInAgent record */ };

- const runtime = new CopilotRuntime({ agents });
+ const { runtime, shutdown } = await withOpenBoxRuntime(
+   { agents },
+   {
+     middlewareOptions: {
+       // List every useFrontendTool name from the React side here.
+       frontendToolNames: ["setThemeColor"],
+       // Set true to block on Verdict.BLOCK / Verdict.HALT verdicts.
+       enforceApprovals: false,
+     },
+   }
+ );

+ // Optional — guarantees the OTEL span processor flushes on shutdown.
+ process.on("SIGINT", async () => { await shutdown(); process.exit(0); });
+ process.on("SIGTERM", async () => { await shutdown(); process.exit(0); });

  const app = createCopilotEndpoint({ runtime, basePath: "/api/copilotkit" });
  export const { GET, POST } = app;
```

```diff
  // next.config.ts
  serverExternalPackages: [
    "@copilotkit/runtime",
+   "@openbox-ai/openbox-copilotkit",
  ],
```

## Verifying the install

After running the demo, you should see in the OpenBox dashboard:

1. A `workflow_type: "copilotkit"` event stream.
2. One `WorkflowStarted` + `SignalReceived(user_input)` + `SignalReceived(agent_output)` + `WorkflowCompleted` per CopilotKit request.
3. One `ActivityStarted` + `ActivityCompleted` per tool call, with `frontend: true` on every name in your `frontendToolNames` list and `frontend: false` on everything else.

If the dashboard is empty, jump to [troubleshooting → "useFrontendTool calls show up as `frontend: false`"](./troubleshooting.md#3-usefrontendtool-calls-show-up-as-frontend-false) and [troubleshooting → "peer tracer provider detected"](./troubleshooting.md#6-otel-peer-detect-skip-log-line).

## Security and privacy (T0)

- **API keys** are sent in `Authorization: Bearer …`; the SDK refuses non-HTTPS `apiUrl` values for non-localhost hosts (`parseOpenBoxConfig` throws `OpenBoxInsecureURLError`).
- **DID signatures** bind every request to method + path + timestamp + nonce + body SHA-256, replay-protected; bodies are size-capped (default 10 MiB).
- **Governance block** verdicts emit a fixed-shape redacted envelope `{ type: 'error', code: 'governance_blocked', correlationId }` — tool name, tenant id, and verdict reason never reach the client (see [api-reference → governance-blocked envelope](./api-reference.md#enforceapprovals-and-the-governance_blocked-envelope)).
- **AsyncLocalStorage** scopes per-request tenant/agent context — Node-only.

A standalone `security-and-privacy.md` page is deferred to T1. T0-relevant points are summarized here and in [api-reference.md](./api-reference.md).

## Next

- [Integration patterns](./integration-patterns.md) — when to use `withOpenBoxRuntime` vs. `createOpenBoxMiddleware`.
- [API reference](./api-reference.md) — every public export, every type.
- [Troubleshooting](./troubleshooting.md) — the eight scenarios adopters hit most often.
