# Project Roadmap

**Last Updated**: 2026-07-17
**Current Version**: 0.4.0
**Stable Release Target**: 1.0.0 (removes deprecated facades/aliases; no committed date)

> **Note on this roadmap's 0.4.0/0.5.0 sections below.** The `0.2.0`/`0.3.0` entries are an accurate historical record. The `0.4.0`/`0.5.0` **plans** that follow them were written before the actual `0.4.0` work started and describe a "constrain applier first, then approval+halt" sequencing that is **not what shipped**. The real `0.4.0` (delivered via the `openbox-sdk-ts` adoption migration — see [`MIGRATION.md`](../MIGRATION.md)) ships real `REQUIRE_APPROVAL` waiting and HALT/BLOCK enforcement, explicit `serverTool()` pre-execution governance, and truthful interrupt semantics — and explicitly **excludes** CONSTRAIN (unsupported, typed failure, no committed ship date), reversing the original sequencing. The corrected status is called out inline below; the surrounding provisional requirement checklists are left as the historical planning record.

## Version History

### 0.1.0 (Initial Release, Unreleased)
- Basic AG-UI observation
- Governance evaluate call
- Manual middleware attachment
- OpenTelemetry tracing (removed in 0.2.0)

### 0.2.0-beta.0 (Published, June 2026)
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

## 0.3.0 (Current, June 2026)

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
- [ ] Opt-in via `middlewareOptions.spanBuffer` (default: false in 0.3.0)
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

## Roadmap: 0.4.0 (shipped 2026-07-17) — corrected

> **This is what actually shipped**, superseding the "Phase 3a: Constrain Verdict Applier" plan below (kept underneath, struck from the release, as the historical planning record).

**Scope (actual)**: Adopt `@openbox-ai/openbox-sdk-ts` as the base runtime (full migration); correct four lifecycle defects (false universal server-tool gate, approval verdict that never waited, interrupt reported as success, telemetry that serially blocked the stream); ship `createOpenBoxCopilotKit`/`serverTool()` explicit server-tool governance; exclude CONSTRAIN (unsupported, documented, no committed ship date — reverses the plan below, which assumed constrain would ship first).

**Delivered**:
- [x] `REQUIRE_APPROVAL` verdict — real waiting via the base `ApprovalPoller` (`waitForDecision`), not deferred to `0.5.0`
- [x] `HALT`/`BLOCK` — enforced at both the frontend delivery gate and, for wrapped tools, `serverTool()`'s pre-execution gate
- [x] `CONSTRAIN` — explicit `CopilotKitUnsupportedVerdictError` at the enforcing boundaries; **not** implemented, no committed ship date (reverses this section's original plan below)
- [x] Truthful interrupt/resume semantics (typed failure on resume-with-no-pending, injectable non-durable persistence port)
- [x] Non-blocking bounded telemetry queue
- [x] `src/verdict/*` public exports removed (breaking change — never wired into real enforcement)
- [ ] Full CONSTRAIN rewrite (tool-arg interception/modification pre-execution) — deferred, no target release yet

<details>
<summary>Original plan for this section (not what shipped — kept for history)</summary>

### Phase 3a: Constrain Verdict Applier (superseded)

**Scope**: Implement `constrain` verdict enforcement; rewrite tool args/constraints.

**Requirements** (Provisional):
- Applier intercepts tool call pre-execution
- Constraints object describes allowed values (e.g., `{ query_max_length: 100 }`)
- Rewrite tool args to comply (e.g., truncate query)
- Emit modified TOOL_CALL_* event downstream
- Test: Rewrite snapshots; verify compliance

**Release**: 0.4.0-beta.0 (constrain only; require_approval/halt deferred to 0.5.0)

</details>

---

## Roadmap: 0.5.0 — scope TBD

> `REQUIRE_APPROVAL` (HITL polling) and `HALT` shipped in `0.4.0` (above), not here — the "Phase 3b" plan below is superseded. `0.5.0`'s actual scope has not been planned yet; likely candidates are the full CONSTRAIN rewrite and interrupt-persistence hardening, but neither is committed.

<details>
<summary>Original plan for this section (not what shipped — kept for history)</summary>

### Phase 3b: Approval & Halt Verdicts (superseded — shipped in 0.4.0 instead)

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

</details>

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

| Metric | 0.2.0 | 0.3.0 | 0.4.0 (actual) | Notes |
|--------|-------|-----------|-------|-------|
| **Verdict enforcement coverage** | 2/5 (allow, block — frontend-observed only) | 2/5 (unchanged; verdict/* module added but never wired) | 4/5 (allow, block, halt, require_approval — real waiting; per-boundary, not one applier) | `constrain` is the one unsupported case — explicit typed failure, no committed date |
| **Span synthesis** | Foundation only | ✓ + audit envelope + transport | ✓ (unchanged) | — |
| **Test coverage (lines)** | ≥60% | ≥65% | see `docs/code-standards.md` thresholds | Coverage thresholds did not change as part of this migration |
| **Server-tool pre-execution enforcement** | none | none | ✓ via `bundle.serverTool()` | New in `0.4.0` — the first boundary with an execution-time guarantee |
| **Multi-agent support** | Basic dedup | Dedup + context propagation | Base `handoff()` factory; `mas:` session prefix retained | Handoff payload simplified to the two Core-required fields (D1) |

---

## Key Milestones

```
Jun 2026:  0.2.0-beta.0 shipped (OTel removed)
Jun 2026:  0.3.0 shipped (verdict routing + span synthesis, never wired into enforcement)
Jul 2026:  0.4.0 shipped (base-SDK adoption; serverTool() pre-execution governance;
                          real require_approval waiting; halt/block enforced;
                          constrain explicitly unsupported)
TBD:       0.5.0 scope not yet planned
TBD:       1.0.0 — removes deprecated facades/config aliases; API stability
2027+:     Companion packages (React HITL, v1 helpers, etc.) — unscheduled
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

### Current (as of 0.4.0) Constraints

1. **CONSTRAIN is unsupported**: raises a typed `CopilotKitUnsupportedVerdictError` at the enforcing boundaries rather than being applied; no committed ship date for full support (reverses the original Phase 1–2 plan below, which assumed `allow`+`block` only and `constrain` shipping before `require_approval`/`halt` — in reality `require_approval`/`halt` shipped in `0.4.0` and `constrain` did not).
2. **Interrupt persistence is non-durable by default**: the bundled `InMemoryInterruptStore` loses pending interrupts on restart (no Core-side reaper either); operators needing durability must inject their own `InterruptPersistencePort`.
3. **Server-tool enforcement requires explicit wrapping**: `bundle.serverTool()` must wrap a tool for pre-execution enforcement to apply to it; an unwrapped server tool, MCP tool, or external-agent call remains observation-only — there is no way to retroactively enforce a call this SDK never wrapped.
4. **Single OpenBox endpoint**: No multi-region failover support (future architecture decision).
5. **AsyncLocalStorage only**: Edge runtimes (Cloudflare Workers, Deno Deploy) not supported (no ALS); Node.js server only.

<details>
<summary>Original Phase 1–2 constraints (historical — superseded by 0.4.0 above)</summary>

1. **Verdict enforcement limited to `allow` + `block`**: Constrain/approval/halt deferred to Phase 3 (0.4.0+); others throw clear errors.
2. **SpanBuffer not yet shipped**: Synthesized in 0.3.0 Phase 2, but transport (Phase 2b) is opt-in in Sep 2026.
3. **No approval persistence**: Approvals live in-memory only; restart loses pending approvals. Persistence deferred to 0.6.0+.

</details>

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
| OpenBox API `/api/v1/governance/approval` (polling) | Shipped in 0.4.0 | ✓ — real waiting via the base `ApprovalPoller` |
| OpenBox API `/api/v1/spans` (transport) | Shipped in 0.3.0 | ✓ |
| CopilotKit v2 AG-UI event schema stability | Shipped | ✓ |
| Base `@openbox-ai/openbox-sdk-ts@1.0.1` published to npm | **Not yet done** — this package still depends on `file:../openbox-sdk-ts` | Blocks the actual `npm publish` of this package; see `MIGRATION.md`'s release checklist |
| Node.js 24.10.0+ LTS | May 2025 | Assumed stable |

---

## Success Definition (0.4.0 — actual)

- [x] Drop-in adoption: ≤4 lines adopter code (as of 0.2.0)
- [x] Telemetry-default policy retained; enforcement is opt-in and per-boundary
- [x] 4/5 verdicts enforced (allow, block, halt, require_approval); `constrain` explicitly unsupported (not a routing gap — a documented, typed failure)
- [x] Spans synthesized + transport (shipped in 0.3.0, unchanged)
- [x] Multi-agent handoff via the base `handoff()` factory
- [ ] Base `@openbox-ai/openbox-sdk-ts@1.0.1` published + this package's dependency swapped from `file:` to an exact pin, then `npm publish` of `0.4.0` itself (user-owned, see `MIGRATION.md`)
- [ ] Full CONSTRAIN support — no target release yet

---

## Unresolved Questions

1. Should `openbox-middleware.ts` (997 LOC) be split proactively in 0.3.0, or wait until >1200 LOC?
2. Are there real-world workflows with >1000 spans per request that would overflow SpanBuffer? If yes, increase cap?
3. Should approval polling be built-in retries, or delegated entirely to adopter?
4. After 0.5.0 stable, what's the release cadence (monthly, quarterly)?
5. Should CopilotKit v1 support be considered as parallel 0.6.0-v1-compat branch, or post-pone entirely?
