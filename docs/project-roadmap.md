# Project Roadmap

**Last Updated**: 2026-06-29  
**Current Version**: 0.2.0-beta.0  
**Stable Release Target**: 0.5.0 (Q3 2026 estimate)

## Version History

### 0.1.0 (Initial Release, Unreleased)
- Basic AG-UI observation
- Governance evaluate call
- Manual middleware attachment
- OpenTelemetry tracing (removed in 0.2.0)

### 0.2.0-beta.0 (Current, June 2026)
- **Highlight**: OpenTelemetry removed; governance events live independently
- `withOpenBoxRuntime()` canonical entry point
- 5-header DID-signed requests
- `SpanBuffer` foundation (no spans shipped yet)
- Verdict mapper for 5-case union
- Applier wires `allow` + `block` only
- Multi-agent dedup key prevents double-emission
- Lossless OTel removal proved by `evaluate-snapshot-baseline.test.ts`
- Phase 1 coverage baseline: lines 60%, branches 50%

**Breaking Changes**: None (beta → beta transition only)

---

## Roadmap: 0.3.0-beta.0 (Q2–Q3 2026)

### Phase 1: Verdict Implementation (Jun–Jul 2026)

**Scope**: Complete 5-case verdict union; wire `allow` + `block` only in enforcer.

**Requirements**:
- [x] `OpenBoxVerdict` discriminated union defined (4 open cases)
- [x] `mapVerdict()` translates `GovernanceVerdictResponse` → union
- [x] `applyVerdict()` routes on verdict tag
- [x] `allow` → pass through (no-op)
- [x] `block` → inject `RUN_ERROR` with `governance_blocked` code + correlation ID
- [x] `constrain`, `require_approval`, `halt` → throw `VerdictNotImplementedError` with clear Phase 3 marker
- [ ] Tests: 5-case routing + error messages
- [ ] Docs: Verdict lifecycle in system-architecture.md

**Non-Goals**: Implement constrain/require_approval/halt appliers (Phase 3).

**Acceptance**:
- All 5 verdict paths routable
- Block verdict halts observable stream
- Unit tests for each case
- Roadmap links to Phase 3 deferral

---

### Phase 2: Span Synthesis & Buffering (Jul–Aug 2026)

**Scope**: Synthesize `function_call` spans from AG-UI triples; buffer with TTL eviction.

**Requirements**:
- [x] `SpanBuffer` API: `append()`, `flush()`, `drain()`, `peek()`, `size()`, `workflowCount()`
- [x] Cap: 1000 spans/workflow (configurable via `OPENBOX_SPAN_BUFFER_MAX_PER_WORKFLOW`)
- [x] TTL: 300s (configurable via `OPENBOX_SPAN_BUFFER_TTL_MS`)
- [x] Eviction: TTL/2 interval (150s default) with unref'd timer
- [x] Emergency bypass: `OPENBOX_DISABLE_SPAN_BUFFER=1`
- [x] `ToolCallTriple` input (tool name, args, result, timing)
- [x] `SpanData` output with `openbox.semantic_type="function_call"`
- [x] Span attributes: tool name, call ID, duration, args hash, result hash, arg/result previews (≤256B, redacted)
- [x] `attachAuditEnvelope()` adds idempotency key + enforcement status
- [ ] Tests: TTL eviction, cap enforcement, concurrent append/drain
- [ ] Tests: Span snapshot baseline (redaction proof)
- [ ] Docs: Span synthesis flow in system-architecture.md

**Non-Goals**: Ship spans to OpenBox API yet (Phase 2b).

**Acceptance**:
- SpanBuffer bounded; no OOM
- TTL eviction proven in tests
- Span data redacted (no raw args/results)
- Audit envelope attached
- Snapshot test validates redaction

---

### Phase 2b: Span Transport (Aug–Sep 2026)

**Scope**: Ship synthesized spans as sibling events to OpenBox API (like ActivityStarted).

**Requirements**:
- [ ] `ActivityStarted`-shaped hook event for each buffered span
- [ ] Opt-in via `middlewareOptions.spanBuffer` (default: false in 0.3.0-beta.0)
- [ ] Ship on `RUN_FINISHED` or manual `drain()` call
- [ ] DID-sign span payload (same canonical request as governance eval)
- [ ] Retry logic (inherit from client)
- [ ] Span `/api/v1/spans` endpoint integration (OpenBox API design TBD)
- [ ] Dedup key: SHA256(workflowId:runId:activityId:attempt) prevents replay
- [ ] Tests: Span POST mocked; verify headers, body shape, dedup
- [ ] Docs: Span transport flow in system-architecture.md

**Non-Goals**: Span schema evolution; multiple span types (only function_call in Phase 2b).

**Acceptance**:
- Spans ship independently of governance events
- Transport opt-in; adopter controls
- Signature+dedup prevent replay
- E2E snapshot test: AG-UI triple → span POST

---

## Roadmap: 0.4.0 (Sep–Oct 2026)

### Phase 3a: Constrain Verdict Applier

**Scope**: Implement `constrain` verdict enforcement; rewrite tool args/constraints.

**Requirements** (Provisional):
- Applier intercepts tool call pre-execution
- Constraints object describes allowed values (e.g., `{ query_max_length: 100 }`)
- Rewrite tool args to comply (e.g., truncate query)
- Emit modified TOOL_CALL_* event downstream
- Test: Rewrite snapshots; verify compliance

**Release**: 0.4.0-beta.0 (constrain only; require_approval/halt deferred to 0.5.0)

---

## Roadmap: 0.5.0 (Oct–Nov 2026)

### Phase 3b: Approval & Halt Verdicts

**Scope**: Implement `require_approval` (HITL polling) + `halt` (stop workflow).

**Requirements** (Provisional):
- `require_approval` verdict → create approval in registry + emit signal
- Adopter polls `client.pollApproval(approvalId)` periodically
- On approval: unblock tool; emit `SIGNAL_RECEIVED("approval_granted")`
- On rejection: emit `SIGNAL_RECEIVED("approval_rejected")` + halt
- `halt` verdict → stop workflow; emit `SIGNAL_RECEIVED("halt_requested")`
- Approval TTL: default 1h; configurable
- Retry polling logic; exponential backoff in adopter's hands

**Release**: 0.5.0-beta.0

---

## Future Releases (2027+)

### 0.6.0: React HITL Companion Package

**Scope** (Provisional):
- React hook for approval polling
- UI components for approval decision interface
- Integration with adopter's auth context

**Why separate**: HITL is frontend-specific; CopilotKit SDK is backend-only.

---

### 0.7.0: Broader Per-Verdict Enforcement

**Scope** (Provisional):
- Verdict context payload (metadata, user context, business rules)
- Custom applier callbacks per verdict type
- Pluggable enforcement strategies

**Why deferred**: MVP is built-in allow/block; extensibility later.

---

### 0.8.0: CopilotKit v1 Endpoint Helpers

**Scope** (Provisional):
- Middleware for CopilotKit v1 `/api/copilotkit/` endpoints
- Adapter pattern (v1 event types → SDK governance model)
- v1 agent wrapping helpers

**Why separate release**: v2 is current focus; v1 is legacy support.

---

### 0.9.0+: Phase 3 CopilotKit-Specific Governance Hooks

**Scope** (Provisional):
- `onToolSelected` hook (pre-execution observation point)
- `onHandoffInitiated` hook (multi-agent boundary)
- `onApprovalRequired` hook (HITL signal)
- Coverage ratcheted back up: lines 75%+, branches 65%+

**Why separate**: Deep CopilotKit coupling; needs v2 maturity.

---

## Deprecated / Out of Scope

### OpenTelemetry Re-Integration (Not Planned)

**Reason**: Removed in 0.2.0 intentionally. Each adopter owns TracerProvider setup. SDK emits no spans to global provider. If tracing needed, adopter bridges SDK events → custom tracer.

**Alternative**: Adopter can listen to `ActivityStarted` events and correlate with their tracer context.

### Mastra SDK Integration (Not Planned)

**Reason**: Co-run pattern is intentional. No shared span ownership. Each SDK owns its boundary (AG-UI vs. LLM). CI enforces `check-no-mastra.mjs`.

---

## Metrics & Success Criteria (By Release)

| Metric | 0.2.0 | 0.3.0-beta | 0.4.0 | 0.5.0 | Notes |
|--------|-------|-----------|-------|-------|-------|
| **Verdict applier coverage** | 2/5 (allow, block) | 2/5 | 3/5 (+ constrain) | 5/5 (+ approval, halt) | Deferred phases |
| **Span synthesis** | Foundation only | ✓ + audit envelope | ✓ + transport | ✓ | Phase 2 → 2b |
| **Test coverage (lines)** | ≥60% | ≥65% | ≥70% | ≥75% | Phase 3 pushes coverage up |
| **Adopter latency (P50)** | <50ms (target) | <50ms | <100ms (approval poll async) | <100ms | Approval polling async; no blocking |
| **Multi-agent support** | Basic dedup | Dedup + context propagation | Constrain context passing | Approval context | Incremental richness |

---

## Key Milestones

```
Jun 2026:  0.2.0-beta.0 shipped (OTel removed)
Jul 2026:  0.3.0-beta.0 Phase 1 (verdict routing)
Aug 2026:  0.3.0-beta.0 Phase 2 (span synthesis + buffer)
Sep 2026:  0.3.0 stable release candidate
Sep 2026:  0.4.0-beta.0 (constrain applier)
Oct 2026:  0.5.0-beta.0 (approval + halt)
Nov 2026:  0.5.0 stable release (MVP complete)
2027:      Companion packages (React HITL, v1 helpers, etc.)
```

---

## Adoption Milestones

| Milestone | Target | Status | Notes |
|-----------|--------|--------|-------|
| Internal dogfooding | End Q2 2026 | TBD | OpenBox AI team uses SDK |
| Beta testers (2–3 adopters) | End Q3 2026 | Not started | Feedback → 0.5.0 |
| GA announcement | Q4 2026 | Planned | Marketing + release notes |
| Case studies | 2027 | Post-GA | Customer success stories |

---

## Known Limitations & Constraints

### Phase 1–2 Constraints

1. **Verdict enforcement limited to `allow` + `block`**: Constrain/approval/halt deferred to Phase 3 (0.4.0+); others throw clear errors.
2. **SpanBuffer not yet shipped**: Synthesized in 0.3.0 Phase 2, but transport (Phase 2b) is opt-in in Sep 2026.
3. **No approval persistence**: Approvals live in-memory only; restart loses pending approvals. Persistence deferred to 0.6.0+.
4. **Single OpenBox endpoint**: No multi-region failover support (future architecture decision).
5. **AsyncLocalStorage only**: Edge runtimes (Cloudflare Workers, Deno Deploy) not supported (no ALS); Node.js server only.

### Intentional Simplifications (Not Planned to Change)

1. **No OpenTelemetry**: Adopter owns tracing; SDK observes and emits events (not spans to global provider).
2. **No Mastra SDK wrapping**: Co-run pattern is by design; CI enforces boundaries.
3. **No client-side governance**: Browser decisions made by CopilotKit; SDK at backend boundary only.
4. **No per-framework SDKs**: CopilotKit v2 owns framework integration; SDK is framework-agnostic.

---

## Open Questions & Decisions Needed

### Architecture Decisions Pending

1. **Approval persistence**: Should 0.6.0 include built-in Redis/DB support, or leave to adopter?
   - **Current**: In-memory only (fine for MVP)
   - **Future**: Needs product decision

2. **Multi-region OpenBox endpoints**: Should SDK support sharded/regional API endpoints?
   - **Current**: Single URL only
   - **Future**: Depends on OpenBox API roadmap

3. **Custom verdict appliers**: Should 0.7.0+ allow pluggable applier strategies per verdict?
   - **Current**: Built-in allow/block only
   - **Future**: Depends on adopter feedback

4. **Span schema versioning**: How should span attribute schema evolve over time?
   - **Current**: No versioning; all 0.2.0+ spans use same schema
   - **Future**: Needs governance

### Adopter Feedback Needed (Post-Beta)

1. **Verdict latency**: Is <50ms P50 sufficient, or do adopters need sub-10ms?
2. **Span redaction**: Are JSONPath defaults sufficient, or need per-tool redaction profiles?
3. **Approval UX**: Should approvals auto-resolve after certain conditions (e.g., escalation to admin)?
4. **Multi-agent orchestration**: Does dedup key approach handle recursive handoffs?

### Open Design Decisions

1. **Middleware modularization** (Q5): Should `openbox-middleware.ts` (997 LOC) be split proactively at 1200 LOC, or wait for functional boundaries to demand it? Current: no decision yet. Conservative approach preferred — split only if >1200 LOC OR new responsibility emerges.

---

## Dependencies & Blockers

| Blocker | Status | Resolution |
|---------|--------|------------|
| OpenBox API `/api/v1/governance/evaluate` stability | Shipped | ✓ |
| OpenBox API `/api/v1/governance/approval` (polling) | TBD for 0.5.0 | Needs design |
| OpenBox API `/api/v1/spans` (transport) | TBD for Phase 2b | Needs design |
| CopilotKit v2 AG-UI event schema stability | Shipped | ✓ |
| Node.js 24.10.0+ LTS | May 2025 | Assumed stable |

---

## Success Definition (0.5.0 Stable)

- [x] Drop-in adoption: ≤4 lines adopter code (as of 0.2.0)
- [x] Zero-blocking default: Telemetry-default policy (as of 0.2.0)
- [ ] 5 verdicts routable (all phases wired)
- [ ] Spans synthesized + optional transport
- [ ] 75%+ test coverage (lines)
- [ ] 2–3 beta testers with positive feedback
- [ ] No critical bugs in Phase 1–2 (approval/halt Phase 3)
- [ ] Multi-agent dedup proven in real workflows
- [ ] Approval TTL + polling mechanics validated

---

## Unresolved Questions

1. Should `openbox-middleware.ts` (997 LOC) be split proactively in 0.3.0, or wait until >1200 LOC?
2. Are there real-world workflows with >1000 spans per request that would overflow SpanBuffer? If yes, increase cap?
3. Should approval polling be built-in retries, or delegated entirely to adopter?
4. After 0.5.0 stable, what's the release cadence (monthly, quarterly)?
5. Should CopilotKit v1 support be considered as parallel 0.6.0-v1-compat branch, or post-pone entirely?
