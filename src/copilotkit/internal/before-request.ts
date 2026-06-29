import { randomUUID } from "node:crypto";

import { enterOpenBoxExecutionContext } from "../../governance/context.js";
import {
  createAgentIdentityHeaders,
  type AgentIdentityHeaders
} from "../../identity/agent-identity.js";
import { getOpenBoxRuntime } from "../runtime-symbol.js";
import type { OpenBoxRuntimeController } from "../types.js";

// 10 MiB. Bound the body that we hash for DID signing — unbounded hashing
// would let any caller amplify CPU/memory cost just by enlarging the request.
const DEFAULT_MAX_SIGNED_BODY_BYTES = 10 * 1024 * 1024;
const TENANT_HEADER = "x-openbox-tenant-id";
const USER_HEADER = "x-openbox-user-id";

/**
 * Structural projection of `@copilotkit/runtime/v2`'s
 * `BeforeRequestMiddlewareParameters`. The types module is not exported from
 * the package barrel, so the SDK depends on the shape (matched by v2's
 * `callBeforeRequestMiddleware` call site) rather than on the importable
 * symbol.
 */
export interface BeforeRequestMiddlewareParametersLike {
  path: string;
  request: Request;
  // The runtime instance is typed structurally so this SDK does not depend on
  // private CopilotKit runtime types.
  runtime: object;
}

export type OpenBoxBeforeRequestFn = (
  params: BeforeRequestMiddlewareParametersLike
) => Promise<Request | void>;

export interface OpenBoxBeforeRequestOptions {
  /**
   * Decentralised-identifier for this agent. When set together with
   * `agentPrivateKey`, the middleware injects the 5-header OpenBox identity
   * envelope onto the outgoing request: DID, Timestamp, Nonce, Body-SHA256,
   * Signature. The canonical request `METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256`
   * is signed with the Ed25519 private key. Replay-protected (nonce +
   * timestamp) and body-bound (SHA-256).
   */
  agentDid?: string | undefined;
  /** Base64-encoded raw 32-byte Ed25519 seed. Required to enable DID signing. */
  agentPrivateKey?: string | undefined;
  /**
   * Skip DID signing if the request body exceeds this size (bytes). Default
   * 10 MiB. Set to `0` or `Infinity` only if you trust every caller — the
   * underlying SHA-256 cost scales linearly with body size.
   */
  maxSignedBodyBytes?: number | undefined;
  /**
   * Resolve the per-request tenant from a server-trusted source (e.g. a
   * Next.js cookie session, JWT, or mTLS-terminated upstream proxy).
   *
   * SECURITY: when DID signing is enabled, any tenant header present before
   * signing becomes part of the signed request. Prefer `tenantFromRequest`
   * with a server-trusted source. The header path is safe only behind a
   * trusted upstream proxy that owns the namespace.
   */
  tenantFromRequest?: (request: Request) => string | undefined;
  /** SERVER-TRUSTED user resolver. See `tenantFromRequest` warning. */
  userFromRequest?: (request: Request) => string | undefined;
}

/**
 * Build a v2-compatible `BeforeRequestMiddlewareFn` that:
 *
 *   1. Resolves tenant / user (callbacks → headers → controller defaults).
 *   2. Opens an `OpenBoxExecutionContext` for the rest of the request via
 *      `enterOpenBoxExecutionContext` (Node-only `AsyncLocalStorage.enterWith`).
 *      The context is visible to any downstream emission in the same async
 *      task.
 *   3. When DID config is present AND body size is within
 *      `maxSignedBodyBytes`, clones the request body, builds the 5-header DID
 *      envelope, and returns a NEW `Request` with the headers attached.
 *      Otherwise returns `undefined` (no replacement — v2 keeps the original
 *      request).
 *
 * Observation-only on the response path — see `openBoxAfterRequest`.
 */
export function openBoxBeforeRequest(
  runtime: object,
  opts: OpenBoxBeforeRequestOptions = {}
): OpenBoxBeforeRequestFn {
  const controller = getOpenBoxRuntime<OpenBoxRuntimeController>(runtime);
  const maxBytes =
    typeof opts.maxSignedBodyBytes === "number"
      ? opts.maxSignedBodyBytes
      : DEFAULT_MAX_SIGNED_BODY_BYTES;
  const signingEnabled = Boolean(opts.agentDid && opts.agentPrivateKey);

  return async (params) => {
    const tenantId =
      opts.tenantFromRequest?.(params.request) ??
      params.request.headers.get(TENANT_HEADER) ??
      controller?.defaults.tenantId ??
      undefined;
    const userId =
      opts.userFromRequest?.(params.request) ??
      params.request.headers.get(USER_HEADER) ??
      undefined;

    const executionContext = {
      // OpenBoxExecutionContext is intentionally loose — only `metadata` is
      // structured. We stash tenant/user/traceId in metadata so any
      // downstream emission can read them via getOpenBoxExecutionContext().
      metadata: {
        ...(tenantId ? { tenant_id: tenantId } : {}),
        ...(userId ? { user_id: userId } : {}),
        trace_id: randomUUID()
      }
    };

    enterOpenBoxExecutionContext(executionContext);

    if (!signingEnabled) {
      return undefined;
    }

    let bodyBytes: Uint8Array;
    try {
      const buf = await params.request.clone().arrayBuffer();
      bodyBytes = new Uint8Array(buf);
    } catch (err) {
      controller?.logger.warn?.({
        err,
        note: "openbox before-request: failed to read body for DID signing — skipping signing"
      });
      return undefined;
    }

    if (bodyBytes.byteLength > maxBytes) {
      controller?.logger.warn?.({
        body_bytes: bodyBytes.byteLength,
        event: "BodySigningSkipped",
        max_signed_body_bytes: maxBytes,
        note: "openbox before-request: body exceeds maxSignedBodyBytes — skipping DID signing"
      });
      return undefined;
    }

    let identityHeaders: AgentIdentityHeaders;
    try {
      identityHeaders = createAgentIdentityHeaders({
        body: bodyBytes,
        did: opts.agentDid as string,
        method: params.request.method,
        pathname: new URL(params.request.url).pathname,
        privateKey: opts.agentPrivateKey as string
      });
    } catch (err) {
      controller?.logger.warn?.({
        err,
        note: "openbox before-request: createAgentIdentityHeaders threw — skipping DID signing"
      });
      return undefined;
    }

    const mergedHeaders = new Headers(params.request.headers);
    for (const [name, value] of Object.entries(identityHeaders)) {
      mergedHeaders.set(name, value);
    }

    // duplex: 'half' is required when Request init is constructed with a
    // streaming-eligible body on Node 18+/24 fetch. We pass a Uint8Array, but
    // some Node fetch implementations still demand the flag — including it
    // unconditionally is safe (it's a no-op for non-streaming bodies).
    //
    // `signal` is propagated so client-disconnect cancellation reaches the
    // downstream agent runner. Client-side init fields such as cache, mode, and
    // redirect are intentionally dropped when rebuilding the server request.
    const init: RequestInit & { duplex?: "half" } = {
      body: bodyBytes,
      duplex: "half",
      headers: mergedHeaders,
      method: params.request.method,
      signal: params.request.signal
    };

    return new Request(params.request.url, init);
  };
}
