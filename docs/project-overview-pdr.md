# OpenBox CopilotKit SDK — Project Overview & PDR

**Version**: 0.2.0-beta.0  
**Updated**: 2026-06-29  
**License**: MIT

## What & Why

**OpenBox CopilotKit SDK** is a server-only governance + observability SDK for **CopilotKit `runtime/v2`**. It observes agentic activity at the CopilotKit/AG-UI boundary — frontend tool calls, final assistant messages, HITL approvals — and enforces governance decisions without requiring modifications to per-framework SDKs.

**Why**: CopilotKit's per-framework SDKs (React, Vue, etc.) can't see cross-framework patterns. The AG-UI middleware boundary is the unique vantage point to observe complete workflows, synthesize spans, and correlate multi-agent handoffs.

**Who**: Node.js backend adopters running CopilotKit `runtime/v2` who need governance (block/constrain tools, require HITL approval) and observability (audit trails, span synthesis).

## Functional Requirements

### Core Governance Path

- **Tool observation**: Observe `TOOL_CALL_*` events from AG-UI; emit `ActivityStarted` → call `client.evaluate(payload)`.
- **Verdict enforcement**: Map `GovernanceVerdictResponse` to 5-case discriminated union (`allow | block | constrain | require_approval | halt`); apply synchronously.
- **Blocking**: Inject `RUN_ERROR` with `governance_blocked` code; halt observable to prevent tool execution.
- **Approval tracking**: Store pending approvals in-memory; poll via `client.pollApproval(approval_id)` to resolve.

### Observability Path

- **Span synthesis**: Synthesize `function_call` spans from `TOOL_CALL_*` triples; include tool name, args hash, result hash, execution duration.
- **Audit envelope**: Attach idempotency keys, enforcement status, policy version to each span.
- **SpanBuffer**: Bounded FIFO buffer (cap: 1000 spans, TTL: 300s) with TTL eviction + manual drain.
- **DID signing**: Sign HTTP requests to OpenBox API with Ed25519; include agent identity in headers.

### Configuration & Security

- **Environment-driven**: 19 `OPENBOX_*` env vars; fallback to defaults for optional toggles.
- **API key format**: Regex `^obx_(live|test)_[a-zA-Z0-9_]+$`; fail-open if missing.
- **DID validation**: Optional pair `OPENBOX_AGENT_DID` + `OPENBOX_AGENT_PRIVATE_KEY` (base64 32-byte Ed25519 seed); both or neither.
- **URL security**: Reject HTTP unless host is localhost/127.0.0.1/::1.
- **httpCapture field**: Reserved for future use; currently inert (no behavioral effect in 0.2.0–0.3.0-beta.0).

### Multi-Agent Support

- **Handoff tracking**: Detect `handoffTools` in agent config; emit `HANDOFF` marker.
- **Dedup key**: `${sessionId}::${parentDid}::${childName}::${activityId}` prevents double-emission.
- **Context propagation**: `AsyncLocalStorage` context forwarded to child agents.

## Non-Functional Requirements

### Reliability

- **Telemetry-default**: Record all events; block nothing unless `enforceApprovals: true`.
- **Fail-open**: Missing API credentials, timeout, or network errors → log + allow (no user impact).
- **Idempotency**: SHA256 hash of `workflowId:runId:activityId:attempt`; safe to retry.

### Performance

- **Sub-50ms median latency**: evaluate call (HTTP + 2 retries max); timeout 30s.
- **Bounded memory**: SpanBuffer capped at 1000 spans/workflow; TTL eviction every 150s.
- **No blocking**: All SDK operations async; no synchronous I/O in hot paths.

### Compliance

- **Node ≥24.10.0**: Requires `AsyncLocalStorage` + ES2023.
- **ESM-only**: No CommonJS support; `verbatimModuleSyntax` enforced.
- **No implicit framework lock-in**: Peer dependency model; each framework handles its own integration.

### Zero-Blocking Footprint

- **Drop-in adoption**: ≤4 lines added to adopter code (`withOpenBoxRuntime` wrapper).
- **OTel removal proven**: 0.2.0 integration test (`evaluate-snapshot-baseline.test.ts`) proves lossless governance events without OpenTelemetry.

## Out of Scope (Current & Deferred)

- **Client-side governance**: No browser/frontend code; CopilotKit owns frontend.
- **OpenTelemetry tracing**: Removed in 0.2.0; apps own their TracerProvider setup.
- **Framework-specific wrapping**: No built-in React/Vue/Svelte adapters (per-framework SDKs handle that).
- **Mastra-specific logic**: Co-runs with `@openbox-ai/openbox-mastra-sdk`; no shared span ownership.
- **CopilotKit v1 endpoint helpers**: v2 only; v1 support deferred to future release.
- **`constrain` applier**: Deferred to 0.4.0 (Phase 3 enforcement).
- **`require_approval` + `halt` appliers**: Deferred to 0.5.0 (Phase 3 enforcement).

## Success Criteria

| Criterion | Target | Evidence |
|-----------|--------|----------|
| Drop-in adoption diff | ≤4 lines | `demo/mastra/` shows `withOpenBoxRuntime(opts, config)` wrapping |
| Zero-blocking by default | true | Telemetry-default policy; `evaluatePolicy: "fail_open"` is default |
| Lossless OTel removal | proven | `evaluate-snapshot-baseline.test.ts` passes; governance events snapshot matches |
| Governance latency | <50ms P50 | HTTP client retry logic + 2-retry budget; 30s timeout |
| SpanBuffer memory bounded | <1000 spans/workflow | TTL eviction + cap enforcement in `SpanBuffer` |
| TypeScript strict | 100% | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride` enforced |
| Test coverage | lines ≥60%, branches ≥50% | `vitest run --coverage` (v8) validates baseline Phase 1 |

## Architecture Boundary

The SDK sits at the **AG-UI middleware boundary**, between CopilotKit's `runtime/v2` request handler and the observable event stream:

```
Adopter Route
  ↓
withOpenBoxRuntime() wrapper
  ↓
Agent Proxy (wraps clone)
  ↓
OpenBoxMiddleware (per-clone, injected via .use())
  ↓
AG-UI event stream
  ↓
Governance evaluation → verdict apply → response
```

Co-runs with `@openbox-ai/openbox-mastra-sdk` without span duplication:
- **SDK owns**: `function_call` spans at AG-UI `TOOL_CALL_*` events.
- **Mastra SDK owns**: `llm_completion` spans at Vercel AI `LanguageModelV1` boundary.

## Acceptance Criteria — Definition of Done

- [ ] All 5 new doc files created and linked (overview, codebase, standards, architecture, roadmap).
- [ ] Code examples in docs tested against actual source (function signatures, config keys, exports).
- [ ] Public-surface map mirrors `package.json` `exports` exactly.
- [ ] Key files > 300 LOC flagged with LOC count and modularization candidate status.
- [ ] Test layout documented with fixture categories and coverage thresholds.
- [ ] Cross-framework independence verified: no `@mastra/*`, no `@opentelemetry/*` in src/.
- [ ] `AsyncLocalStorage` and DID signing flows documented with sequence detail.
- [ ] Roadmap captures Phase 1/2/2b scope + Future deferred items.
- [ ] No fabricated code signatures, config keys, or API response shapes.
- [ ] All relative doc links validated and working.
