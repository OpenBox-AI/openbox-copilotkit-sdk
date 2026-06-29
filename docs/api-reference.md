# API Reference

`@openbox-ai/openbox-copilotkit` exports a small, deliberate public surface. Two framework entry points are what most adopters touch; four shared exports are available for advanced wiring (Pattern 2 in [integration-patterns.md](./integration-patterns.md)).

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
  enforceApprovals?: boolean;
  frontendToolNames?: string[];
  isFrontendTool?: (call: { name: string }) => boolean;
  onEvent?: (emission: OpenBoxEmission) => void;
}
```

**Parameters**

- `runtime` — an `OpenBoxRuntimeController` (`{ client, defaults, logger }`). Pattern 1 builds this for you; Pattern 2 builds it by hand.
- `opts.enforceApprovals` — default `false` (telemetry-only). When `true`, the middleware awaits `client.evaluate` + `client.pollApproval` once a tool call's args are complete, before emitting the OpenBox `ActivityStarted` record. A block/halt verdict halts the stream and emits a redacted `governance_blocked` envelope (see below).
- `opts.frontendToolNames` — explicit allowlist of tool names that should record `frontend: true`. Without this (or `isFrontendTool`), every observed tool call records `frontend: false`, `tool_origin: "copilotkit-observed"` — safe default for non-Mastra backends (LangGraph / CrewAI / BuiltIn).
- `opts.isFrontendTool` — alternative callback form. Wins over `frontendToolNames` if both are set.
- `opts.onEvent` — fired for every emission with `{ activityId?, eventType, payload, workflowId }`. Optional sink for sidecar telemetry pipelines.

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

#### `enforceApprovals` and the `governance_blocked` envelope

When `enforceApprovals: true` and the verdict resolves to `Verdict.BLOCK` or `Verdict.HALT`, the middleware emits a fixed-shape AG-UI `RUN_ERROR` event into the observable and `complete`s the stream:

```json
{
  "type": "RUN_ERROR",
  "code": "governance_blocked",
  "correlationId": "<governanceEventId or approvalId>"
}
```

Tool name, tenant id, agent id, and verdict reason **never** appear in this envelope. The `correlationId` resolves to the unredacted record via the OpenBox UI.

This envelope is the **only** wire-format an enforcement block produces — adding fields here is a public-surface change (the `governance-blocked-redaction.test.ts` test asserts byte-for-byte equality).

---

## Copied shared exports

These come from the shared OpenBox SDK code and are documented inline here so adopters of this SDK do not need to read any sibling repo's docs.

### `parseOpenBoxConfig(input?, env?)`

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

### `OpenBoxClient`

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
- `httpCapture: boolean` — default `true`; preserved for shared-schema parity with sibling SDKs. As of 0.2.0-beta.0 this SDK does not capture HTTP/DB/file telemetry — the value is read at config-parse time but has no behavioral effect here.

The remaining `OpenBoxConfigInput` fields — `hitlEnabled` (default `true`), `maxEvaluatePayloadBytes` (default `256_000`), `sendActivityStartEvent` (default `true`), `sendStartEvent` (default `true`), `validate` (default `true`, calls `OpenBoxClient.validateApiKey()` at boot) — are stable internal-tuning knobs. Override via the matching `OPENBOX_*` env var or by passing the field to `parseOpenBoxConfig` / `WithOpenBoxRuntimeConfig`. The full schema lives in `src/config/openbox-config.ts`.

---

### `OpenBoxRuntimeController`

Wire-level dependencies attached to an OpenBox-wrapped `CopilotRuntime` via the private `OPENBOX_COPILOTKIT_RUNTIME_SYMBOL`. Pattern 1 constructs and attaches it for you; Pattern 2 builds it by hand.

```ts
interface OpenBoxRuntimeController {
  client: OpenBoxClient;
  defaults: OpenBoxRuntimeDefaults;     // { agentId?, tenantId?, workflowType? }
  logger: OpenBoxLogger;                // console-style sink
}
```

---

### `OpenBoxMiddlewareOptions`

Already documented under [`createOpenBoxMiddleware`](#createopenboxmiddlewareruntime-opts).

---

## DID signing and identity headers

When `agentDid` + `agentPrivateKey` are configured, `OpenBoxClient` signs every outbound request with these five headers (defined in `identity/agent-identity.ts`):

| Header | Contents |
|---|---|
| `X-OpenBox-Agent-DID` | The `did:openbox:...` identifier |
| `X-OpenBox-Agent-Timestamp` | Unix epoch seconds at request send |
| `X-OpenBox-Agent-Nonce` | Per-request random nonce |
| `X-OpenBox-Body-SHA256` | SHA-256 of the request body (binds the signature to the payload) |
| `X-OpenBox-Agent-Signature` | Ed25519 signature over `METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256` |

Body size is capped (default 10 MiB) to prevent signature-amplification DoS.

**Reserved headers:** when DID signing is enabled, user middleware MUST NOT write `x-openbox-*` headers. See [troubleshooting → DID signing trust ordering](./troubleshooting.md#5-did-signing-and-custom-beforerequestmiddleware-trust-ordering).

---

## Deferred (T1)

These pages are **not shipped in 0.1.0-beta.0** by design:

- `architecture.md`, `event-model.md` — content merged into this page (event matrix + emission shape).
- `approvals-and-guardrails.md` — content merged into `enforceApprovals` section + [troubleshooting](./troubleshooting.md).
- `security-and-privacy.md` — content merged into [installation security & privacy](./installation.md#security-and-privacy-t0) + DID-signing trust note.
- `configuration.md` — content merged into `OpenBoxConfigInput` field reference.

When the public surface grows past two framework exports, these split out.
