# @openbox-ai/openbox-copilotkit

[![npm version](https://img.shields.io/npm/v/@openbox-ai/openbox-copilotkit.svg?label=npm)](https://www.npmjs.com/package/@openbox-ai/openbox-copilotkit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24.10.0-brightgreen.svg)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/status-beta-orange.svg)](#release-status)

Server-only governance and observability SDK for [CopilotKit](https://www.copilotkit.ai/) `runtime/v2`. Attaches at the CopilotKit boundary to observe frontend tools, AG-UI final messages, and HITL approvals — the seams a per-framework SDK can't see.

> **Beta.** Public APIs may change before `1.0.0`. Pin a tilde range (`~0.3.0`) until then.

## Features

- **One-line adopter integration** — wrap `CopilotRuntimeOptions` with `withOpenBoxRuntime()`; no other code changes required.
- **AG-UI middleware** — observes every `TOOL_CALL_*`, `TEXT_MESSAGE_*`, `RUN_*` event and ships them to the OpenBox API as `workflow_type: "copilotkit"`.
- **Telemetry-default, enforcement opt-in** — records everything, blocks nothing until you set `enforceApprovals: true`.
- **Verdict surface** — 5-case discriminated union (`allow` / `block` / `constrain` / `require_approval` / `halt`). `allow` and `block` are wired today; the rest throw `VerdictNotImplementedError` (see [Release Status](#release-status)).
- **Tool-span synthesis** — synthesize `function_call` spans from AG-UI tool-call triples with hashed args/results, idempotency key, audit envelope, and JSONPath-based redaction.
- **DID-signed governance requests** — Ed25519 5-header envelope when `OPENBOX_AGENT_DID` + `OPENBOX_AGENT_PRIVATE_KEY` are set.
- **Co-runs with `@openbox-ai/openbox-mastra-sdk`** — each SDK observes a boundary the other doesn't; no duplicate spans.
- **No OpenTelemetry dependency** — events flow exclusively via `client.evaluate(payload)`; your app keeps full control of its own `TracerProvider`.

## Requirements

| | |
|---|---|
| **Node.js** | `>=24.10.0` (ESM-only deps + `AsyncLocalStorage.enterWith`) |
| **CopilotKit** | `@copilotkit/runtime ^1.61.0` (peer; `runtime/v2` paths only) |
| **AG-UI** | `@ag-ui/client ^0.0.57` (peer) |
| **Runtime** | Node only — Edge runtimes (Vercel Edge, Cloudflare Workers) are not supported |

## Install

```bash
npm install @openbox-ai/openbox-copilotkit
# or
pnpm add @openbox-ai/openbox-copilotkit
# or
yarn add @openbox-ai/openbox-copilotkit
```

## Quick start

### 1. Wrap your CopilotKit route

```ts
// src/app/api/copilotkit/[[...slug]]/route.ts
import { createCopilotEndpoint, CopilotRuntime } from "@copilotkit/runtime/v2";
import { withOpenBoxRuntime } from "@openbox-ai/openbox-copilotkit";

const { runtime, shutdown } = await withOpenBoxRuntime(
  { agents },
  { middlewareOptions: { frontendToolNames: ["setThemeColor"] } },
);

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

export const { GET, POST } = createCopilotEndpoint({
  runtime,
  basePath: "/api/copilotkit",
});
```

### 2. Mark the SDK as a server-external package

```ts
// next.config.ts
const nextConfig = {
  serverExternalPackages: [
    "@copilotkit/runtime",
    "@openbox-ai/openbox-copilotkit",
  ],
};
```

### 3. Set your environment

```bash
# .env.local
OPENBOX_API_KEY=obx_live_...
OPENBOX_URL=https://api.openbox.ai

# Optional — enable DID-signed governance requests:
# OPENBOX_AGENT_DID=did:openbox:...
# OPENBOX_AGENT_PRIVATE_KEY=...
```

That's it. The full env reference lives in [`docs/installation.md`](./docs/installation.md).

## What this SDK observes

| Seam | Span type | Owner |
|---|---|---|
| AG-UI `TOOL_CALL_*` triple | `function_call` | **this SDK** |
| Vercel AI SDK `LanguageModelV1` call | `llm_completion` | [`@openbox-ai/openbox-mastra-sdk`](https://www.npmjs.com/package/@openbox-ai/openbox-mastra-sdk) |

If you run both SDKs in the same process, they emit independently — no duplicate spans. See [`docs/troubleshooting.md`](./docs/troubleshooting.md#co-running-with-another-openbox-emitting-sdk).

## Tool-span buffer (optional)

Synthesize and inspect `function_call` spans locally before they ship to OpenBox.

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

A dev-only debug route can drain the buffer for inspection — see [`docs/integration-patterns.md`](./docs/integration-patterns.md). Never deploy that route to production.

### SpanBuffer environment variables

| Variable | Default | Effect |
|---|---|---|
| `OPENBOX_SPAN_BUFFER_MAX_PER_WORKFLOW` | `1000` | Per-workflow span cap; oldest evicted on overflow |
| `OPENBOX_SPAN_BUFFER_TTL_MS` | `300000` (5 min) | TTL after which a quiet workflow's spans are evicted |
| `OPENBOX_DISABLE_SPAN_BUFFER` | unset | Set to `1` to skip synthesis entirely (emergency bypass) |

## Documentation

| Page | What it covers |
|---|---|
| [Project overview](./docs/project-overview-pdr.md) | Problem, scope, requirements, success criteria — start here. |
| [Installation](./docs/installation.md) | Install steps, runtime requirements, full env-var reference, adopter diff. |
| [Integration patterns](./docs/integration-patterns.md) | Drop-in `withOpenBoxRuntime` vs manual `createOpenBoxMiddleware` per-agent attach. |
| [API reference](./docs/api-reference.md) | Every public export with signature, parameters, and examples. |
| [Troubleshooting](./docs/troubleshooting.md) | The eight scenarios adopters hit most often. |
| [System architecture](./docs/system-architecture.md) | 13-component breakdown, request flow, data shapes, env vars. |
| [Codebase summary](./docs/codebase-summary.md) | Source tree, public surface, LOC by module, dependency graph. |
| [Code standards](./docs/code-standards.md) | Language, naming, import, testing conventions. |
| [Project roadmap](./docs/project-roadmap.md) | Version history, phase definitions, known limitations. |

## Release status

| Version | Status | Highlights |
|---|---|---|
| **`0.2.0-beta.0`** | Published (2026-06-29) | Public framework + shared APIs, AG-UI middleware, frontend-tool labelling, DID-signed requests, OTel install removed. |
| **`0.3.0`** | Current (2026-06-30) | Verdict discriminated union, `SpanBuffer`, tool-span synthesis, sibling-event hook transport. |
| **`0.4.0`** (planned) | — | `constrain` and `halt` enforcement wired. |
| **`0.5.0`** (planned) | — | `require_approval` polling wired; targeting `1.0.0` stability. |

See [`docs/project-roadmap.md`](./docs/project-roadmap.md) and [`CHANGELOG.md`](./CHANGELOG.md) for full history. Migration notes live in [`MIGRATION.md`](./MIGRATION.md).

## Contributing

Bug reports, questions, and PRs are welcome on [GitHub](https://github.com/OpenBox-AI/openbox-copilotkit-sdk).

Local development:

```bash
npm install
npm run ci:check   # lint + typecheck + test + build + CI guards
```

`ci:check` enforces:

- ESLint + TypeScript strict typecheck.
- Vitest with coverage (lines/statements 60%, functions 70%, branches 50%).
- `scripts/check-no-otel.mjs` — fails the build if any `@opentelemetry/*` import re-enters the SDK.
- `scripts/check-no-mastra-imports.mjs` — fails if any `@mastra/*` import sneaks in (the SDK is framework-agnostic).

Commits follow the Conventional Commits format. Do not include AI-attribution lines.

## License

MIT — see [`LICENSE`](./LICENSE).
