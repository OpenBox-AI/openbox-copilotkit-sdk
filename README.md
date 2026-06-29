# @openbox-ai/openbox-copilotkit

Server-only governance and observability for [CopilotKit](https://www.copilotkit.ai/) `runtime/v2`. Closes the gaps a per-framework SDK can't see — frontend tools, AG-UI final messages, HITL approvals — by attaching at the CopilotKit boundary. Telemetry-default (records everything, blocks nothing); flip `enforceApprovals: true` to enforce.

> **Independence:** This SDK is standalone. If you also run `@openbox-ai/openbox-mastra-sdk` in the same process, both emit independently — see [`docs/troubleshooting.md`](./docs/troubleshooting.md#co-running-with-another-openbox-emitting-sdk) for the expected co-run behavior.

## Why no OpenTelemetry?

The SDK observes governance-relevant events at the AG-UI middleware boundary (`TOOL_CALL_START`, `RUN_FINISHED`, etc.) and ships them to the OpenBox API via `client.evaluate(payload)`. OpenTelemetry was inherited from a sibling SDK during initial scaffolding but never load-bearing — the buffered spans were never flushed, and no UI consumer depended on them. Dropping OTel in 0.2.0-beta.0 removed ~700 LOC, 19 dependencies, and the entire process-coexistence problem with other OTel-installing SDKs. If your application needs OTel for unrelated reasons, install it yourself — this SDK no longer competes for the global TracerProvider.

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

## What this SDK observes

| Seam | Span type | Owner |
|---|---|---|
| AG-UI `TOOL_CALL_*` triple | `function_call` | ✅ **`@openbox-ai/openbox-copilotkit` (this SDK)** |
| Vercel AI SDK `LanguageModelV1` call | `llm_completion` | → [`@openbox-ai/openbox-mastra-sdk`](https://www.npmjs.com/package/@openbox-ai/openbox-mastra-sdk) |

The two SDKs are designed to co-run without duplicating spans — each observes a seam the other does not. If you use CopilotKit **without** Mastra and want LLM completion spans, that's a later ship gate (the Vercel-AI-SDK wrap helper can be promoted to a standalone helper at that time).

### Tool-span quickstart

```ts
// src/lib/openbox-span-buffer.ts
import { SpanBuffer } from "@openbox-ai/openbox-copilotkit";
const g = globalThis as unknown as { __openboxSpanBuffer?: SpanBuffer };
export const spanBuffer = g.__openboxSpanBuffer ?? new SpanBuffer();
if (process.env.NODE_ENV !== "production") g.__openboxSpanBuffer = spanBuffer;
```

```ts
// src/app/api/copilotkit/[[...slug]]/route.ts
import { spanBuffer } from "@/lib/openbox-span-buffer";
const { runtime } = await withOpenBoxRuntime(
  { agents },
  {
    middlewareOptions: {
      spanBuffer,
      // Recommended starter set — protects common credential keys at any depth.
      redactPaths: ["$..password", "$..secret", "$..token", "$..apiKey"],
    },
  },
);
```

```ts
// src/app/api/debug/openbox-spans/route.ts (dev only — gate behind env)
import { NextResponse } from "next/server";
import { spanBuffer } from "@/lib/openbox-span-buffer";

export async function GET() {
  if (process.env.NODE_ENV === "production" || process.env.OPENBOX_DEBUG_SPANS !== "1") {
    return new NextResponse("Not Found", { status: 404 });
  }
  return NextResponse.json(Object.fromEntries(spanBuffer.drain()));
}
```

Hit `GET /api/debug/openbox-spans` after a chat turn that fires a tool to see one `function_call` span per call with `openbox.idempotency_key`, `openbox.gateway`, `tool.args_hash`, `tool.duration_ms`, and the locked audit envelope. **⚠ Never deploy this route to production** — both `NODE_ENV` and `OPENBOX_DEBUG_SPANS=1` must be set.

### SpanBuffer env knobs

| Variable | Default | Effect |
|---|---|---|
| `OPENBOX_SPAN_BUFFER_MAX_PER_WORKFLOW` | `1000` | Per-workflow span cap; oldest evicted on overflow |
| `OPENBOX_SPAN_BUFFER_TTL_MS` | `300000` (5 min) | TTL after which a quiet workflow's spans are evicted |
| `OPENBOX_DISABLE_SPAN_BUFFER=1` | (off) | Emergency bypass — skip synthesis entirely |

## Documentation

- [`docs/installation.md`](./docs/installation.md) — install, runtime requirements, env vars, the full adopter diff.
- [`docs/integration-patterns.md`](./docs/integration-patterns.md) — drop-in `withOpenBoxRuntime` and manual `createOpenBoxMiddleware` per-agent attach.
- [`docs/api-reference.md`](./docs/api-reference.md) — every public export with signature, parameters, and examples.
- [`docs/troubleshooting.md`](./docs/troubleshooting.md) — the eight scenarios adopters hit most often.

## What ships in 0.2.0-beta.0

- **Public framework API:** `withOpenBoxRuntime`, `createOpenBoxMiddleware`.
- **Public shared API:** `OpenBoxClient`, `parseOpenBoxConfig`.
- **AG-UI middleware** observing every `TOOL_CALL_*`, `TEXT_MESSAGE_*`, `RUN_*` event and emitting `workflow_type: "copilotkit"`.
- **Frontend-tool labelling** via explicit `frontendToolNames` allowlist or `isFrontendTool` callback (no heuristic).
- **DID-signed governance requests** when `OPENBOX_AGENT_DID` + `OPENBOX_AGENT_PRIVATE_KEY` are set.

Deferred to T1: React HITL companion (`@openbox-ai/openbox-copilotkit-react`), per-verdict enforcement matrices, CopilotKit v1 endpoint factories.

## Requirements

- Node `>=24.10.0` (uses ESM-only deps + AsyncLocalStorage `.enterWith`).
- `@copilotkit/runtime` `^1.61.0` (peer dependency; v2 paths only).
- `@ag-ui/client` `^0.0.57` (peer dependency).
- Edge runtimes (Vercel Edge, Cloudflare Workers) **unsupported** — AsyncLocalStorage is Node-only.

## License

MIT — see [`LICENSE`](./LICENSE).
