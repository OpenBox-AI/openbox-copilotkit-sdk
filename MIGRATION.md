# Migration

## Unreleased (target: `0.3.0-beta.0`)

`0.3.0-beta.0` is **additive** at the AG-UI middleware boundary. Existing call sites continue to work unchanged; the new surface is opt-in.

### What changes

1. **New public types** under the package root: `OpenBoxVerdict`, `OpenBoxConstraint`, `OpenBoxReplacement`, `ApplierContext`, `ApplierResult`, `SpanData`, `SpanBuffer`, `EnforcementStatus`, plus the helper functions `mapVerdict`, `applyVerdict`, `synthesizeToolSpan`, `attachAuditEnvelope`, `idempotencyKey`. The existing `Verdict` enum and `GovernanceVerdictResponse` class are **unchanged**.
2. **AG-UI middleware accepts two new options:** `spanBuffer` and `redactPaths`. When `spanBuffer` is provided, the middleware synthesizes one `function_call` span per tool call. When omitted, behavior is identical to `0.2.x`.
3. **Span transport.** When `spanBuffer` is wired, the synthesized `function_call` span now ships **inline on the `ActivityCompleted` envelope** (as `payload.spans` + `hook_trigger: true`) so it lands on the corresponding openbox-core session alongside whatever `llm_completion` spans your other SDK emits. The buffer write is preserved — local-debug consumers (e.g. the `/api/debug/openbox-spans` route below) still drain via the buffer. Consumers that do **not** wire a `spanBuffer` see no envelope change (the `spans` / `hook_trigger` keys are omitted; payload shape is byte-identical to `0.3.0-beta.0`'s buffer-only path).

   Before (buffer-only):

   ```jsonc
   // ActivityCompleted on the wire
   { "event_type": "ActivityCompleted", "activity_id": "...", /* no spans field */ }
   ```

   After (envelope-attached when buffer wired):

   ```jsonc
   { "event_type": "ActivityCompleted", "activity_id": "...",
     "hook_trigger": true,
     "spans": [ { "name": "tool:weatherTool", "attributes": { "openbox.semantic_type": "function_call", "...": "..." } } ] }
   ```

### Recommended setup

1. **Add a module-singleton `SpanBuffer`** so dev hot-reload doesn't blow it away each iteration:

   ```ts
   // src/lib/openbox-span-buffer.ts
   import { SpanBuffer } from "@openbox-ai/openbox-copilotkit";
   const g = globalThis as unknown as { __openboxSpanBuffer?: SpanBuffer };
   export const spanBuffer = g.__openboxSpanBuffer ?? new SpanBuffer();
   if (process.env.NODE_ENV !== "production") g.__openboxSpanBuffer = spanBuffer;
   ```

2. **Pass it into the middleware** via `withOpenBoxRuntime(..., { middlewareOptions: { spanBuffer, redactPaths: [...] } })`.

3. **Configure `redactPaths`.** The recommended starter set:

   ```ts
   redactPaths: ["$..password", "$..secret", "$..token", "$..apiKey"]
   ```

   Supports two JSONPath shapes: leaf-key (`$..name` — redacts every leaf at any depth) and dotted (`$.a.b.name`). Anything else is ignored. **If you leave `redactPaths` empty, args/result previews are not redacted** — tool args of unknown shape may include credentials.

4. **Optional — add a debug route** to inspect the buffer in development:

   ```ts
   // src/app/api/debug/openbox-spans/route.ts
   if (process.env.NODE_ENV === "production" || process.env.OPENBOX_DEBUG_SPANS !== "1") {
     return new NextResponse("Not Found", { status: 404 });
   }
   return NextResponse.json(Object.fromEntries(spanBuffer.drain()));
   ```

   ⚠ **Never expose this in production.** Two gates protect against accidental deploy.

### New env knobs

| Variable | Default | Effect |
|---|---|---|
| `OPENBOX_SPAN_BUFFER_MAX_PER_WORKFLOW` | `1000` | Per-workflow span cap; oldest evicted on overflow with an audit signal |
| `OPENBOX_SPAN_BUFFER_TTL_MS` | `300000` | TTL after which a quiet workflow's spans are evicted |
| `OPENBOX_DISABLE_SPAN_BUFFER=1` | (off) | Emergency bypass — skip synthesis entirely |

### LLM completion spans

This SDK does **not** wrap `LanguageModelV1` and does **not** emit `llm_completion` spans. If you're using Mastra agents, install [`@openbox-ai/openbox-mastra-sdk`](https://www.npmjs.com/package/@openbox-ai/openbox-mastra-sdk) — its existing `LanguageModelV1` wrap emits LLM spans at the AI SDK seam. The two SDKs co-run without duplicate emission (distinct semantic types, distinct seams).

### Deferred verdict cases

`applyVerdict` ships with `allow` and `block` wired through. `constrain` / `require_approval` / `halt` emit an audit attribute (`openbox.enforcement_status:"late_detection"` or `"halt_requested"`) and throw `VerdictNotImplementedError`. Full enforcement lands at later ship gates:

- `constrain` → `0.4.0`
- `halt` routing → `0.4.0`
- approval polling → `0.5.0`

If your code ingests `OpenBoxVerdict` and you want to defer these without an error, catch `VerdictNotImplementedError` at the call site. Audits still flow.

### Rollback

- Code-level: revert the diff that added `spanBuffer` to your middleware options. The buffer holds no persistent state — no migration to undo.
- Runtime: set `OPENBOX_DISABLE_SPAN_BUFFER=1` to skip synthesis without redeploying. Effect: no spans are appended to the buffer **and** no `spans` / `hook_trigger` keys are attached to the `ActivityCompleted` envelope — wire-format reverts to the pre-`0.3.0-beta.0` shape.

## 0.2.0-beta.0 — 2026-06-29

See [`CHANGELOG.md`](./CHANGELOG.md) for the drop-OTel breaking-change list and migration notes.
