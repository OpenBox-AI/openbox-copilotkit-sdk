# Migration

## 0.4.0 — 2026-07-17

This release makes `@openbox-ai/openbox-copilotkit` a thin CopilotKit adapter over the base
`@openbox-ai/openbox-sdk-ts` runtime: the base SDK now owns config resolution, HTTP transport,
DID signing, verdict/guardrail types, and lifecycle event factories; this package owns only
CopilotKit/AG-UI-specific behavior (the middleware, span synthesis, multi-agent handoff wiring,
server-tool wrapping). Four real lifecycle defects from `0.3.0` are corrected along the way: a
false universal server-tool gate, an approval verdict that never actually waited, an interrupt
reported as a successful completion, and telemetry that serially blocked the AG-UI stream.

### BREAKING

- **The package root no longer exports the `src/verdict/*` surface**: `applyVerdict`, `mapVerdict`,
  `OpenBoxVerdictSchema`, `OpenBoxConstraintSchema`, `OpenBoxReplacementSchema`,
  `VerdictMappingError`, `VerdictNotImplementedError`, and the related `OpenBoxVerdict`/
  `OpenBoxConstraint`/`OpenBoxReplacement`/`Applier*` types are **removed**. They were never
  wired into the real enforcement path and `applyVerdict` unconditionally threw
  `VerdictNotImplementedError` for every verdict except `allow`/`block` — there is no working
  behavior to preserve. The base SDK's own `Verdict` enum and `EvaluationResult` type (re-exported
  from this package's root) are now the canonical verdict surface.
  - If you imported any of the names above: there is no drop-in replacement import. Inspect the
    base SDK's `Verdict`/`EvaluationResult` types directly, or use the new `serverTool()` /
    frontend-gate boundaries described below, which already raise a typed failure on a
    non-actionable verdict — you no longer need to call an applier yourself.

### DEPRECATED — `enforceApprovals` boundary corrected

- `middlewareOptions.enforceApprovals` (boolean) is **deprecated** in favor of
  `middlewareOptions.enforcement` (`OpenBoxEnforcementOptions`). It continues to work, but its
  scope is now honestly documented and, in some cases, narrower than the name implied:
  - `enforceApprovals: false` (default) behaves like `enforcement: { mode: "telemetry" }`.
  - `enforceApprovals: true` behaves like `enforcement: { frontendTools: "enforce" }` **only** —
    the frontend AG-UI `TOOL_CALL_END` gate. The first time this resolves to `true`, the SDK logs a
    one-time warning that server-side tools are **not** covered by this flag.
  - **`enforceApprovals` was never, and is not now, universal server-tool enforcement.** In
    `0.3.0` it only ever gated the AG-UI-observed stream (it could late-abort the stream, but a
    server tool's `execute` had already run by the time a BLOCK/HALT verdict arrived — see "Boundary
    truthfulness" below). Enforcing a server-side tool call **before** it executes now requires
    explicitly wrapping that tool with `createOpenBoxCopilotKit(...).serverTool()`.
  - When both `enforceApprovals` and `enforcement.frontendTools` are set, `enforcement.frontendTools`
    wins.

### NEW — `createOpenBoxCopilotKit` bundle + `serverTool()` pre-execution wrapper

- `createOpenBoxCopilotKit(options)` returns a bundle (`{ openboxRuntime, serverTool, shutdown,
  withRuntime }`) that owns one base `OpenBoxRuntime` plus the pieces `serverTool()` needs.
- `bundle.serverTool(tool)` wraps a server-side tool (e.g. an AI-SDK/CopilotKit `ToolDefinition`)
  so OpenBox evaluates — and, in `enforce` mode, awaits approval for — the call **before** its real
  `execute` runs:
  - `enforcement.mode: "enforce"`: BLOCK, HALT, a rejected/expired/timed-out `REQUIRE_APPROVAL`, and
    CONSTRAIN (see below) all prevent `execute` from ever running; the wrapper throws
    `CopilotKitGovernanceControlError` (or `CopilotKitServerToolCorrelationError` when the
    per-run correlation needed to enforce is missing). A missing run correlation in `enforce`
    mode is a **fail-safe that disables enforcement for that call** — it never silently
    downgrades to the old AG-UI-observation behavior.
  - `enforcement.mode: "telemetry"` (default): `execute` always runs; ActivityStarted/Completed
    telemetry is recorded best-effort, and a call with no per-run correlation gets a synthetic id
    marked `generated` rather than being silently dropped.
  - An approved call's real `execute` runs **exactly once**.
- This is the one supported way to gate a server-side tool's execution; nothing else in this SDK
  provides that pre-execution guarantee (see "Boundary truthfulness" below).

### Config aliases — deprecated but working (warn once per field name, per process)

Every field below keeps working exactly as before; the first time each is used it now also logs
one `logger.warn` pointing at its replacement. No config field is removed in `0.4.x` — removal (if
any) is deferred to `1.0.0`.

| Deprecated | Resolves to |
|---|---|
| `OPENBOX_URL` env var | `apiUrl` (or `OPENBOX_API_URL` / `OPENBOX_COPILOTKIT_API_URL`) |
| `governanceTimeout` | `timeoutSeconds` |
| `hitlEnabled` | `hitl.enabled` |
| `skipHitlActivityTypes` | `hitl.skipActivityTypes` |
| `skipWorkflowTypes` / `skipSignals` / `skipActivityTypes` | `gate.skipWorkflowTypes` / `gate.skipSignals` / `gate.skipActivityTypes` |
| `sendStartEvent` / `sendActivityStartEvent` | `gate.sendStartEvent` / `gate.sendActivityStartEvent` |
| `maxEvaluatePayloadBytes` | `telemetry.maxPayloadBytes` (same unit — UTF-8 bytes, envelope-total; honored only as a fallback when the new option is not already set) |
| `instrumentDatabases` (boolean) | **inert** — a boolean cannot name which driver(s) to instrument; pass `instrumentation: { enabled: true, databases: ["pg", "redis", "mysql2", "mongodb"] }` instead |
| `instrumentFileIo` | `instrumentation.fileEnabled` (only takes effect while `instrumentation.enabled` is `true`) |
| `httpCapture` | inert; removed at `1.0.0` — use `instrumentation: { enabled: true }` (HTTP instrumentation defaults on) |
| `evaluateMaxRetries` / `evaluateRetryBaseDelayMs` | no base-SDK equivalent and **not reimplemented** — the base client's own transport owns retries |

New `telemetry.*` options (`maxPendingEvents`, `maxConcurrentSends`, `flushTimeoutMs`,
`overflowPolicy`) configure the bounded, non-blocking telemetry queue described below.

### Instrumentation is now opt-in; startup validation is now opt-in

- Base instrumentation (HTTP/DB/file governance capture) is **off by default** in `0.4.0`. Pass
  `middlewareOptions.instrumentation: { enabled: true, databases: [...], strict?: boolean }` to turn
  it on. Merely importing the SDK patches nothing — only an explicit `enabled: true` does.
  Shutdown always flushes then shuts down any installed instrumentation controller before the
  runtime closes, restoring every patched global.
- `validateApiKeyAtStartup` (new, default `false`) is now the **only** opt-in path that performs a
  real `GET /api/v1/auth/validate` network round-trip at setup time. `withOpenBoxRuntime`/
  `createOpenBoxCopilotKit` never make a network call at construction unless this is explicitly
  set. This is distinct from the pre-existing `validate` config flag, which is format/shape
  validation only and never touches the network.

### Deprecated facade subpaths — `./client`, `./config`, `./identity`, `./types`

These subpaths are now thin, documented-deprecated shims over the base SDK — kept for one release,
**removed at `1.0.0`**:

- `./identity` and `./client` (`AgentIdentity`-shaped helpers, `OpenBoxClient`) delegate DID
  validation, key-loading, canonicalization, and Ed25519 signing to
  `@openbox-ai/openbox-sdk-ts/identity` — there is no second signer in this package. Nonce/timestamp
  *generation* stays adapter-owned so the wire values these facades emit are byte-identical to what
  they always emitted.
- `./config` (`parseOpenBoxConfig`/`initializeOpenBox`) delegates the core validated fields
  (`apiUrl`, `apiKey`, `agentDid`, `agentPrivateKey`) to the base SDK's `OpenBoxConfig.resolve()`.
  It is **not used internally** by `withOpenBoxRuntime`/`createOpenBoxCopilotKit` — the real runtime
  path resolves config through its own translator — this facade exists only for callers who
  imported it directly in `0.2.x`/`0.3.x`.
- `./types` re-exports base-compatible types where signature-compatible.

**Elevated trust boundary:** the base SDK now owns all signing/auth/verdict logic. This package's
`@openbox-ai/openbox-sdk-ts` dependency is pinned to an **exact** version (never a caret range) —
see the release checklist below — specifically because of that trust concentration.

### Interrupt semantics are now truthful

- An interrupted run emits a `copilotkit_interrupt` signal and keeps the activity **pending** — it
  emits **no** `ActivityCompleted`/`WorkflowCompleted` for that call. (`0.3.0` incorrectly emitted a
  successful completion for an interrupted run.)
- A resume run correlates on the interrupt's own `id` (never `toolCallId` — a non-`BuiltInAgent`
  interrupt may omit `toolCallId` entirely or carry one that differs from `id`).
- **Resume-with-no-pending-interrupt is a typed failure**, never a fabricated `ActivityCompleted`.
  A miss (never saved, already consumed, or TTL-expired) always surfaces as an explicit error to the
  resume caller.
- Interrupt persistence is an **injectable port** (`InterruptPersistencePort`); the bundled default
  (`InMemoryInterruptStore`) is explicitly **non-durable** — a process restart silently orphans any
  workflow still awaiting resume (there is no Core-side reaper either). Operators needing
  durability across restarts must inject their own port (e.g. Redis/Postgres-backed).

### CONSTRAIN is unsupported in `0.4.0`

HALT, BLOCK, and REQUIRE_APPROVAL are enforced (see the three boundaries below). **CONSTRAIN is
not** — the base runtime returns a CONSTRAIN verdict normally (it does not route it through any
adapter action), so an enforcing caller (the frontend gate, `serverTool()`) explicitly detects it
and raises a typed `CopilotKitUnsupportedVerdictError` **before** delivery/execution. This is never
a silent allow, and it is a different, more precise failure than the `0.3.0` behavior (which threw
an undifferentiated `VerdictNotImplementedError` from a code path that was never actually wired
into enforcement). A full CONSTRAIN rewrite (intercepting and modifying tool args pre-execution) is
deferred to a later release; there is no committed ship date.

### Boundary truthfulness — read this if you rely on this SDK for governance

`0.3.0`'s docs implied that blocking an AG-UI event universally prevented a server-side side
effect. **That was never true**, and `0.4.0` makes the three actual boundaries explicit instead:

| Boundary | Guarantee |
|---|---|
| A server tool wrapped with `bundle.serverTool()` | **Pre-execution enforcement.** In `enforce` mode, a non-allow verdict prevents `execute` from ever running. |
| An explicit frontend tool (`frontendToolNames`/`isFrontendTool`) | **Delivery gate**, not execution gate. The AG-UI `TOOL_CALL_END` event can be blocked before it reaches the frontend, but this SDK never runs frontend code. |
| An unwrapped server tool, an MCP tool, or an external-agent call | **Observation-only.** There is no pre-execution seam this SDK can hook into for a call it never wrapped — the middleware can only observe the AG-UI stream and, at most, late-abort it after the call may already have run. |

If you need a server-side side effect to be preventable, wrap that tool with
`bundle.serverTool(tool)` and set `enforcement.mode: "enforce"`. `enforceApprovals`/
`enforcement.frontendTools` alone never provided that guarantee for server tools, in `0.3.0` or
today.

### Multi-agent handoff

- The base `handoff()` factory replaces the hand-built handoff payload. It takes exactly the two
  fields Core's `ValidateHandoffPayload` requires (`from_agent_did`, `multi_agent_session_id`) —
  Core derives the receiver (`to_agent`) from the child-signed AIP headers, never from the payload.
- The default multi-agent session id prefix stays `mas:${runId}`, unchanged from `0.3.0`. The
  CopilotKit parent and the OpenBox Mastra child derive it from the same forwarded run id, so a
  matching prefix keeps one delegated run in a single multi-agent session; no downstream match
  needs to change.
- The wire `source` field on the `Handoff` event is now whatever the base `handoff()` factory
  defaults it to (`"workflow-telemetry"`) instead of a CopilotKit-specific value, because the base
  factory accepts no `extra` bag to override it. This is inconsequential to Core (it does not key
  any behavior off `source`) — every other event type (workflow/activity/signal) still stamps
  `source` explicitly.

### `fail_closed_destructive` degrades to fail-open for this SDK's gates

`onApiError: "fail_closed_destructive"` only fails closed when the base client detects a
**destructive span** on the outgoing payload. Neither the frontend lifecycle gate nor the
`serverTool()` enforce gate ever attaches spans to their envelopes (they are lifecycle events, not
span/hook evaluations) and `function_call` is not classified as a destructive activity type — so on
a Core outage, `fail_closed_destructive` behaves exactly like `fail_open` for both of this SDK's
enforcement gates. If you need hard outage blocking for server tools or the frontend gate,
configure `onApiError: "fail_closed"` instead.

### RELEASE CHECKLIST (maintainer-owned)

This package's `@openbox-ai/openbox-sdk-ts` dependency is now pinned to the **exact** published
version `"1.0.1"` from npm (no caret — the base SDK owns all signing/auth/verdict logic, so this
dependency is deliberately pinned rather than range-matched). The base SDK shipped to npm first;
what remains is the `npm publish` of *this* package. Steps 1–3 are done; run 4–7 before publishing:

1. ✅ Publish base `@openbox-ai/openbox-sdk-ts@1.0.1` to npm.
2. ✅ Swap this package's `dependencies["@openbox-ai/openbox-sdk-ts"]` from `file:../openbox-sdk-ts`
   to the **exact** string `"1.0.1"` (no caret; the base SDK now owns all signing/auth/verdict
   logic, so this dependency is deliberately pinned rather than range-matched).
3. ✅ `npm install` — purged the `file:` entry from `package-lock.json`.
4. Provenance check before publishing: `npm view @openbox-ai/openbox-sdk-ts name version
   dist-tags.latest dist.integrity gitHead --json` and confirm the resolved `1.0.1` matches the
   expected `gitHead`/integrity.
5. `npm publish` under a prerelease tag (not `latest`).
6. Run the CopilotKit demo + a clean-consumer install against the packed prerelease artifact;
   verify telemetry, `serverTool()` enforcement, the frontend gate, interrupt/resume, and
   multi-agent handoff all work against the real published dependency (not the `file:` link).
7. Promote the prerelease tag to `latest` only after step 6 passes. Keep `0.3.x` on npm as a
   rollback target.

## 0.3.0 — 2026-06-30

`0.3.0` was additive at the AG-UI middleware boundary. Existing call sites continued to work
unchanged; the new surface was opt-in.

### What changes

1. **New public types** under the package root: `OpenBoxVerdict`, `OpenBoxConstraint`, `OpenBoxReplacement`, `ApplierContext`, `ApplierResult`, `SpanData`, `SpanBuffer`, `EnforcementStatus`, plus the helper functions `mapVerdict`, `applyVerdict`, `synthesizeToolSpan`, `attachAuditEnvelope`, `idempotencyKey`. The existing `Verdict` enum and `GovernanceVerdictResponse` class are **unchanged**.
2. **AG-UI middleware accepts two new options:** `spanBuffer` and `redactPaths`. When `spanBuffer` is provided, the middleware synthesizes one `function_call` span per tool call. When omitted, behavior is identical to `0.2.x`.
3. **Span transport.** When `spanBuffer` is wired, the synthesized `function_call` span now ships to openbox-core as a **sibling `ActivityStarted`-shaped event** (`hook_trigger: true`, `hook_stage: "completed"`, `activity_type: "function_call"`) emitted immediately after the original `ActivityCompleted`. The two events share the same `activity_id` so openbox-core ties them together at the session UI. This pattern mirrors how `@openbox-ai/openbox-mastra-sdk` ships its HTTP/DB hook spans — openbox-core's `ActivityCompleted` schema currently rejects an inline `spans` field, so the hook-event side channel is the validated transport path. The buffer write is preserved — local-debug consumers (e.g. the `/api/debug/openbox-spans` route below) still drain via the buffer. Consumers that do **not** wire a `spanBuffer` see no new events.

   Before (buffer-only):

   ```jsonc
   // Wire events on the run
   { "event_type": "ActivityCompleted", "activity_id": "call_1", "activity_type": "weatherTool" }
   // (no second event — spans never reached openbox-core)
   ```

   After (sibling hook event when buffer wired):

   ```jsonc
   { "event_type": "ActivityCompleted", "activity_id": "call_1", "activity_type": "weatherTool" }
   { "event_type": "ActivityStarted", "activity_id": "call_1",
     "activity_type": "function_call",
     "hook_trigger": true,
     "attempt": 1,
     "spans": [{
       "name": "tool:weatherTool",
       "span_id": "...", "trace_id": "...",
       "start_time": 1750000000000000000,
       "end_time":   1750000000123000000,
       "duration_ns": 123000000,
       "status": { "code": "OK" },
       "stage": "completed",
       "kind": "INTERNAL",
       "semantic_type": "function_call",
       "hook_type": "function_call",
       "function": "weatherTool",
       "events": [],
       "attributes": { "tool.name": "weatherTool", "tool.call_id": "call_1", "openbox.enforcement_owner": "openbox-copilotkit", "...": "..." }
     }]
   }
   ```

   The wire shape is taken from `openbox-core/internal/content/governance.go:SpanData` and mirrors what `openbox-mastra-sdk`'s `createHookSpan` produces. Notable transforms vs the internal `SpanData` type (`@openbox-ai/openbox-copilotkit`'s `SpanData` export, kept stable so `SpanBuffer` consumers are unaffected): `start_time_unix_nano` (bigint) → `start_time` (JSON number); `end_time_unix_nano` (bigint) → `end_time` (JSON number); `status: "ok"|"error"` (string) → `status: { code: "OK"|"ERROR" }` (struct). Top-level `semantic_type`, `hook_type`, `kind`, `events: []` are added because openbox-core's Go schema requires them at the top level (not inside `attributes`). Timestamps ship as JSON numbers because openbox-core unmarshals them into `int64` (it rejects strings). The hook event omits `activity_output` (rejected on `ActivityStarted` by openbox-core).

   Span timestamps (`start_time_unix_nano` / `end_time_unix_nano`) are coerced to OTel-JSON decimal strings on the wire so the payload remains JSON-serializable. The `SpanBuffer` keeps the raw `bigint` shape.

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
- Runtime: set `OPENBOX_DISABLE_SPAN_BUFFER=1` to skip synthesis without redeploying. Effect: no spans are appended to the buffer **and** no sibling `ActivityStarted` hook event is emitted — only the original `ActivityCompleted` ships, identical to the pre-`0.3.0-beta.0` wire shape.

## 0.2.0-beta.0 — 2026-06-29

See [`CHANGELOG.md`](./CHANGELOG.md) for the drop-OTel breaking-change list and migration notes.
