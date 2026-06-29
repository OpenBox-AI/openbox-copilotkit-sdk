# Changelog

## Unreleased

### Added — verdict surface (Phase 1)

- `OpenBoxVerdict` 5-case discriminated union (`allow` / `constrain` / `require_approval` / `block` / `halt`) under `src/verdict/`. Companion zod schema `OpenBoxVerdictSchema`.
- `mapVerdict(response, options?)` — single translation point from `GovernanceVerdictResponse` to `OpenBoxVerdict`. Permissive on missing optional fields, strict on shape mismatch (throws `VerdictMappingError`). `strictMode` opt-in turns unknown actions into errors instead of safe-block fallback.
- `applyVerdict(verdict, ctx)` — single enforcement point. `allow` and `block` are wired; `constrain`, `require_approval`, and `halt` audit then throw `VerdictNotImplementedError` (later ship gates: 0.4.0 / 0.5.0).
- Public types `ApplierContext`, `ApplierEvent`, `ApplierGateway`, `ApplierSubject`, `ApplierResult`, `OpenBoxConstraint`, `OpenBoxReplacement`, `OpenBoxHaltVerdict`, `OpenBoxRequireApprovalVerdict`.
- Test matrix: 18 wire-shape fixtures under `test/fixtures/governance-verdict-responses/` cover the (action × field-permutation) grid.

### Added — span foundation (Phase 2)

- `SpanBuffer` — bounded, per-workflow in-memory buffer (`Map<workflowId, SpanData[]>`) with FIFO overflow eviction + TTL eviction. Configurable via constructor opts or env (`OPENBOX_SPAN_BUFFER_MAX_PER_WORKFLOW`, default 1000; `OPENBOX_SPAN_BUFFER_TTL_MS`, default 300000). Plain TS — not an OTel `SpanProcessor`; the drop-OTel posture is preserved.
- `synthesizeToolSpan(triple, opts?)` — pure synthesizer that converts AG-UI `TOOL_CALL_*` event triples into `SpanData` with `openbox.semantic_type:"function_call"`, `tool.name`, `tool.args_hash`, redacted `tool.args_preview` (<= 256 bytes), `tool.result_hash`, `tool.duration_ms`. Optional `redactPaths` (leaf-key `$..key` and dotted `$.a.b.key` shapes) protect args/result previews.
- `attachAuditEnvelope(span, envelope)` — mutates a span in place to add the locked audit-envelope attribute set (`openbox.enforcement_owner`, `openbox.gateway`, `openbox.enforcement_status`, `openbox.idempotency_key`, `openbox.policy_version`, `openbox.trace_id`).
- `idempotencyKey({workflowId, runId, activityId, attempt})` — sha256(workflowId:runId:activityId:attempt). Cross-impl parity with `@openbox-ai/openbox-mastra-sdk` and Core's `setApprovalCache` fingerprint, validated by a golden test.
- AG-UI middleware now accepts `spanBuffer?: SpanBuffer` and `redactPaths?: string[]`. When `spanBuffer` is provided, the middleware synthesizes one `function_call` span per tool call at activity-completed time and appends it to the buffer. When absent, no spans are produced (no behavior change at the AG-UI middleware boundary).
- New env knob `OPENBOX_DISABLE_SPAN_BUFFER=1` skips synthesis entirely (emergency bypass).
- Test fixtures: 4 recorded AG-UI streams under `test/fixtures/agui-streams/` (single tool call, parallel tool calls, streamed args, end-without-result).

### Notes

- Additive only — the existing `Verdict` string-enum, `GovernanceVerdictResponse` class, and AG-UI emitter fanout stay unchanged. No call sites in middleware or emitter are altered by this slice; the applier is exercised by tests + the example demo wiring (Phase 3).
- LLM completion spans remain out of scope for this SDK. `@openbox-ai/openbox-mastra-sdk` owns the `llm_completion` seam; this SDK does not import from `ai` and has no `LanguageModelV1` wrap.

## 0.2.0-beta.0 — 2026-06-29

### Breaking

- Removed `setupOpenBoxOpenTelemetry` public export. OpenTelemetry install is no longer part of the SDK.
- Removed `OpenBoxSpanProcessor` public export. Workflow events flow exclusively via `client.evaluate(payload)`.
- Removed `OpenBoxTelemetryController` type.
- Removed `WorkflowSpanBuffer` type.
- Removed `governance/activity-runtime.ts` — orphan module (zero production callers in `src/`) deleted (Validation Session 1 Option B).
- `OpenBoxRuntimeController.spanProcessor` field removed; controller shape is now `{ client, defaults, logger }`.
- `withOpenBoxRuntime(...).shutdown` is now a hard-coded idempotent `Promise.resolve()` (was: OTel teardown). `OpenBoxClient` has no `shutdown` method; the closure is reserved for future client-side cleanup. Safe to leave SIGINT handlers in place.
- Removed 19 `@opentelemetry/*` runtime dependencies.
- Removed `./otel` and `./span` package subpath exports.
- Removed `opentelemetry` from `package.json` keywords.

### Added

- `scripts/check-no-otel.mjs` — CI guard that fails the build if any `@opentelemetry/*` import re-enters the target source directories (`src/config`, `src/client`, `src/identity`, `src/governance`, `src/types`). Wired into `ci:check` and `prepublishOnly`.
- `test/unit/no-otel-import.test.ts` — regression test asserting the built `dist/` is free of `@opentelemetry/*` import strings.
- `test/integration/evaluate-snapshot-baseline.test.ts` — deterministic AG-UI event sequence captured against a recording `OpenBoxClient`; asserts the `evaluate()` payload sequence stays byte-identical to the committed snapshot under `plans/260629-0501-drop-otel-from-openbox-copilotkit-sdk/snapshots/`. This is the lossless-drop proof, codified.

### Why

The OpenTelemetry install was inherited from a sibling SDK during initial scaffolding but never load-bearing in this SDK. Buffered spans were never flushed; no UI consumer depended on them. The peer-coexistence machinery existed only because OTel was inherited, not because the value justified the cost. See `plans/260629-0501-drop-otel-from-openbox-copilotkit-sdk/` for the full audit and rationale.

### Migration

- If your code imported `setupOpenBoxOpenTelemetry` or `OpenBoxSpanProcessor`: remove the imports. Workflow event emission is automatic via the AG-UI middleware.
- If your code installed OpenTelemetry independently (separate from this SDK): no change. You now own the global TracerProvider without contention from this SDK.
- If your `next.config.ts` `serverExternalPackages` listed `@opentelemetry/api` only because of this SDK: you can remove it.
- If your code relied on `withOpenBoxRuntime(...).shutdown()` to flush OTel spans: the call becomes a no-op resolved promise. Safe to remove or leave in place; the SIGINT pattern continues to work.

## 0.1.0-beta.0 — 2026-06-29 (initial)

- First release. See `plans/260628-2219-openbox-copilotkit-sdk/`.
