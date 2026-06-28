import {
  createHash,
  generateKeyPairSync,
  verify,
  type KeyObject
} from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  getOpenBoxExecutionContext,
  runWithOpenBoxExecutionContext
} from "../../../../src/governance/context.js";
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

function buildRuntime() {
  const { controller, logger } = buildController();
  const runtime: Record<string, unknown> = {};
  attachOpenBoxRuntime(runtime, controller);
  return { controller, logger, runtime };
}

function buildRequest(
  init: {
    body?: string | Uint8Array;
    headers?: Record<string, string>;
    method?: string;
    url?: string;
  } = {}
): Request {
  return new Request(init.url ?? "http://localhost/api/copilotkit", {
    body: init.body ?? null,
    duplex: init.body ? "half" : undefined,
    headers: init.headers,
    method: init.method ?? (init.body ? "POST" : "GET")
  } as RequestInit & { duplex?: "half" });
}

describe("openBoxBeforeRequest", () => {
  it("extracts tenant and user from default headers and populates the ALS context", async () => {
    await runWithOpenBoxExecutionContext({}, async () => {
      const { runtime } = buildRuntime();
      const fn = openBoxBeforeRequest(runtime);
      const request = buildRequest({
        headers: {
          "x-openbox-tenant-id": "tenant-A",
          "x-openbox-user-id": "user-A"
        }
      });

      const replacement = await fn({
        path: "/api/copilotkit",
        request,
        runtime
      });

      expect(replacement).toBeUndefined();
      const ctx = getOpenBoxExecutionContext();
      expect(ctx?.metadata?.tenant_id).toBe("tenant-A");
      expect(ctx?.metadata?.user_id).toBe("user-A");
      expect(typeof ctx?.metadata?.trace_id).toBe("string");
    });
  });

  it("prefers callback resolvers over header fallbacks (server-trusted source wins)", async () => {
    await runWithOpenBoxExecutionContext({}, async () => {
      const { runtime } = buildRuntime();
      const fn = openBoxBeforeRequest(runtime, {
        tenantFromRequest: () => "trusted-tenant",
        userFromRequest: () => "trusted-user"
      });
      const request = buildRequest({
        headers: {
          "x-openbox-tenant-id": "header-tenant",
          "x-openbox-user-id": "header-user"
        }
      });

      await fn({ path: "/api/copilotkit", request, runtime });

      const ctx = getOpenBoxExecutionContext();
      expect(ctx?.metadata?.tenant_id).toBe("trusted-tenant");
      expect(ctx?.metadata?.user_id).toBe("trusted-user");
    });
  });

  it("falls back to controller defaults when neither callback nor header supplies a tenant", async () => {
    await runWithOpenBoxExecutionContext({}, async () => {
      const { controller, runtime } = buildRuntime();
      controller.defaults.tenantId = "default-tenant";
      const fn = openBoxBeforeRequest(runtime);
      const request = buildRequest();

      await fn({ path: "/api/copilotkit", request, runtime });

      expect(getOpenBoxExecutionContext()?.metadata?.tenant_id).toBe(
        "default-tenant"
      );
    });
  });

  it("returns undefined and skips signing when DID config is missing", async () => {
    await runWithOpenBoxExecutionContext({}, async () => {
      const { runtime } = buildRuntime();
      const fn = openBoxBeforeRequest(runtime);
      const request = buildRequest({ body: "{}" });

      const replacement = await fn({
        path: "/api/copilotkit",
        request,
        runtime
      });

      expect(replacement).toBeUndefined();
      expect(request.bodyUsed).toBe(false);
    });
  });

  it("injects all 5 DID headers when signing is configured and the body fits the cap", async () => {
    await runWithOpenBoxExecutionContext({}, async () => {
      const { runtime } = buildRuntime();
      const identity = createTestIdentity();
      const body = '{"threadId":"thread-A"}';
      const fn = openBoxBeforeRequest(runtime, {
        agentDid: identity.did,
        agentPrivateKey: identity.privateKey
      });
      const request = buildRequest({ body });

      const replacement = await fn({
        path: "/api/copilotkit",
        request,
        runtime
      });

      expect(replacement).toBeInstanceOf(Request);
      const signedRequest = replacement as Request;
      expect(signedRequest.headers.get(OPENBOX_AGENT_DID_HEADER)).toBe(
        identity.did
      );
      expect(signedRequest.headers.get(OPENBOX_AGENT_TIMESTAMP_HEADER)).toBeTruthy();
      expect(signedRequest.headers.get(OPENBOX_AGENT_NONCE_HEADER)).toBeTruthy();
      expect(signedRequest.headers.get(OPENBOX_BODY_SHA256_HEADER)).toBe(
        createHash("sha256").update(body).digest("hex")
      );
      expect(signedRequest.headers.get(OPENBOX_AGENT_SIGNATURE_HEADER)).toBeTruthy();

      // Body is preserved byte-for-byte.
      expect(await signedRequest.text()).toBe(body);
      // Original request body was only cloned, not consumed.
      expect(request.bodyUsed).toBe(false);
    });
  });

  it("propagates AbortSignal from the original request onto the signed replacement", async () => {
    await runWithOpenBoxExecutionContext({}, async () => {
      const { runtime } = buildRuntime();
      const identity = createTestIdentity();
      const controller = new AbortController();
      const request = new Request("http://localhost/api/copilotkit", {
        body: '{"a":1}',
        duplex: "half",
        method: "POST",
        signal: controller.signal
      } as RequestInit & { duplex?: "half" });
      const fn = openBoxBeforeRequest(runtime, {
        agentDid: identity.did,
        agentPrivateKey: identity.privateKey
      });

      const signed = (await fn({
        path: "/api/copilotkit",
        request,
        runtime
      })) as Request;

      // Aborting the original controller must propagate to the rebuilt
      // request so client-disconnect cancellation reaches v2's agent runner.
      expect(signed.signal.aborted).toBe(false);
      controller.abort();
      expect(signed.signal.aborted).toBe(true);
    });
  });

  it("preserves binary bodies byte-for-byte through signing", async () => {
    await runWithOpenBoxExecutionContext({}, async () => {
      const { runtime } = buildRuntime();
      const identity = createTestIdentity();
      const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64]);
      const fn = openBoxBeforeRequest(runtime, {
        agentDid: identity.did,
        agentPrivateKey: identity.privateKey
      });
      const request = buildRequest({ body: bytes });

      const replacement = (await fn({
        path: "/api/copilotkit",
        request,
        runtime
      })) as Request;

      const signedBytes = new Uint8Array(await replacement.arrayBuffer());
      expect(Array.from(signedBytes)).toEqual(Array.from(bytes));
      expect(replacement.headers.get(OPENBOX_BODY_SHA256_HEADER)).toBe(
        createHash("sha256").update(bytes).digest("hex")
      );
    });
  });

  it("signature verifies against the canonical request built from the emitted headers", async () => {
    await runWithOpenBoxExecutionContext({}, async () => {
      const { runtime } = buildRuntime();
      const identity = createTestIdentity();
      const body = '{"verified":true}';
      const fn = openBoxBeforeRequest(runtime, {
        agentDid: identity.did,
        agentPrivateKey: identity.privateKey
      });
      const request = buildRequest({
        body,
        url: "http://localhost/api/copilotkit/runtime"
      });

      const signed = (await fn({
        path: "/api/copilotkit/runtime",
        request,
        runtime
      })) as Request;

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
  });

  it("skips signing when the body exceeds maxSignedBodyBytes and logs a warning", async () => {
    await runWithOpenBoxExecutionContext({}, async () => {
      const { logger, runtime } = buildRuntime();
      const identity = createTestIdentity();
      const body = "x".repeat(64);
      const fn = openBoxBeforeRequest(runtime, {
        agentDid: identity.did,
        agentPrivateKey: identity.privateKey,
        maxSignedBodyBytes: 16
      });
      const request = buildRequest({ body });

      const replacement = await fn({
        path: "/api/copilotkit",
        request,
        runtime
      });

      expect(replacement).toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
      const warnPayload = logger.warn.mock.calls[0]?.[0];
      expect(warnPayload).toMatchObject({ event: "BodySigningSkipped" });
    });
  });

  it("does not consume the original request body (clone correctness)", async () => {
    await runWithOpenBoxExecutionContext({}, async () => {
      const { runtime } = buildRuntime();
      const identity = createTestIdentity();
      const body = '{"keep":"original"}';
      const fn = openBoxBeforeRequest(runtime, {
        agentDid: identity.did,
        agentPrivateKey: identity.privateKey
      });
      const request = buildRequest({ body });

      await fn({ path: "/api/copilotkit", request, runtime });

      expect(request.bodyUsed).toBe(false);
      expect(await request.text()).toBe(body);
    });
  });

  it("works even when the runtime has no OpenBox controller attached (defensive no-op for DID, still opens context)", async () => {
    await runWithOpenBoxExecutionContext({}, async () => {
      const runtime = {}; // not OpenBox-wrapped
      const fn = openBoxBeforeRequest(runtime);
      const request = buildRequest({
        headers: { "x-openbox-tenant-id": "tenant-X" }
      });

      const replacement = await fn({
        path: "/api/copilotkit",
        request,
        runtime
      });

      expect(replacement).toBeUndefined();
      expect(getOpenBoxExecutionContext()?.metadata?.tenant_id).toBe("tenant-X");
    });
  });

  it("does not throw when createAgentIdentityHeaders rejects an invalid private key — logs and skips", async () => {
    await runWithOpenBoxExecutionContext({}, async () => {
      const { logger, runtime } = buildRuntime();
      const fn = openBoxBeforeRequest(runtime, {
        agentDid: "did:aip:550e8400-e29b-41d4-a716-446655440000",
        agentPrivateKey: "not-a-valid-base64-seed!"
      });
      const request = buildRequest({ body: "{}" });

      const replacement = await fn({
        path: "/api/copilotkit",
        request,
        runtime
      });

      expect(replacement).toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});

describe("openBoxBeforeRequest — request ALS propagation across awaits", () => {
  it("preserves the ALS context across an awaited boundary within the same async task", async () => {
    await runWithOpenBoxExecutionContext({}, async () => {
      const { runtime } = buildRuntime();
      const fn = openBoxBeforeRequest(runtime, {
        tenantFromRequest: () => "tenant-async"
      });
      const request = buildRequest();

      await fn({ path: "/api/copilotkit", request, runtime });
      // Yield to the event loop to prove enterWith() persists past awaits.
      await new Promise((resolve) => setImmediate(resolve));

      expect(getOpenBoxExecutionContext()?.metadata?.tenant_id).toBe(
        "tenant-async"
      );
    });
  });
});

describe("openBoxBeforeRequest — replay protection", () => {
  it("emits a different nonce and timestamp on each signing call (no static nonce reuse)", async () => {
    await runWithOpenBoxExecutionContext({}, async () => {
      const { runtime } = buildRuntime();
      const identity = createTestIdentity();
      const body = '{"replay":true}';
      const fn = openBoxBeforeRequest(runtime, {
        agentDid: identity.did,
        agentPrivateKey: identity.privateKey
      });

      const firstSigned = (await fn({
        path: "/api/copilotkit",
        request: buildRequest({ body }),
        runtime
      })) as Request;
      // Force a real time delta so the millisecond-precision timestamp is
      // guaranteed to differ between the two signatures.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const secondSigned = (await fn({
        path: "/api/copilotkit",
        request: buildRequest({ body }),
        runtime
      })) as Request;

      expect(firstSigned.headers.get(OPENBOX_AGENT_NONCE_HEADER)).not.toBe(
        secondSigned.headers.get(OPENBOX_AGENT_NONCE_HEADER)
      );
      expect(firstSigned.headers.get(OPENBOX_AGENT_TIMESTAMP_HEADER)).not.toBe(
        secondSigned.headers.get(OPENBOX_AGENT_TIMESTAMP_HEADER)
      );
      expect(firstSigned.headers.get(OPENBOX_AGENT_SIGNATURE_HEADER)).not.toBe(
        secondSigned.headers.get(OPENBOX_AGENT_SIGNATURE_HEADER)
      );
    });
  });
});

// Silence unused-import warnings when the suite is reduced; vi is used in
// peer test files but kept here for parity with the test-utils mock surface.
void vi;
