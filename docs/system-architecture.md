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
| **OpenBox base runtime** | `@openbox-ai/openbox-sdk-ts` (`/runtime`, `/client`, `/adapters`, `/approvals`, `/context`) | Owns config resolution, HTTP transport + retries, DID signing, the stock `CoreAdapter` (BLOCK/HALT/REQUIRE_APPROVAL routing), and the per-runtime `ContextStore`. Composed once per controller in `copilotkit/internal/base-runtime-builder.ts`. |
| **`createOpenBoxCopilotKit` / `serverTool()`** | `copilotkit/create-openbox-copilotkit.ts`, `copilotkit/server-tool.ts` | Bundle entry point + pre-execution wrapper: evaluates (and, in `enforce` mode, awaits approval for) a wrapped server tool's call before its real `execute` runs. |
| **Config translator** | `copilotkit/internal/config-translator.ts` (+ `config-alias-env-resolvers.ts`, `config-nested-group-resolvers.ts`) | Resolves `OpenBoxConfigInput` (incl. every deprecated alias, warn-once) into the base SDK's `OpenBoxConfig.resolve()` call. |
| **`OpenBoxClient` facade** *(deprecated, removed at 1.0.0)* | `client/openbox-client.ts` | Thin shim calling `/api/v1/governance/evaluate`/`/approval`/`/auth/validate` directly; delegates DID signing to base. Not used internally by `withOpenBoxRuntime`/`createOpenBoxCopilotKit` — the real path constructs the base SDK's own client. |
| **Verdict types** | base `Verdict` / `EvaluationResult` (re-exported from the package root); `copilotkit/unsupported-verdict-error.ts` | The `src/verdict/*` mapper/applier module is **removed** (`0.4.0` breaking change). CONSTRAIN is caught at the enforcing boundaries and raised as `CopilotKitUnsupportedVerdictError`. |
| **SpanBuffer** | `spans/span-buffer.ts` | Bounded FIFO (1000 spans, 300s TTL); stores synthesized spans |
| **Tool Span Synthesizer** | `spans/tool-span-synthesizer.ts` | TOOL_CALL_* triple → `function_call` span with hashes, duration |
| **Audit Envelope** | `audit/audit-envelope.ts` | Attach idempotency key, enforcement status, policy version |
| **Agent Identity facade** *(deprecated, removed at 1.0.0)* | `identity/agent-identity.ts` | Re-shapes base `@openbox-ai/openbox-sdk-ts/identity` primitives (`AgentIdentity`, `buildCanonicalString`, `HEADER_*`) into this package's historical export names; no second signer. |
| **OpenBox Config facade** *(deprecated, removed at 1.0.0)* | `config/openbox-config.ts` | Thin translator over base `OpenBoxConfig.resolve()`; not used internally by the real runtime path (see config translator above). |
| **Governance Context** | `governance/context.ts` | AsyncLocalStorage per-request context (tenant, user, trace id) |
| **Per-run context store** | `copilotkit/internal/run-context-store.ts` | Controller-owned store (Decision D7) supplying `workflowId`/`runId` to `serverTool()`; distinct from the base per-runtime `ContextStore`. |
| **Interrupt persistence** | `copilotkit/internal/interrupt-store.ts` | Injectable `InterruptPersistencePort`; bundled `InMemoryInterruptStore` is explicitly non-durable. Replaces the removed in-memory `ApprovalRegistry` design — approval waiting now goes through the base SDK's `ApprovalPoller` directly, not a hand-rolled registry. |

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
   │   (controller: OpenBoxRuntimeController — owns the one base OpenBoxRuntime,
   │    the per-run context store, the bounded telemetry queue, server-tool
   │    ownership registry, interrupt store, run-terminal-state registry, and
   │    the child-agent client cache; see api-reference.md#openboxruntimecontroller)
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
  ├─→ Build 5-header DID envelope (if OPENBOX_AGENT_DID set) — delegates
  │   │  canonicalization + signing to @openbox-ai/openbox-sdk-ts/identity
  │   ├─→ X-OpenBox-Agent-DID
  │   ├─→ X-OpenBox-Agent-Timestamp (ISO 8601)
  │   ├─→ X-OpenBox-Agent-Nonce (UUID)
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
  │   ├─→ (enforcement.frontendTools: "enforce" only) evaluateLifecycle(envelope)
  │   │   └─→ Base OpenBoxRuntime: HTTP POST, retries, DID-signed
  │   ├─→ Receive EvaluationResult (base Verdict)
  │   ├─→ Route on verdict:
  │   │   ├─→ ALLOW: pass through
  │   │   ├─→ REQUIRE_APPROVAL: awaits the base ApprovalPoller before proceeding
  │   │   ├─→ BLOCK/HALT: inject RUN_ERROR (governance_blocked), halt observable
  │   │   └─→ CONSTRAIN: raise CopilotKitUnsupportedVerdictError (unsupported — never applied, never a silent allow)
  │   │   (telemetry mode — the default — never awaits this gate; see "Telemetry-Default Policy" below)
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

**Mapped to** (as of `0.4.0`): the base SDK's own `Verdict` enum and `EvaluationResult` type (`@openbox-ai/openbox-sdk-ts`, re-exported from this package's root). The `OpenBoxVerdict` discriminated union + `mapVerdict`/`applyVerdict` shown in earlier revisions of this doc were a parallel, never-wired model (`src/verdict/*`) — that module is **removed** at `0.4.0` (breaking change; see [`MIGRATION.md`](../MIGRATION.md)).

**Verdict enforcement status** (as of `0.4.0`) — enforcement is per-boundary, not a single global applier; see the boundary table below:

| Verdict | Status |
|---------|--------|
| `allow` | pass through |
| `block` | enforced — `serverTool()` throws before `execute`; the frontend gate injects `RUN_ERROR`/`governance_blocked` |
| `halt` | enforced — same as `block` |
| `require_approval` | enforced — `enforce`-mode evaluation awaits the base `ApprovalPoller` (`waitForDecision`) for a real decision before proceeding |
| `constrain` | **unsupported** — raises a typed `CopilotKitUnsupportedVerdictError` at the enforcing boundaries; never applied, never a silent allow. No committed ship date for full support. |

**Enforcement boundaries** (see [`MIGRATION.md`](../MIGRATION.md#boundary-truthfulness--read-this-if-you-rely-on-this-sdk-for-governance) for the full writeup):

| Boundary | Guarantee |
|---|---|
| `bundle.serverTool()`-wrapped server tool, `enforcement.mode: "enforce"` | Pre-execution: a non-allow verdict prevents `execute` from ever running. |
| Explicit frontend tool, `enforcement.frontendTools: "enforce"` (or deprecated `enforceApprovals: true`) | Delivery gate: the `TOOL_CALL_END` event can be blocked before reaching the frontend. Never a server-execution guarantee. |
| Unwrapped server tool / MCP tool / external-agent call | Observation-only. No pre-execution seam exists for a call this SDK never wrapped. |

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

**Purpose**: Prove agent identity to OpenBox API; prevent replay. As of `0.4.0`, canonicalization and Ed25519 signing delegate to `@openbox-ai/openbox-sdk-ts/identity` — this package generates only the nonce/timestamp values, never the crypto.

**Canonical Request String**:
```
METHOD
/api/v1/governance/evaluate
TIMESTAMP (ISO 8601)
NONCE (UUID)
BODY_SHA256 (empty for GET)
```

**Signature**: Ed25519 over canonical string.

**Headers**:
- `X-OpenBox-Agent-DID`: `did:...`
- `X-OpenBox-Agent-Timestamp`: ISO 8601
- `X-OpenBox-Agent-Nonce`: UUID
- `X-OpenBox-Body-SHA256`: SHA256(body)
- `X-OpenBox-Agent-Signature`: Base64(Ed25519 sig)

**Key**: Base64 32-byte seed; wrapped in PKCS8 at sign time (base SDK).

### 3. Telemetry-Default Policy

**Principle**: Record all events; enforcement is opt-in and per-boundary (not one global switch) — see the boundary table above.

**Behavior**:
- **Telemetry** (`enforcement.mode: "telemetry"`, default): every observed/wrapped call is evaluated and recorded; a non-allow verdict is logged, never acted on; `execute` always runs for wrapped server tools.
- **`enforcement.frontendTools: "enforce"`** (or deprecated `enforceApprovals: true`): BLOCK/HALT verdicts halt the AG-UI observable and emit the redacted `governance_blocked` envelope — gates delivery to the frontend only.
- **`enforcement.mode: "enforce"`** (server tools wrapped with `bundle.serverTool()` only): BLOCK/HALT/a non-approved `REQUIRE_APPROVAL`/CONSTRAIN all prevent `execute` from running.
- CONSTRAIN is never applied at any setting — it always raises a typed `CopilotKitUnsupportedVerdictError` at an enforcing boundary.

**Failure Mode**: If the evaluate call fails (network, timeout), the base client's `onApiError` policy decides: `fail_open` (default) logs + allows; `fail_closed` blocks; `fail_closed_destructive` only fails closed for a destructive **span**, so it behaves like `fail_open` for both of this SDK's lifecycle/server-tool gates (see `MIGRATION.md`).

### 4. Multi-Agent Dedup Key

**Problem**: Parent agent emits HANDOFF marker; child agent also calls SDK; could double-emit.

**Solution**: Dedup key = `${sessionId}::${parentDid}::${childName}::${activityId}`

**Check**: Middleware caches recent dedup keys; skip emission if seen in TTL window (5min default).

### 5. Approval Workflow

As of `0.4.0`, approval waiting goes through the base SDK's `ApprovalPoller` directly — the earlier in-memory `ApprovalRegistry` design (poll-and-check-on-next-call) is removed.

**States**:
1. `REQUIRE_APPROVAL` verdict → in `enforce` mode, `evaluateLifecycle` awaits the base `ApprovalPoller.waitForDecision(workflowId, runId, activityId)` — a real wait, not a pass-through.
2. The poller resolves to an approved/rejected/expired/timed-out outcome; a non-approved outcome raises `CopilotKitGovernanceControlError` before `execute` runs.
3. A finite default wait bound (`approvalMaxWaitMs`, default `900_000` ms / 15 min) prevents an unresolved approval from pinning a call forever; explicit `null` opts into an infinite wait.
4. On shutdown, an in-flight approval wait is aborted and rejects fail-safe — it never resolves-and-executes after shutdown has started.

**Important**: Approval state itself lives in OpenBox Core, not this SDK. Interrupt state (a related but distinct concept — see "Interrupt semantics" in `MIGRATION.md`) uses a separate, explicitly injectable `InterruptPersistencePort`; the bundled in-memory default is non-durable across a process restart.

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
| Missing approval after `REQUIRE_APPROVAL` verdict (`enforce` mode) | Awaits the base `ApprovalPoller` up to `approvalMaxWaitMs` (default 15 min); a rejected/expired/timed-out outcome throws before `execute` runs |
| SpanBuffer overflow (>1000 spans) | Evict oldest span; log warning |

### Retry Logic

As of `0.4.0`, this package's own `evaluateMaxRetries`/`evaluateRetryBaseDelayMs` config fields are deprecated and **not reimplemented** — the base SDK's own client transport owns retries now. The numbers below described this package's pre-`0.4.0` retry loop; see `@openbox-ai/openbox-sdk-ts`'s own documentation for its current transport-retry policy.

- **Timeout**: `timeoutSeconds` (default 30s), configurable via the base config.

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
- **InMemoryInterruptStore**: bounded by a per-entry TTL (default 15 min) plus a hard entry-count cap (10,000, FIFO eviction) — non-durable, see `MIGRATION.md`
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
