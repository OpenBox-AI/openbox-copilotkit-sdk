# API Reference

`@openbox-ai/openbox-copilotkit` exports a small, deliberate public surface. Three framework entry points are what most adopters touch (`withOpenBoxRuntime`, `createOpenBoxMiddleware`, `createOpenBoxCopilotKit`); a handful of shared exports are available for advanced wiring (Pattern 2 in [integration-patterns.md](./integration-patterns.md)). `@openbox-ai/openbox-sdk-ts` (the base SDK) is a direct dependency and owns config resolution, HTTP transport, DID signing, and verdict/guardrail types — this package's own `./client`/`./config`/`./identity`/`./types` subpaths are deprecated, base-delegating shims kept for one release (see [`MIGRATION.md`](../MIGRATION.md)).

## Framework exports

### `withOpenBoxRuntime(options, config?)`

The canonical adopter entry point. Wraps `CopilotRuntimeOptions` with OpenBox governance + telemetry and constructs the runtime in one call.

**Signature**

```ts
function withOpenBoxRuntime(
  options: CopilotRuntimeOptions,
  config?: WithOpenBoxRuntimeConfig
): Promise<{ runtime: CopilotRuntime; shutdown: () => Promise<void> }>;

interface WithOpenBoxRuntimeConfig extends OpenBoxConfigInput {
  defaults?: OpenBoxRuntimeDefaults;
  logger?: OpenBoxLogger;
  middlewareOptions?: OpenBoxMiddlewareOptions;
}
```

**Parameters**

- `options` — the same `CopilotRuntimeOptions` you would pass to `new CopilotRuntime(...)`. Passing a constructed `CopilotRuntime` throws `TypeError`.
- `config.middlewareOptions` — forwarded to `createOpenBoxMiddleware` per-request. See `OpenBoxMiddlewareOptions` below.
- `config.defaults` — fallback `{ agentId?, tenantId?, workflowType? }` consulted when the request-scoped AsyncLocalStorage context is absent.
- `config.logger` — `console`-style sink. Optional; defaults to `console`.
- `config` also accepts every `OpenBoxConfigInput` field (`apiKey`, `apiUrl`, `agentDid`, `agentPrivateKey`, `onApiError`, …). Missing keys fall back to env vars (`OPENBOX_*`).

**Returns**

```ts
{ runtime: CopilotRuntime, shutdown: () => Promise<void> }
```

`shutdown` is **idempotent** — concurrent and repeat calls reuse the first invocation's promise. It resolves to an inner `Promise.resolve()` (reserved for future client-side cleanup; `OpenBoxClient` has no shutdown method today) and clears the runtime-attached controller via the private `OPENBOX_COPILOTKIT_RUNTIME_SYMBOL`.

**Example**

```ts
const { runtime, shutdown } = await withOpenBoxRuntime(
  { agents },
  { middlewareOptions: { frontendToolNames: ["setThemeColor"], enforceApprovals: true } }
);
process.on("SIGINT", async () => { await shutdown(); process.exit(0); });
```

**Edge cases**

- **Promise-shape `agents`** is eagerly resolved at wrap time — no concurrent-first-request race.
- **`(ctx) => agents` factory shape** is wrapped at request time; each invocation yields freshly-proxied agents (no cross-request talk).
- **Re-invocation in the same process** is safe — each call produces an independent controller + runtime. There is no global state to coordinate as of 0.2.0-beta.0.

---

### `createOpenBoxMiddleware(runtime, opts?)`

Returns an AG-UI `Middleware` that observes every event in the agent run stream and emits OpenBox governance events.

**Signature**

```ts
function createOpenBoxMiddleware(
  runtime: OpenBoxRuntimeController,
  opts?: OpenBoxMiddlewareOptions
): Middleware;

interface OpenBoxMiddlewareOptions {
  /** @deprecated Use `enforcement`. `true` behaves like `enforcement: { frontendTools: "enforce" }` ONLY — never server-tool enforcement. */
  enforceApprovals?: boolean;
  /** Explicit enforcement model — see `OpenBoxEnforcementOptions` below. Default `{ mode: "telemetry" }`. */
  enforcement?: OpenBoxEnforcementOptions;
  frontendToolNames?: string[];
  isFrontendTool?: (call: { name: string }) => boolean;
  multiAgent?: OpenBoxMultiAgentOptions;
  onEvent?: (emission: OpenBoxEmission) => void;
  redactPaths?: string[];
  spanBuffer?: SpanBuffer;
  telemetry?: TelemetryQueueOptions;
  instrumentation?: OpenBoxInstrumentationOptions;
}

interface OpenBoxEnforcementOptions {
  /** Governs `bundle.serverTool()`-wrapped server tools. Default `"telemetry"` (never gates `execute`). */
  mode?: "telemetry" | "enforce";
  /** Governs the frontend AG-UI `TOOL_CALL_END` delivery gate. Default: follows `mode`. */
  frontendTools?: "observe" | "enforce";
  /** Always `"observe"` — an unwrapped server tool has no pre-execution seam this SDK can hook. */
  unwrappedServerTools?: "observe";
  approvalPollIntervalMs?: number;
  /** Bounds an in-flight HITL approval wait; `null` opts into an infinite wait. Default `900_000` (15 min). */
  approvalMaxWaitMs?: number | null;
}
```

**Parameters**

- `runtime` — an `OpenBoxRuntimeController`. Pattern 1 and `createOpenBoxCopilotKit` build this for you; see [`OpenBoxRuntimeController`](#openboxruntimecontroller) below for the real shape (it is richer than early `0.2.x`/`0.3.x` releases — do not hand-construct it from scratch).
- `opts.enforcement` — the explicit enforcement model (replaces `enforceApprovals`). `mode: "enforce"` only affects tools wrapped with `bundle.serverTool()` (see [`createOpenBoxCopilotKit`](#createopenboxcopilotkitoptions) below) — it has no effect on tools this middleware merely observes. `frontendTools: "enforce"` gates the AG-UI `TOOL_CALL_END` delivery to the frontend; it does **not** gate server-side execution. See [Boundary truthfulness](../MIGRATION.md#boundary-truthfulness--read-this-if-you-rely-on-this-sdk-for-governance) in `MIGRATION.md` for the full three-boundary breakdown.
- `opts.enforceApprovals` — **deprecated**, default `false`. `true` behaves like `enforcement: { frontendTools: "enforce" }` only, plus a one-time warning that server tools are not covered. When both are set, `enforcement.frontendTools` wins.
- `opts.frontendToolNames` — explicit allowlist of tool names that should record `frontend: true`. Without this (or `isFrontendTool`), every observed tool call records `frontend: false`, `tool_origin: "copilotkit-observed"` — safe default for backend-routed tools.
- `opts.isFrontendTool` — alternative callback form. Wins over `frontendToolNames` if both are set.
- `opts.onEvent` — fired for every emission with `{ activityId?, eventType, payload, workflowId }`. Optional sink for sidecar telemetry pipelines.
- `opts.multiAgent` — opt into multi-agent grouping. Default disabled. When `enabled`, every event carries a shared `multi_agent_session_id` (default `mas:${runId}`), timeline signals switch to backend-compatible array shape, and a configured delegation tool emits a `Handoff` (`WorkflowEventType.HANDOFF`) marking the parent → child edge. `forwardContext(ctx)` bridges the grouping context to the child runtime. See [Multi-agent delegation](./integration-patterns.md#multi-agent-delegation-handoff) for the identity model, `handoffTools` / `resolveHandoff` / `forwardContext`, and parent-side vs context-export emission.

#### AG-UI event → OpenBox emission

| AG-UI event | OpenBox emission |
|---|---|
| `RUN_STARTED` | `WorkflowStarted` + `SignalReceived(user_input)` |
| `TOOL_CALL_START` | starts an in-memory tool-call buffer |
| `TOOL_CALL_ARGS` | buffered (delta accumulated for `ActivityStarted.activity_input` and `ActivityCompleted.activity_input`) |
| `TOOL_CALL_END` | emits `ActivityStarted` with parsed `activity_input`; completion remains pending for a result event |
| `TOOL_CALL_RESULT` | emits `ActivityCompleted` with `activity_output` when the stream exposes a tool result |
| `TEXT_MESSAGE_START` / `_CONTENT` / `_END` | buffered into `state.outputText` |
| `RUN_FINISHED` | flushes any pending tool completions, then emits `SignalReceived(agent_output)` + `WorkflowCompleted` |
| `RUN_ERROR` | `WorkflowFailed` |
| upstream observable error | `WorkflowFailed` then `subscriber.error(err)` |

Every tool-call emission carries `tool_origin: "copilotkit-observed"` so downstream pipelines can distinguish CopilotKit-boundary observations from backend-side emissions (e.g. when `openbox-mastra-sdk` is also wired).

When `multiAgent.enabled` and the `TOOL_CALL_END` tool maps to a configured subagent, the middleware emits one `Handoff` immediately after that tool's `ActivityStarted` (deduplicated per delegation). See [Multi-agent delegation](./integration-patterns.md#multi-agent-delegation-handoff).

#### The frontend delivery gate and the `governance_blocked` envelope

When `enforcement.frontendTools: "enforce"` (or the deprecated `enforceApprovals: true`) is set and a tool call's verdict resolves to BLOCK or HALT, the middleware emits a fixed-shape AG-UI `RUN_ERROR` event into the observable and `complete`s the stream:

```json
{
  "type": "RUN_ERROR",
  "code": "governance_blocked",
  "correlationId": "<governanceEventId or approvalId>"
}
```

Tool name, tenant id, agent id, and verdict reason **never** appear in this envelope. The `correlationId` resolves to the unredacted record via the OpenBox UI.

This envelope is the **only** wire-format this gate produces — adding fields here is a public-surface change (the `governance-blocked-redaction.test.ts` test asserts byte-for-byte equality).

**This gate prevents the `TOOL_CALL_*` event from being delivered to the frontend. It never prevents a server-side tool from executing** — the middleware only observes the AG-UI stream, it does not stand between a server-side `execute` and the side effect it performs. If you need that guarantee, wrap the tool with `bundle.serverTool()` (below) instead of, or in addition to, this gate.

CONSTRAIN is **not** enforceable at this gate (or anywhere else in `0.4.0`): the base runtime returns a CONSTRAIN verdict normally, so the gate explicitly detects it and raises the same `governance_blocked` envelope via a typed `CopilotKitUnsupportedVerdictError` rather than silently letting the call proceed.

---

### `createOpenBoxCopilotKit(options)`

Bundle entry point for governed server tools — the one boundary in this SDK that can prevent a server-side tool's `execute` from ever running.

**Signature**

```ts
function createOpenBoxCopilotKit(
  options?: CreateOpenBoxCopilotKitOptions
): Promise<OpenBoxCopilotKitBundle>;

interface CreateOpenBoxCopilotKitOptions extends OpenBoxConfigInput {
  approvalMaxWaitMs?: number | null;
  enforcement?: OpenBoxEnforcementOptions;
  logger?: OpenBoxLogger;
  validateApiKeyAtStartup?: boolean;
}

interface OpenBoxCopilotKitBundle {
  openboxRuntime: OpenBoxRuntime;      // the base runtime this bundle owns
  serverTool: <T>(tool: T) => T;
  shutdown: () => Promise<void>;
  withRuntime: (
    options: CopilotRuntimeOptions,
    config?: WithOpenBoxRuntimeConfig
  ) => Promise<WithOpenBoxRuntimeResult>;
}
```

**`bundle.serverTool(tool)`**

Wraps a server-side tool (e.g. a `@copilotkit/runtime/v2` `ToolDefinition`) so OpenBox evaluates the call — and, in `enforce` mode, awaits approval for it — **before** the tool's real `execute` runs:

- `enforcement.mode: "enforce"` — BLOCK, HALT, a rejected/expired/timed-out `REQUIRE_APPROVAL`, or CONSTRAIN all prevent `execute` from ever running; the wrapper throws `CopilotKitGovernanceControlError` (or `CopilotKitServerToolCorrelationError` when the per-run correlation `enforce` mode needs is missing — this is a fail-safe, not a silent downgrade to observation).
- `enforcement.mode: "telemetry"` (default) — `execute` always runs; ActivityStarted/Completed telemetry records best-effort, with a synthetic id marked `generated` when no per-run correlation is available.
- An approved call's `execute` runs **exactly once**.
- `bundle.withRuntime(options, config?)` attaches this bundle's config to a CopilotKit runtime the same way `withOpenBoxRuntime` does; it builds its own separate controller (mirroring `shutdown`'s independence), so compose the AG-UI middleware against this bundle's own controller (`createOpenBoxMiddleware`) when you need `serverTool()`'s run correlation to come from the SAME controller that is observing the run.

---

## Shared OpenBox exports

These exports are documented inline so adopters can wire this SDK without needing any other package documentation.

### `parseOpenBoxConfig(input?, env?)` (deprecated)

> **Deprecated**, removed at `1.0.0`. `withOpenBoxRuntime`/`createOpenBoxCopilotKit` do **not** use this function internally as of `0.4.0` — the real runtime path resolves config through the base SDK's `OpenBoxConfig.resolve()` plus this package's own alias/deprecation translator (see [`MIGRATION.md`](../MIGRATION.md)'s config-alias table). This facade is kept only for callers who imported it directly in `0.2.x`/`0.3.x`.

Reads `OpenBoxConfigInput` overrides + `OPENBOX_*` env vars into a fully-resolved `OpenBoxConfig`.

```ts
function parseOpenBoxConfig(
  input?: OpenBoxConfigInput,
  env?: NodeJS.ProcessEnv  // defaults to process.env
): OpenBoxConfig;
```

- Throws `OpenBoxConfigError` if `OPENBOX_API_KEY` and `OPENBOX_URL` cannot both be resolved.
- Throws `OpenBoxAuthError` if the API key doesn't match `/^obx_(live|test)_[a-zA-Z0-9_]+$/`.
- Throws `OpenBoxInsecureURLError` if `apiUrl` is HTTP and non-localhost.
- Resolves `agentDid` + `agentPrivateKey` together (both or neither — partial config throws).

```ts
const cfg = parseOpenBoxConfig({ onApiError: "fail_closed" });
// cfg.apiKey, cfg.apiUrl, cfg.skipActivityTypes, …
```

---

### `OpenBoxClient` (deprecated facade)

> **Deprecated**, removed at `1.0.0`. This is this package's own thin, base-delegating facade (`src/client/openbox-client.ts`) — DID validation, key-loading, canonicalization, and Ed25519 signing all delegate to `@openbox-ai/openbox-sdk-ts/identity`; there is no second signer. As of `0.4.0`, `withOpenBoxRuntime`/`createOpenBoxCopilotKit` construct and use the **base SDK's own** `OpenBoxClient` (`@openbox-ai/openbox-sdk-ts/client`) internally instead of this facade — its constructor is positional (`new OpenBoxClient(apiUrl, apiKey, options)`), not the object shape below. This facade's object-shape constructor is preserved only for callers who imported it directly in `0.2.x`/`0.3.x`.

HTTP client for the OpenBox Core API. Built per-process; reused across requests by `withOpenBoxRuntime`.

**Constructor**

```ts
new OpenBoxClient({
  apiKey: string;
  apiUrl: string;
  agentDid?: string;
  agentPrivateKey?: string;
  evaluateMaxRetries?: number;          // constructor default 0
  evaluateRetryBaseDelayMs?: number;    // default 150
  fetch?: typeof fetch;                 // for testing
  onApiError?: "fail_open" | "fail_closed";  // default "fail_open"
  timeoutSeconds?: number;              // default 30
});
```

**Public methods**

- `validateApiKey(): Promise<void>` — calls `GET /api/v1/auth/validate`; throws `OpenBoxAuthError` on 401/403, `OpenBoxNetworkError` otherwise.
- `evaluate(payload): Promise<GovernanceVerdictResponse | null>` — submits a governance payload; honors `onApiError` (fail-open returns `null`, fail-closed throws).
- `pollApproval({ activityId, runId, workflowId }): Promise<ApprovalPollResponse | null>` — polls for an HITL approval verdict.

When `agentDid` + `agentPrivateKey` are set, every request signs with five DID identity headers (see [identity headers](#did-signing-and-identity-headers) below).

> **Note on retries:** the bare `new OpenBoxClient(...)` constructor defaults `evaluateMaxRetries` to `0`. Pattern 1 (`withOpenBoxRuntime`) builds the client via `parseOpenBoxConfig`, which Zod-defaults `evaluateMaxRetries` to `2` (override with `OPENBOX_EVALUATE_MAX_RETRIES` or the `evaluateMaxRetries` config field). Most adopters should rely on the Pattern 1 effective default; the lower constructor default exists for testing convenience.

---

## Public types

### `OpenBoxConfig` / `OpenBoxConfigInput`

`OpenBoxConfigInput` is the partial form `parseOpenBoxConfig` accepts (everything optional; missing keys read from env). `OpenBoxConfig` is the fully-resolved shape returned. Key fields:

- `apiKey: string` — `obx_live_*` or `obx_test_*`.
- `apiUrl: string` — must be HTTPS for non-localhost hosts.
- `agentDid` / `agentPrivateKey` — both or neither, enables DID signing.
- `onApiError: "fail_open" | "fail_closed"` — default `fail_open` (governance failure does not block the user).
- `governanceTimeout: number` (seconds), `evaluateMaxRetries`, `evaluateRetryBaseDelayMs` — wire-level tuning.
- `skipActivityTypes`, `skipSignals`, `skipWorkflowTypes`, `skipHitlActivityTypes: Set<string>` — coarse filters; merged from `OPENBOX_SKIP_*` env vars (CSV).
- `httpCapture: boolean` — **deprecated, inert**, removed at `1.0.0`. Use `instrumentation: { enabled: true }` instead (HTTP instrumentation defaults on once instrumentation is enabled).

The remaining `OpenBoxConfigInput` fields — `hitlEnabled` (deprecated → `hitl.enabled`), `maxEvaluatePayloadBytes` (deprecated → `telemetry.maxPayloadBytes`), `sendActivityStartEvent`/`sendStartEvent` (deprecated → `gate.sendActivityStartEvent`/`gate.sendStartEvent`), `validate` (default `true`; format/shape validation only — never a network call) — every deprecated field keeps working and warns once per field name, per process. See [`MIGRATION.md`](../MIGRATION.md)'s config-alias table for the full deprecated → base-SDK mapping, and note that `withOpenBoxRuntime`/`createOpenBoxCopilotKit` resolve config through `src/copilotkit/internal/config-translator.ts`, not this deprecated type's own schema.

New in `0.4.0` (not part of the deprecated `OpenBoxConfigInput` shape above): `enforcement` (`OpenBoxEnforcementOptions`), `instrumentation` (`{ enabled, databases?, strict? }`, off by default), `validateApiKeyAtStartup` (boolean, default `false` — the only opt-in path that performs a network call at setup time), and `telemetry` (bounded-queue options: `maxPendingEvents`, `maxConcurrentSends`, `flushTimeoutMs`, `overflowPolicy`, `maxPayloadBytes`).

---

### `OpenBoxRuntimeController`

Wire-level dependencies attached to an OpenBox-wrapped `CopilotRuntime` via the private `OPENBOX_COPILOTKIT_RUNTIME_SYMBOL`. Pattern 1 and `createOpenBoxCopilotKit` construct and attach/own it for you.

As of `0.4.0` this is a richer internal shape than earlier releases — it owns the one base `OpenBoxRuntime` this controller uses plus every controller-scoped piece the middleware and `serverTool()` need:

```ts
interface OpenBoxRuntimeController {
  runtime: OpenBoxRuntime;                          // the one base OpenBoxRuntime (config, client, adapter)
  runContext: RunContextStore;                      // per-run context store (D7) — separate from the base per-runtime ContextStore
  telemetryQueue: LifecycleTelemetryQueue;           // bounded, non-blocking telemetry sender (fixes B4)
  defaults: OpenBoxRuntimeDefaults;                 // { agentId?, tenantId?, workflowType? }
  logger: OpenBoxLogger;                            // console-style sink
  serverToolOwnership: ServerToolOwnershipRegistry;  // (runId, toolCallId) claim registry (RT-F15)
  interruptStore: InterruptPersistencePort;          // injectable pending-interrupt persistence (RT-F9)
  runTerminalState: RunTerminalStateRegistry;        // per-run output-dedup/interrupted registry (RT-F14)
  childAgentClients: ChildAgentClientCache;          // cache of child-scoped clients for multi-agent Handoff
}
```

This type is not meant to be hand-constructed. `createOpenBoxMiddleware(runtime, opts)` *receives* a fully-built controller rather than building one itself — get one from `withOpenBoxRuntime` or `createOpenBoxCopilotKit` (Pattern 2's hand-built `{ client, defaults, logger }` object in [integration-patterns.md](./integration-patterns.md) predates this richer `0.4.0` shape and is out of date — see the note on that pattern).

---

### `OpenBoxMiddlewareOptions`

Already documented under [`createOpenBoxMiddleware`](#createopenboxmiddlewareruntime-opts).

---

## DID signing and identity headers

When `agentDid` + `agentPrivateKey` are configured, every outbound governance request signs with these five headers. As of `0.4.0`, the header NAMES, canonical-request assembly, and Ed25519 signing all delegate to `@openbox-ai/openbox-sdk-ts/identity` (`HEADER_*` constants, `buildCanonicalString`, `AgentIdentity`) — there is no second signer in this package; nonce/timestamp *generation* stays adapter-owned so wire values are unchanged from earlier releases:

| Header | Contents |
|---|---|
| `X-OpenBox-Agent-DID` | The `did:...` identifier |
| `X-OpenBox-Agent-Timestamp` | ISO 8601 timestamp at request send |
| `X-OpenBox-Agent-Nonce` | Per-request random nonce (UUID) |
| `X-OpenBox-Body-SHA256` | SHA-256 of the request body (binds the signature to the payload) |
| `X-OpenBox-Agent-Signature` | Ed25519 signature over `METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256` |

Body size is capped (default 10 MiB) to prevent signature-amplification DoS.

**Reserved headers:** when DID signing is enabled, user middleware MUST NOT write `x-openbox-*` headers. See [troubleshooting → DID signing trust ordering](./troubleshooting.md#5-did-signing-and-custom-beforerequestmiddleware-trust-ordering).

---

## Future Reference Pages

These topics are currently covered in the main docs and can split into
dedicated pages as the public surface grows:

- `architecture.md`, `event-model.md` — content merged into this page (event matrix + emission shape).
- `approvals-and-guardrails.md` — content merged into the enforcement-boundary sections above + [troubleshooting](./troubleshooting.md).
- `security-and-privacy.md` — content merged into [installation security & privacy](./installation.md#security-and-privacy) + DID-signing trust note.
- `configuration.md` — content merged into `OpenBoxConfigInput` field reference + [`MIGRATION.md`](../MIGRATION.md)'s alias table.

When the public surface grows past three framework exports, these split out.
