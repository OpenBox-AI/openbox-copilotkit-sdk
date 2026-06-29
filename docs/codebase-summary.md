# Codebase Summary

**Codebase Size**: ~5.5k LOC (TypeScript, src/) | **Build Output**: ESM-only, no bundle  
**Test Coverage Baseline**: branches 50%, functions 70%, lines 60%, statements 60%

## Source Tree Structure

```
src/
├── index.ts                       # Main re-export entry
├── client/                        # HTTP client to OpenBox API
│   └── openbox-client.ts          # OpenBoxClient (683 LOC, >300 candidate)
├── config/                        # Configuration parsing & env vars
│   └── openbox-config.ts          # parseOpenBoxConfig + accessors (321 LOC, >300 candidate)
├── identity/                      # DID validation & Ed25519 signing
│   └── agent-identity.ts          # Header builder, signature generation
├── copilotkit/                    # CopilotKit runtime integration
│   ├── with-openbox-runtime.ts    # Adopter entry point: withOpenBoxRuntime()
│   ├── openbox-middleware.ts      # AG-UI middleware (997 LOC, >300 candidate)
│   ├── openbox-emitter.ts         # Event payload builder (555 LOC, >300 candidate)
│   ├── governance-blocked-error.ts
│   ├── runtime-symbol.ts          # Private Symbol for controller attachment
│   ├── types.ts
│   └── internal/
│       ├── before-request.ts      # Request context setup
│       ├── after-request.ts       # Post-execution signal emission
│       ├── wrap-agent-in-proxy.ts # Per-clone middleware injection
│       └── wrap-copilot-runtime-options.ts (398 LOC, >300 candidate)
├── spans/                         # Span synthesis & buffering
│   ├── span-buffer.ts             # FIFO buffer (cap, TTL, eviction)
│   ├── tool-span-synthesizer.ts   # AG-UI triple → function_call span
│   ├── span-data.ts               # Span attribute types
│   └── semantic-types.ts          # Semantic constants
├── audit/                         # Audit envelope & idempotency
│   ├── audit-envelope.ts          # Attach openbox.* attributes
│   └── idempotency-key.ts         # SHA256 hashing
├── verdict/                       # Verdict mapping & enforcement
│   ├── verdict-mapper.ts          # Wire format → union
│   ├── verdict-applier.ts         # Apply allow/block (others throw)
│   ├── openbox-verdict.ts         # Discriminated union definition
│   └── applier-context.ts         # Verdict context carrier
├── governance/                    # State & execution context
│   ├── approval-registry.ts       # In-memory pending approvals
│   └── context.ts                 # AsyncLocalStorage context
├── types/                         # Shared type definitions
│   ├── errors.ts                  # OpenBoxError + 10 subclasses
│   ├── verdict.ts                 # Verdict enum & helpers
│   ├── governance-verdict-response.ts # Wire format (from API)
│   ├── guardrails.ts              # Guardrail definitions
│   └── workflow-event-type.ts      # AG-UI event type enum
└── verdict/verdict-applier.ts      # VerdictNotImplementedError (exported from ./verdict)
```

## Folder Purposes (One-Paragraph Each)

| Folder | Purpose |
|--------|---------|
| **client** | HTTP client with automatic DID signing, retry logic (2 retries, 150ms base delay), and approval polling. Single export: `OpenBoxClient` class. |
| **config** | Zod-based config schema with 19 env var fallbacks. Global accessors (`getOpenBoxConfig()`, `getOpenBoxApiKey()`). Validates API key format + URL security. |
| **identity** | Ed25519 signing helpers. Validates agent DID pattern (`did:aip:{uuid}`), builds 5-header canonical request, wraps private key in PKCS8 at sign time. |
| **copilotkit** | Core integration layer. `withOpenBoxRuntime()` wraps adopter options; `OpenBoxMiddleware` observes AG-UI events; `OpenBoxCopilotKitEmitter` builds governance payloads. Private Symbol gates controller access. |
| **spans** | Synthesizes `function_call` spans from AG-UI `TOOL_CALL_*` triples. `SpanBuffer` provides bounded FIFO with TTL eviction (300s default) and manual drain. Includes attribute redaction via JSONPath. |
| **audit** | Attaches audit envelope: idempotency key (SHA256 hash), enforcement status, policy version, gateway type. Plugs into span data; enables replay-safe governance. |
| **verdict** | Maps wire `GovernanceVerdictResponse` to 5-case union. `allow`/`block` wired in Phase 1; `constrain`/`require_approval`/`halt` throw `VerdictNotImplementedError` (Phase 3). |
| **governance** | State containers: `ApprovalRegistry` (in-memory HITL pending store) and `AsyncLocalStorage` context (tenant, user, DID headers). |
| **types** | Shared types: error subclasses (10 in types/, 1 more in verdict/), verdict enum, API wire formats, guardrail definitions, workflow event types. No implementation. |

## Public Surface Map

Mirrors `package.json` `exports`:

| Export Path | Exports | Use Case |
|-------------|---------|----------|
| `.` (default) | Everything below | Standard import; re-exports all subpaths |
| `./client` | `OpenBoxClient`, client config types | Direct HTTP calls to OpenBox API |
| `./config` | `parseOpenBoxConfig`, `getOpenBoxConfig`, `getOpenBoxApiKey`, config schema | Initialize SDK config from env vars |
| `./copilotkit` | `withOpenBoxRuntime`, `createOpenBoxMiddleware`, `CopilotKitOptions` | Wrap CopilotKit runtime; attach middleware |
| `./governance` | `ApprovalRegistry`, `getOpenBoxContext`, governance types | Access pending approvals; resolve context |
| `./identity` | `AgentIdentity`, `buildDIDHeaders`, DID validation | Sign requests; validate agent DIDs |
| `./types` | All error classes, verdict enum, wire types | Type-only imports for downstream code |

## Key Files > 300 LOC (Modularization Candidates)

| File | LOC | Status | Notes |
|------|-----|--------|-------|
| `copilotkit/openbox-middleware.ts` | 997 | Candidate | Handles RUN_STARTED/TEXT_MESSAGE/TOOL_CALL_*/RUN_FINISHED event routing; verdict apply; error injection. Could split: event-handler, verdict-applier-executor, tool-call-handler. |
| `client/openbox-client.ts` | 683 | Candidate | HTTP client, retry logic, DID signing, approval polling. Tight coupling OK for single-service client; review if multi-endpoint support added. |
| `copilotkit/openbox-emitter.ts` | 555 | Candidate | Event payload builder for 6+ event types (WORKFLOW_STARTED, SIGNAL_RECEIVED, ActivityStarted, etc.). Could split into event builders if >800 LOC. |
| `copilotkit/internal/wrap-copilot-runtime-options.ts` | 398 | Candidate | Wraps agents, injects before/after middleware, proxies clone. Tight coupling with wrapAgentInProxy. Monitor if recursive agent wrapping added. |
| `config/openbox-config.ts` | 321 | Candidate | Schema + 19 env var fallbacks + accessors. Stay < 400 LOC; split `--help` generation to separate file if config schema grows. |

## Test Layout

**Test Structure**:
```
test/
├── fixtures/
│   ├── agui-streams/           # 4 recorded AG-UI event sequences
│   ├── governance-verdict-responses/  # 18 wire-format samples
│   ├── approvals/              # Approval state fixtures
│   ├── events/                 # Event type samples
│   ├── guardrails/             # Guardrail definitions
│   └── evaluate-payloads-baseline.jsonl  # OTel removal proof
├── unit/                       # ~36 unit tests
│   ├── client.test.ts
│   ├── config.test.ts
│   ├── identity.test.ts
│   ├── copilotkit/
│   │   ├── middleware.test.ts
│   │   ├── emitter.test.ts
│   │   └── runtime.test.ts
│   ├── spans/
│   │   ├── buffer.test.ts
│   │   └── synthesizer.test.ts
│   ├── verdict/
│   │   ├── mapper.test.ts
│   │   └── applier.test.ts
│   └── audit/
│       └── envelope.test.ts
└── integration/
    └── evaluate-snapshot-baseline.test.ts  # OTel removal proof
```

**Coverage Thresholds** (Phase 1 baseline):
- **Lines**: ≥60%
- **Statements**: ≥60%
- **Functions**: ≥70%
- **Branches**: ≥50%

**Integration Test (Lossless Proof)**:
- `evaluate-snapshot-baseline.test.ts` — Records governance evaluation payloads from simulated AG-UI streams; proves that OTel removal (0.2.0) did not lose governance event signals. Snapshot diff validates.

## Configuration & Build

**TypeScript Compiler**:
- Target: ES2023
- Module: ESNext
- Strict: `true` + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `isolatedModules`, `verbatimModuleSyntax`
- Path alias: `@/* → src/*`
- Bundler resolution: `true`

**Build Tool** (tsup):
- ESM-only output
- No bundle, no split
- Target: node24
- Declaration files: `dts: true`
- Source maps: enabled

**Linting & Format**:
- ts-eslint `recommendedTypeChecked`
- Prettier formatting
- Tests: relaxed rules (`no-misused-promises`, `no-unsafe-*` disabled)

**Guard Scripts**:
- `check-no-otel.mjs` — Regex grep: forbid `@opentelemetry/*` in src/
- `check-no-mastra.mjs` — Regex grep: forbid `@mastra/*` in src/

## Dependency Graph

**Runtime Dependencies**:
- `zod` ^4.1.5 — Schema validation (config parsing only)

**Peer Dependencies**:
- `@ag-ui/client` ^0.0.57 — Event types, middleware interface (optional: false)
- `@copilotkit/runtime` ^1.61.0 — Runtime types, event stream (optional: false)

**Dev Dependencies**:
- `typescript`, `eslint`, `prettier`, `vitest`, `tsup`, `@types/node`, `@typescript-eslint/*` — Tooling
- `msw` ^2.11.2 — Mock Service Worker for test isolation

**Explicitly Forbidden**:
- `@opentelemetry/*` (removed 0.2.0; fail-open on governance eval, not tracing)
- `@mastra/*` (co-runs without shared span ownership; SDK owns AG-UI, Mastra owns LLM)

## Lines of Code by Module

| Module | Est. LOC | Notes |
|--------|----------|-------|
| copilotkit | ~2200 | Largest; middleware, emitter, runtime wrappers |
| spans | ~400 | SpanBuffer, synthesizer, data types |
| verdict | ~350 | Mapper, applier, union definition, context |
| client | ~683 | Single OpenBoxClient class |
| config | ~321 | Zod schema + 19 env vars + accessors |
| audit | ~250 | Envelope builder, idempotency key |
| identity | ~200 | DID validation, signature generation |
| governance | ~150 | Approval registry, ALS context |
| types | ~200 | Error classes, enums, wire types |
| **Total** | **~5.5k** | Excludes tests, docs, build artifacts |

## Key Design Patterns

1. **AsyncLocalStorage-based context**: Tenant, user, DID headers stored per-request; accessible in child agents via `getOpenBoxContext()`.
2. **Symbol-gated private state**: `OPENBOX_COPILOTKIT_RUNTIME_SYMBOL` prevents accidental controller access; only internal code can attach/retrieve.
3. **Discriminated union verdicts**: Type-safe verdict representation; exhaustiveness checked at compile time; runtime applier routes via tag.
4. **TTL-evicted bounded buffer**: SpanBuffer evicts expired spans every TTL/2; configurable cap prevents OOM; no manual drain required (automatic).
5. **DID-signed canonical requests**: Deterministic request string (METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256) prevents replay attacks.

## Verdict Implementation Status

Current as of 0.3.0-beta.0:

| Verdict | Implementation | Target Release |
|---------|----------------|-----------------|
| `allow` | ✓ wired | shipped |
| `block` | ✓ wired | shipped |
| `constrain` | throws `VerdictNotImplementedError` | 0.4.0 |
| `halt` | throws `VerdictNotImplementedError` | 0.4.0 |
| `require_approval` | throws `VerdictNotImplementedError` | 0.5.0 |

See [`project-roadmap.md`](./project-roadmap.md) for implementation details and Phase timeline.

## Unresolved Questions

- Are there future use cases for multi-service OpenBox deployment (currently single endpoint)?
- (Middleware LOC split decision moved to `project-roadmap.md` open-decisions section)
