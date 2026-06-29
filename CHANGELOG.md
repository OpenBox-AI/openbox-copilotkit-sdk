# Changelog

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
