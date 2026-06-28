import {
  createHash,
  generateKeyPairSync,
  verify,
  type KeyObject
} from "node:crypto";

import { describe, expect, it } from "vitest";

import { runWithOpenBoxExecutionContext } from "../../../../src/governance/context.js";
import {
  OPENBOX_AGENT_DID_HEADER,
  OPENBOX_AGENT_NONCE_HEADER,
  OPENBOX_AGENT_SIGNATURE_HEADER,
  OPENBOX_AGENT_TIMESTAMP_HEADER,
  OPENBOX_BODY_SHA256_HEADER,
  buildAgentIdentityCanonicalRequest
} from "../../../../src/identity/index.js";
import { openBoxBeforeRequest } from "../../../../src/copilotkit/internal/before-request.js";
import { attachOpenBoxRuntime } from "../../../../src/copilotkit/runtime-symbol.js";
import { buildController } from "../test-utils.js";

const ED25519_PKCS8_SEED_PREFIX = "302e020100300506032b657004220420";

function createTestIdentity(): {
  did: string;
  privateKey: string;
  publicKey: KeyObject;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey
    .export({ format: "der", type: "pkcs8" })
    .subarray(Buffer.from(ED25519_PKCS8_SEED_PREFIX, "hex").length);
  return {
    did: "did:aip:550e8400-e29b-41d4-a716-446655440000",
    privateKey: seed.toString("base64"),
    publicKey
  };
}

async function signWithMiddleware(
  body: string,
  url = "http://localhost/api/copilotkit"
): Promise<{ identity: ReturnType<typeof createTestIdentity>; signed: Request }> {
  const built = buildController();
  const runtime: Record<string, unknown> = {};
  attachOpenBoxRuntime(runtime, built.controller);
  const identity = createTestIdentity();
  const fn = openBoxBeforeRequest(runtime, {
    agentDid: identity.did,
    agentPrivateKey: identity.privateKey
  });
  const request = new Request(url, {
    body,
    duplex: "half",
    method: "POST"
  } as RequestInit & { duplex?: "half" });

  const signed = await runWithOpenBoxExecutionContext({}, () =>
    fn({ path: new URL(url).pathname, request, runtime }).then(
      (r) => r as Request
    )
  );
  return { identity, signed };
}

describe("DID signing headers", () => {
  it("emits all 5 required identity headers", async () => {
    const { signed } = await signWithMiddleware('{"x":1}');

    expect(signed.headers.get(OPENBOX_AGENT_DID_HEADER)).toBeTruthy();
    expect(signed.headers.get(OPENBOX_AGENT_TIMESTAMP_HEADER)).toBeTruthy();
    expect(signed.headers.get(OPENBOX_AGENT_NONCE_HEADER)).toBeTruthy();
    expect(signed.headers.get(OPENBOX_BODY_SHA256_HEADER)).toBeTruthy();
    expect(signed.headers.get(OPENBOX_AGENT_SIGNATURE_HEADER)).toBeTruthy();
  });

  it("body SHA-256 header equals sha256(body) hex digest", async () => {
    const body = '{"verify":"sha256"}';
    const { signed } = await signWithMiddleware(body);

    expect(signed.headers.get(OPENBOX_BODY_SHA256_HEADER)).toBe(
      createHash("sha256").update(body).digest("hex")
    );
  });

  it("signature verifies against the canonical request with the public key", async () => {
    const body = '{"verify":"signature"}';
    const url = "http://localhost/api/copilotkit/runtime";
    const { identity, signed } = await signWithMiddleware(body, url);

    const canonical = buildAgentIdentityCanonicalRequest({
      bodySHA256: signed.headers.get(OPENBOX_BODY_SHA256_HEADER) as string,
      method: "POST",
      nonce: signed.headers.get(OPENBOX_AGENT_NONCE_HEADER) as string,
      pathname: "/api/copilotkit/runtime",
      timestamp: signed.headers.get(OPENBOX_AGENT_TIMESTAMP_HEADER) as string
    });
    const signature = Buffer.from(
      signed.headers.get(OPENBOX_AGENT_SIGNATURE_HEADER) as string,
      "base64"
    );

    expect(
      verify(null, Buffer.from(canonical), identity.publicKey, signature)
    ).toBe(true);
  });

  it("emits a different nonce on each call (no static reuse, replay-protected)", async () => {
    const body = '{"replay":"protection"}';
    const first = await signWithMiddleware(body);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await signWithMiddleware(body);

    expect(first.signed.headers.get(OPENBOX_AGENT_NONCE_HEADER)).not.toBe(
      second.signed.headers.get(OPENBOX_AGENT_NONCE_HEADER)
    );
    expect(first.signed.headers.get(OPENBOX_AGENT_TIMESTAMP_HEADER)).not.toBe(
      second.signed.headers.get(OPENBOX_AGENT_TIMESTAMP_HEADER)
    );
  });

  it("modifying the body invalidates the signature (body-bound)", async () => {
    const body = '{"original":true}';
    const { identity, signed } = await signWithMiddleware(body);

    const canonical = buildAgentIdentityCanonicalRequest({
      // Use a SHA-256 of a different body to model a body-tampering attack.
      bodySHA256: createHash("sha256").update('{"tampered":true}').digest("hex"),
      method: "POST",
      nonce: signed.headers.get(OPENBOX_AGENT_NONCE_HEADER) as string,
      pathname: "/api/copilotkit",
      timestamp: signed.headers.get(OPENBOX_AGENT_TIMESTAMP_HEADER) as string
    });
    const signature = Buffer.from(
      signed.headers.get(OPENBOX_AGENT_SIGNATURE_HEADER) as string,
      "base64"
    );

    expect(
      verify(null, Buffer.from(canonical), identity.publicKey, signature)
    ).toBe(false);
  });
});
