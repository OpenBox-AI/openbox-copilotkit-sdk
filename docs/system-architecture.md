# System Architecture

**Diagram Date**: 2026-06-29  
**Scope**: CopilotKit SDK (Agent/UI boundary observer) + OpenBox API integration

## High-Level Context

```
┌─────────────────────────────────────────────────────────────────┐
│ Adopter Application (Next.js, Node.js backend)                  │
└─────────────────────────────────────────────────────────────────┘
              │
              ├─→ CopilotKit Runtime v2
              │
              ├─→ OpenBox SDK (this repository)
              │   └─→ withOpenBoxRuntime() wrapper
              │
              └─→ OpenBox API (governance + approval service)
                  └─→ /api/v1/governance/evaluate
                  └─→ /api/v1/governance/approval

User Browser                  Backend
───────────────────────────────────────
  AG-UI (agentic UI)         Agent Runtime + SDK
  ├─ Tool Call UI      ←────→ TOOL_CALL events
  ├─ Messages          ←────→ TEXT_MESSAGE events
  └─ Handoff Pickers   ←────→ HANDOFF signals
```

## Component Architecture

### Core Components

| Component | Module | Responsibility |
|-----------|--------|-----------------|
| **OpenBox Adopter Route** | `demo/mastra/src/app/api/copilotkit/route.ts` | Express/Next.js route handler; calls `withOpenBoxRuntime()` |
| **withOpenBoxRuntime()** | `copilotkit/with-openbox-runtime.ts` | Wraps `CopilotRuntimeOptions`; returns `{ runtime, shutdown }` |
| **Agent Proxy** | `copilotkit/internal/wrap-agent-in-proxy.ts` | Per-clone proxy intercepts `.clone()`; injects middleware |
| **OpenBoxMiddleware** | `copilotkit/openbox-middleware.ts` | AG-UI Middleware; observes TOOL_CALL_*, RUN_*, TEXT_MESSAGE_* events |
| **OpenBoxCopilotKitEmitter** | `copilotkit/openbox-emitter.ts` | Builds governance event payloads; emits ActivityStarted, SIGNAL_RECEIVED, ActivityCompleted, and the sibling `ActivityCompleted` hook event carrying `function_call` spans. |
| **OpenBoxClient** | `client/openbox-client.ts` | HTTP client; calls `/api/v1/governance/evaluate`, handles retries, DID signing |
| **Verdict Processor** | `verdict/verdict-mapper.ts`, `verdict-applier.ts` | Maps wire response → union; applies allow/block |
| **SpanBuffer** | `spans/span-buffer.ts` | Bounded FIFO (1000 spans, 300s TTL); stores synthesized spans |
| **Tool Span Synthesizer** | `spans/tool-span-synthesizer.ts` | TOOL_CALL_* triple → `function_call` span with hashes, duration |
| **Audit Envelope** | `audit/audit-envelope.ts` | Attach idempotency key, enforcement status, policy version |
| **Agent Identity** | `identity/agent-identity.ts` | DID validation, Ed25519 signature generation, header builder |
| **OpenBox Config** | `config/openbox-config.ts` | Parse + validate 19 env vars; provide config accessors |
| **Governance Context** | `governance/context.ts` | AsyncLocalStorage per-request context (tenant, user, DID headers) |
| **Approval Registry** | `governance/approval-registry.ts` | In-memory pending approvals store; poll-based retrieval |

## Request/Response Flow

### Setup Phase (One-Time)

```
1. Adopter calls withOpenBoxRuntime(runtimeOptions, openboxConfig)
   │
   ├─→ wrapCopilotRuntimeOptions()
   │   ├─→ Compose before/after middleware
   │   ├─→ Wrap agents (record/Promise/factory) via wrapAgentInProxy()
   │   └─→ Each agent clone gets OpenBoxMiddleware attached
   │
   ├─→ Create CopilotRuntime with wrapped options
   │
   ├─→ Attach controller to runtime via OPENBOX_COPILOTKIT_RUNTIME_SYMBOL
   │   (controller = { config, client, evaluator })
   │
   └─→ Return { runtime, shutdown } to adopter
```

### Per-Request Flow

#### Phase 1: Before-Request Setup

```
openBoxBeforeRequest(request)
  │
  ├─→ Resolve tenant (callback or header)
  ├─→ Resolve user (callback or header)
  ├─→ Open AsyncLocalStorage context
  │   └─→ Store: tenant, user, requestId
  │
  ├─→ Build 5-header DID envelope (if OPENBOX_AGENT_DID set)
  │   ├─→ X-OpenBox-Agent-DID
  │   ├─→ X-OpenBox-Timestamp (ISO 8601)
  │   ├─→ X-OpenBox-Nonce (16-byte random, hex)
  │   ├─→ X-OpenBox-Body-SHA256 (empty for GET)
  │   └─→ X-OpenBox-Agent-Signature (Ed25519)
  │
  ├─→ Store context in ALS for access in middleware
  │
  └─→ Return modified request with DID headers
```

#### Phase 2: AG-UI Event Stream Processing

```
OpenBoxMiddleware.run(input, next)
  │
  ├─→ Event: RUN_STARTED
  │   └─→ Emit WORKFLOW_STARTED + SIGNAL_RECEIVED("user_input")
  │
  ├─→ Event: TEXT_MESSAGE_* (text from assistant/user)
  │   └─→ Buffer into message history (for context in tool calls)
  │
  ├─→ Event: TOOL_CALL_START
  │   ├─→ Create ToolCallTriple buffer
  │   └─→ Store: tool name, args placeholder
  │
  ├─→ Event: TOOL_CALL_ARGS
  │   └─→ Append args JSON to triple
  │
  ├─→ Event: TOOL_CALL_RESULT / TOOL_CALL_ERROR
  │   ├─→ Complete ToolCallTriple
  │   ├─→ Call client.evaluate(payload)
  │   │   └─→ Governance evaluation (HTTP POST, retries, DID-signed)
  │   ├─→ Receive GovernanceVerdictResponse
  │   ├─→ Map verdict to OpenBoxVerdict union
  │   ├─→ Apply verdict:
  │   │   ├─→ ALLOW: pass through
  │   │   ├─→ BLOCK: inject RUN_ERROR, halt observable
  │   │   └─→ CONSTRAIN/REQUIRE_APPROVAL/HALT: throw VerdictNotImplementedError (Phase 3)
  │   └─→ [Optional] Synthesize function_call span → SpanBuffer.append()
  │
  ├─→ Event: RUN_FINISHED / RUN_ERROR
  │   ├─→ Emit WORKFLOW_COMPLETED / WORKFLOW_FAILED
  │   └─→ Trigger SpanBuffer.drain() if configured
  │
  └─→ Observable continues or halts (verdict-dependent)
```

#### Phase 3: After-Request Finalization

```
openBoxAfterRequest(request, response)
  │
  ├─→ Extract final assistant message from response
  │
  ├─→ Emit SIGNAL_RECEIVED("assistant_message")
  │
  ├─→ Call optional outputGuardrail(message, context)
  │   └─→ Observation-only; cannot rewrite stream
  │
  └─→ Return response to adopter
```

## Data Shapes

### ToolCallTriple → function_call Span

**Input** (from AG-UI events):
```ts
{
  toolName: "search_web",
  args: { query: "OpenBox governance" },
  result: { status: 200, content: "..." },
  startTime: 1234567890000,
  endTime: 1234567895000
}
```

**Output** (function_call span):
```ts
{
  openbox: {
    semantic_type: "function_call",
    idempotency_key: "sha256(workflowId:runId:activityId:attempt)",
    enforcement_owner: "openbox-copilotkit",
    gateway: "agui_event",
    enforcement_status: "pre_execution_allowed" | "pre_execution_blocked" | ...,
    policy_version: "operator-defined-string",
    trace_id: "optional-correlationId"
  },
  tool: {
    call_id: "tool-123",
    name: "search_web",
    duration_ms: 5000,
    args_hash: "sha256(JSON.stringify(args))",
    args_preview: "{ query: \"OpenBox...\" }" // ≤256 B, redacted
  },
  result: {
    hash: "sha256(JSON.stringify(result))",
    preview: "{ status: 200, ...}" // ≤256 B, redacted
  }
}
```

### Governance Evaluation Payload

**Input** to `client.evaluate(payload)`:
```ts
{
  workflowId: "wf-uuid",
  runId: "run-uuid",
  agentDid: "did:aip:uuid",
  agentName: "multi_agent_research",
  toolName: "search_web",
  toolArgs: { /* redacted by JSONPath */ },
  toolResult: { /* redacted by JSONPath */ },
  context: {
    sessionId: "session-uuid",
    userId: "user-id",
    tenantId: "tenant-id"
  },
  activityType: "TOOL_CALL",
  previousSignals: [ /* prior SIGNAL_RECEIVED events */ ]
}
```

### GovernanceVerdictResponse

**Wire format** from `/api/v1/governance/evaluate`:
```ts
{
  verdict: "allow" | "block" | "constrain" | "require_approval" | "halt",
  correlationId: "verdict-uuid",
  reason: "Tool is in blocklist",
  constraints: { /* if verdict: constrain */ },
  approvalId: "approval-uuid", // if verdict: require_approval
  policyVersion: "operator-defined-string" // Opaque; not parsed by SDK
}
```

**Mapped to** (OpenBoxVerdict discriminated union):
```ts
type OpenBoxVerdict =
  | { tag: "allow"; correlationId: string }
  | { tag: "block"; reason: string; correlationId: string }
  | { tag: "constrain"; constraints: object; correlationId: string }
  | { tag: "require_approval"; approvalId: string; correlationId: string }
  | { tag: "halt"; reason: string; correlationId: string };
```

**Verdict Implementation Status** (as of 0.3.0-beta.0):

| Verdict | Status | Target |
|---------|--------|--------|
| `allow` | ✓ wired | shipped |
| `block` | ✓ wired | shipped |
| `constrain` | audits + throws `VerdictNotImplementedError` | 0.4.0 |
| `halt` | audits + throws `VerdictNotImplementedError` | 0.4.0 |
| `require_approval` | audits + throws `VerdictNotImplementedError` | 0.5.0 |

## Cross-Cutting Concerns

### 1. AsyncLocalStorage Execution Context

**Purpose**: Pass tenant, user, DID headers through nested agent calls without explicit parameter threading.

**Setup**:
```ts
// In openBoxBeforeRequest()
const context = new AsyncLocalStorage();
context.run({ tenant, user, didHeaders }, () => {
  // Handler runs with context bound
});
```

**Access**:
```ts
// In child agents, middleware, etc.
const ctx = getOpenBoxContext();
// ctx.tenant, ctx.user, ctx.didHeaders available
```

**Scope**: Request-local; cleaned up after response.

### 2. DID-Signed HTTP Envelope

**Purpose**: Prove agent identity to OpenBox API; prevent replay.

**Canonical Request String**:
```
METHOD
/api/v1/governance/evaluate
TIMESTAMP (ISO 8601)
NONCE (16-byte random, hex)
BODY_SHA256 (empty for GET)
```

**Signature**: Ed25519 over canonical string.

**Headers**:
- `X-OpenBox-Agent-DID`: `did:aip:{uuid}`
- `X-OpenBox-Timestamp`: ISO 8601
- `X-OpenBox-Nonce`: Random hex
- `X-OpenBox-Body-SHA256`: SHA256(body)
- `X-OpenBox-Agent-Signature`: Base64(Ed25519 sig)

**Key**: Base64 32-byte seed; wrapped in PKCS8 at sign time.

### 3. Telemetry-Default Policy

**Principle**: Record all events; block nothing by default.

**Behavior**:
- **Default** (`enforceApprovals: false`): Emit governance payloads; apply verdicts as observation only; log approved/blocked actions but don't halt.
- **Enforced** (`enforceApprovals: true`): Apply block/constrain verdicts; halt observable on block; emit approval request on `require_approval`.

**Failure Mode**: If evaluate call fails (network, timeout), log error + allow (fail-open); never block user due to SDK error.

### 4. Multi-Agent Dedup Key

**Problem**: Parent agent emits HANDOFF marker; child agent also calls SDK; could double-emit.

**Solution**: Dedup key = `${sessionId}::${parentDid}::${childName}::${activityId}`

**Check**: Middleware caches recent dedup keys; skip emission if seen in TTL window (5min default).

### 5. Approval Workflow

**States**:
1. `require_approval` verdict → emit approval request with ID
2. Add approval to `ApprovalRegistry` (in-memory, not persisted)
3. Adopter polls `client.pollApproval(approvalId)` periodically
4. Return approval state: `pending | approved | rejected | expired`
5. Middleware checks registry on next tool call; unblock if approved

**Important**: Approval state persists only in-memory for the duration of the workflow. On SDK restart, pending approvals are lost. Approval persistence is deferred to a future release.

## Observability Architecture

### OpenTelemetry Removal (0.2.0+)

**Design Decision**: OpenTelemetry removed in 0.2.0. SDK emits governance events independently (no dependency on global `TracerProvider`). Each adopter owns their tracing setup; SDK complements rather than competes.

**Rationale**: Decouples SDK from tracing infrastructure; adopter freedom to use `@opentelemetry/*`, Datadog, Honeycomb, or custom tracer without SDK conflicts.

---

## Co-Run Boundary: SDK + Mastra SDK

**Goal**: Two SDKs, single governance pipeline, no span duplication.

**Ownership**:
- **OpenBox CopilotKit SDK**: Owns AG-UI `function_call` span at `TOOL_CALL_*` events
- **OpenBox Mastra SDK**: Owns `llm_completion` span at Vercel AI `LanguageModelV1` call boundary

**Integration**:
1. CopilotKit SDK observes tool calls; synthesizes span.
2. Mastra SDK observes LLM calls (different boundary); synthesizes span.
3. Both ship spans independently to OpenBox API.
4. OpenBox API deduplicates via idempotency key (SHA256 hash of workflow context).

**No shared imports**: Each SDK is standalone; no `@openbox-ai/openbox-mastra-sdk` imports in CopilotKit SDK (enforced by CI `check-no-mastra.mjs`).

## Configuration & Environment

### 19 Environment Variables

| Variable | Type | Default | Example |
|----------|------|---------|---------|
| **OPENBOX_URL** | string | required | `https://api.openbox.ai` |
| **OPENBOX_API_KEY** | string | required | `obx_live_abc123xyz` |
| **OPENBOX_AGENT_DID** | string | optional | `did:aip:550e8400-e29b-41d4-a716-446655440000` |
| **OPENBOX_AGENT_PRIVATE_KEY** | base64 | optional (req if DID set) | base64 32-byte Ed25519 seed |
| **EVALUATE_MAX_RETRIES** | number | 2 | Request retry count |
| **EVALUATE_RETRY_BASE_DELAY_MS** | number | 150 | Exponential backoff base |
| **GOVERNANCE_TIMEOUT** | number | 30 | Evaluate call timeout (seconds) |
| **GOVERNANCE_POLICY** | `fail_open` \| `fail_closed` | `fail_open` | Error behavior |
| **MAX_EVALUATE_PAYLOAD_BYTES** | number | 256000 | Max request size |
| **HITL_ENABLED** | boolean | true | Enable approval workflow |
| **HTTP_CAPTURE** | boolean | true | Capture HTTP traffic (debug) |
| **INSTRUMENT_DATABASES** | boolean | true | Log DB queries (debug) |
| **INSTRUMENT_FILE_IO** | boolean | false | Log file ops (debug) |
| **SEND_ACTIVITY_START_EVENT** | boolean | true | Emit ActivityStarted |
| **SEND_START_EVENT** | boolean | true | Emit WORKFLOW_STARTED |
| **VALIDATE** | boolean | true | Validate payloads (zod) |
| **SKIP_ACTIVITY_TYPES** | CSV | `` | Skip span types (e.g., `"DB_QUERY,FILE_READ"`) |
| **SKIP_HITL_ACTIVITY_TYPES** | CSV | `` | Skip approval for types |
| **SKIP_SIGNALS** | CSV | `` | Skip signals |
| **SKIP_WORKFLOW_TYPES** | CSV | `` | Skip workflows |
| **OPENBOX_SPAN_BUFFER_MAX_PER_WORKFLOW** | number | 1000 | Max spans buffered |
| **OPENBOX_SPAN_BUFFER_TTL_MS** | number | 300000 | Span TTL (5 min) |
| **OPENBOX_DISABLE_SPAN_BUFFER** | boolean | false | Emergency bypass |
| **OPENBOX_DEBUG** | boolean | false | Enable debug logging |

## Error Handling & Resilience

### Failure Modes

| Scenario | Behavior |
|----------|----------|
| Missing `OPENBOX_URL` | Throw `OpenBoxConfigError` at startup |
| Invalid `OPENBOX_API_KEY` format | Throw `OpenBoxAuthError` at startup |
| DID validation failure | Throw `OpenBoxAuthError`; block request |
| Evaluate call timeout (>30s) | Retry up to 2x; on all retries fail, log + allow (fail-open) |
| Network error during evaluate | Retry with backoff; on final failure, log + allow |
| Malformed `GovernanceVerdictResponse` | Log error; treat as ALLOW (safe default) |
| Missing approval after `require_approval` verdict | Keep tool blocked until approval resolved or expires (1h TTL) |
| SpanBuffer overflow (>1000 spans) | Evict oldest span; log warning |

### Retry Logic

- **Max retries**: 2
- **Base delay**: 150ms
- **Strategy**: Exponential backoff with jitter
- **Timeout**: 30s total (per request, including all retries)

## Performance & Memory

### Latency Targets

| Operation | Target | Context |
|-----------|--------|---------|
| Middleware latency (per event) | <10ms | Governance observation only |
| Evaluate call (P50) | <50ms | HTTP + retry budget |
| SpanBuffer append | <1ms | In-memory FIFO |
| Audit envelope attach | <1ms | Attribute merging |

### Memory Bounds

- **SpanBuffer**: 1000 spans max; ~1MB per workflow
- **ApprovalRegistry**: In-memory; TTL eviction; <100 approvals typical
- **AsyncLocalStorage context**: <1KB per request
- **Total per request**: <2MB (hard limit; no unbounded growth)

## Observability Hooks

### Provided Observability

- **Governance payloads**: Emitted via `ActivityStarted` event (adopter observes)
- **Span buffer events**: Manual `drain()` call (adopter controls)
- **Debug logging**: Gated by `OPENBOX_DEBUG` env var
- **Error correlation**: Governance blocks include correlation ID

### Adopter Responsibilities

- **Structured logging**: Own logger setup (SDK logs to console if `OPENBOX_DEBUG=1`)
- **Metrics**: Adopter captures evaluate latency, verdict distribution, approval rates
- **Tracing**: Adopter owns TracerProvider setup; SDK emits no spans to global provider

## Modularization Candidates (Future)

| Module | Current LOC | Next Review | Reason |
|--------|------------|-------------|--------|
| `openbox-middleware.ts` | 997 | >1200 LOC | Event handler complexity; could split: event-router, verdict-executor, error-injector |
| `openbox-client.ts` | 683 | >800 LOC | HTTP client tight; consider multi-endpoint support if added |
| `openbox-emitter.ts` | 555 | >700 LOC | Event builders; monitor if >6 event types needed |

## References

- [Code Standards](./code-standards.md) — Naming, imports, error handling
- [Project Overview](./project-overview-pdr.md) — Requirements, scope, success criteria
- [API Reference](./api-reference.md) — Public API signatures (adopter-facing)
- [Installation & Integration](./integration-patterns.md) — Setup, wiring, manual patterns
