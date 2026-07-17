import { createHash, randomUUID } from "node:crypto";

import {
  AgentIdentity,
  buildCanonicalString,
  HEADER_BODY_SHA256,
  HEADER_DID,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP
} from "@openbox-ai/openbox-sdk-ts/identity";

import { OpenBoxConfigError } from "../types/index.js";

/**
 * @deprecated Thin facade over `@openbox-ai/openbox-sdk-ts/identity`. The
 * Ed25519/PKCS8 signing implementation now lives exclusively in the base SDK
 * (no second signer in this package) — this module only re-shapes base's
 * primitives into the names/signatures this package has always exported, so
 * existing importers keep working for one release (D3). New code should
 * import `@openbox-ai/openbox-sdk-ts/identity` directly. Removed at `1.0.0`.
 *
 * Header NAMES are sourced from base's `HEADER_*` constants (byte-identical
 * strings to what this module hardcoded before), and canonicalization
 * delegates to base's `buildCanonicalString` (same `METHOD\nPATH\nTIMESTAMP\n
 * NONCE\nBODY_SHA256` join this module always produced). Nonce/timestamp
 * GENERATION intentionally stays adapter-owned (`randomUUID()` /
 * `Date.prototype.toISOString()`) rather than switching to base's own
 * generators (base's nonce format and `+00:00`-offset timestamp format
 * differ) — this preserves the exact wire values existing consumers/tests
 * observe; only the underlying validation/key-loading/signing operations move
 * to base.
 */
export const OPENBOX_AGENT_DID_HEADER = HEADER_DID;
export const OPENBOX_AGENT_TIMESTAMP_HEADER = HEADER_TIMESTAMP;
export const OPENBOX_AGENT_NONCE_HEADER = HEADER_NONCE;
export const OPENBOX_BODY_SHA256_HEADER = HEADER_BODY_SHA256;
export const OPENBOX_AGENT_SIGNATURE_HEADER = HEADER_SIGNATURE;

export interface AgentIdentityConfig {
  did: string;
  privateKey: string;
}

export interface BuildAgentIdentityCanonicalRequestInput {
  bodySHA256: string;
  method: string;
  nonce: string;
  pathname: string;
  timestamp: string;
}

export interface CreateAgentIdentityHeadersInput extends AgentIdentityConfig {
  body?: string | Uint8Array | undefined;
  method: string;
  nonce?: string | undefined;
  pathname: string;
  timestamp?: string | undefined;
}

export type AgentIdentityHeaders = {
  [OPENBOX_AGENT_DID_HEADER]: string;
  [OPENBOX_AGENT_TIMESTAMP_HEADER]: string;
  [OPENBOX_AGENT_NONCE_HEADER]: string;
  [OPENBOX_BODY_SHA256_HEADER]: string;
  [OPENBOX_AGENT_SIGNATURE_HEADER]: string;
};

/**
 * Positional-argument bridge to base's `buildCanonicalString`. Field order
 * (method, path, timestamp, nonce, bodySha256) and join separator (`\n`) are
 * byte-identical to what this function always produced.
 */
export function buildAgentIdentityCanonicalRequest({
  bodySHA256,
  method,
  nonce,
  pathname,
  timestamp
}: BuildAgentIdentityCanonicalRequestInput): string {
  return buildCanonicalString(method, pathname, timestamp, nonce, bodySHA256);
}

/**
 * Validates the DID format (`did:aip:<uuid>`) and decodes/loads the Ed25519
 * seed via base's `AgentIdentity.fromPrivateKey` — base's own hierarchy and
 * PKCS8 wrapping are verified byte-identical to this module's former local
 * implementation. Base errors are re-thrown as this package's own
 * `OpenBoxConfigError` so `instanceof` checks against this package's exported
 * error class keep working for existing callers.
 */
export function validateAgentIdentityConfig(
  config: AgentIdentityConfig
): AgentIdentityConfig {
  const did = config.did.trim();
  const privateKey = config.privateKey.trim();

  try {
    AgentIdentity.fromPrivateKey(did, privateKey);
  } catch (err) {
    throw new OpenBoxConfigError(
      err instanceof Error ? err.message : String(err)
    );
  }

  return { did, privateKey };
}

/**
 * Builds the 5-header OpenBox identity envelope. Validation + key-loading +
 * signing all delegate to base's `AgentIdentity`; nonce/timestamp generation
 * stays adapter-owned (see module doc) so the emitted wire values are
 * unchanged from this module's prior, fully-local implementation.
 */
export function createAgentIdentityHeaders({
  body,
  did,
  method,
  nonce = randomUUID(),
  pathname,
  privateKey,
  timestamp = new Date().toISOString()
}: CreateAgentIdentityHeadersInput): AgentIdentityHeaders {
  const identity = validateAgentIdentityConfig({ did, privateKey });
  const bodyBytes = bodyToBuffer(body);
  const bodySHA256 = createHash("sha256").update(bodyBytes).digest("hex");
  const canonical = buildAgentIdentityCanonicalRequest({
    bodySHA256,
    method,
    nonce,
    pathname,
    timestamp
  });

  let signer: AgentIdentity;
  try {
    signer = AgentIdentity.fromPrivateKey(identity.did, identity.privateKey);
  } catch (err) {
    throw new OpenBoxConfigError(
      err instanceof Error ? err.message : String(err)
    );
  }

  return {
    [OPENBOX_AGENT_DID_HEADER]: signer.agentDid,
    [OPENBOX_AGENT_TIMESTAMP_HEADER]: timestamp,
    [OPENBOX_AGENT_NONCE_HEADER]: nonce,
    [OPENBOX_BODY_SHA256_HEADER]: bodySHA256,
    [OPENBOX_AGENT_SIGNATURE_HEADER]: signer.sign(canonical)
  };
}

function bodyToBuffer(body: string | Uint8Array | undefined): Buffer {
  if (typeof body === "string") {
    return Buffer.from(body);
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  return Buffer.alloc(0);
}
