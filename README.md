# @openbox-ai/openbox-copilotkit

Server-only governance and observability for [CopilotKit](https://www.copilotkit.ai/) `runtime/v2`. Closes the gaps a per-framework SDK can't see — frontend tools, AG-UI final messages, HITL approvals — by attaching at the CopilotKit boundary. Telemetry-default (records everything, blocks nothing); flip `enforceApprovals: true` to enforce.

> **Independence:** This SDK is standalone. If you also run `@openbox-ai/openbox-mastra-sdk` in the same process, both emit independently — see [`docs/troubleshooting.md`](./docs/troubleshooting.md#8-co-running-with-another-openbox-emitting-sdk-produces-duplicate-events) for the expected co-run behavior.

## The adopter diff

```diff
  // src/app/api/copilotkit/[[...slug]]/route.ts
  import { createCopilotEndpoint, CopilotRuntime } from "@copilotkit/runtime/v2";
+ import { withOpenBoxRuntime } from "@openbox-ai/openbox-copilotkit";

- const runtime = new CopilotRuntime({ agents });
+ const { runtime, shutdown } = await withOpenBoxRuntime(
+   { agents },
+   { middlewareOptions: { frontendToolNames: ["setThemeColor"] } }
+ );
+ process.on("SIGINT", async () => { await shutdown(); process.exit(0); });

  const app = createCopilotEndpoint({ runtime, basePath: "/api/copilotkit" });
```

```diff
  // next.config.ts
  const nextConfig = {
    serverExternalPackages: [
      "@copilotkit/runtime",
+     "@openbox-ai/openbox-copilotkit",
    ],
  };
```

```bash
# .env.local
OPENBOX_API_KEY=obx_live_...
OPENBOX_URL=https://api.openbox.ai
# Optional — enable DID-signed requests:
# OPENBOX_AGENT_DID=did:openbox:...
# OPENBOX_AGENT_PRIVATE_KEY=...
```

One import, one wrap, one `next.config.ts` entry, one optional SIGINT handler.

## Documentation

- [`docs/installation.md`](./docs/installation.md) — install, runtime requirements, env vars, the full adopter diff.
- [`docs/integration-patterns.md`](./docs/integration-patterns.md) — drop-in `withOpenBoxRuntime` and manual `createOpenBoxMiddleware` per-agent attach.
- [`docs/api-reference.md`](./docs/api-reference.md) — every public export with signature, parameters, and examples.
- [`docs/troubleshooting.md`](./docs/troubleshooting.md) — the eight scenarios adopters hit most often.

## What ships in 0.1.0-beta.0 (T0)

- **Public framework API:** `withOpenBoxRuntime`, `createOpenBoxMiddleware`.
- **Public shared API:** `OpenBoxClient`, `OpenBoxSpanProcessor`, `parseOpenBoxConfig`, `setupOpenBoxOpenTelemetry`.
- **AG-UI middleware** observing every `TOOL_CALL_*`, `TEXT_MESSAGE_*`, `RUN_*` event and emitting `workflow_type: "copilotkit"`.
- **Frontend-tool labelling** via explicit `frontendToolNames` allowlist or `isFrontendTool` callback (no heuristic).
- **DID-signed governance requests** when `OPENBOX_AGENT_DID` + `OPENBOX_AGENT_PRIVATE_KEY` are set.
- **Idempotent OTEL setup** with generic peer-tracer-provider detection.

Deferred to T1: React HITL companion (`@openbox-ai/openbox-copilotkit-react`), per-verdict enforcement matrices, CopilotKit v1 endpoint factories.

## Requirements

- Node `>=24.10.0` (uses ESM-only deps + AsyncLocalStorage `.enterWith`).
- `@copilotkit/runtime` `^1.61.0` (peer dependency; v2 paths only).
- `@ag-ui/client` `^0.0.57` (peer dependency).
- Edge runtimes (Vercel Edge, Cloudflare Workers) **unsupported** — AsyncLocalStorage is Node-only.

## License

MIT — see [`LICENSE`](./LICENSE).
