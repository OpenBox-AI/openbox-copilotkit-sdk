import { afterEach, describe, expect, it } from "vitest";

import {
  OpenBoxClient,
  OpenBoxSpanProcessor,
  setupOpenBoxOpenTelemetry,
  type OpenBoxTelemetryController
} from "../../src/index.js";

let activeController: OpenBoxTelemetryController | undefined;

afterEach(async () => {
  if (activeController) {
    await activeController.shutdown();
    activeController = undefined;
  }
});

describe("setupOpenBoxOpenTelemetry — self-call idempotency", () => {
  it("returns the same controller on a second call with the same governanceClient and preserves the fetch patch", async () => {
    const client = new OpenBoxClient({
      apiKey: "obx_test_self_call",
      apiUrl: "https://example.test/api",
      onApiError: "fail_open",
      timeoutSeconds: 5
    });

    const first = setupOpenBoxOpenTelemetry({
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    activeController = first;
    const patchedFetch = globalThis.fetch;

    const second = setupOpenBoxOpenTelemetry({
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    expect(second).toBe(first);
    expect(globalThis.fetch).toBe(patchedFetch);
  });

  it("returns the same controller when two distinct OpenBoxClient instances share apiUrl + apiKey", async () => {
    const clientA = new OpenBoxClient({
      apiKey: "obx_test_same_creds",
      apiUrl: "https://example.test/api",
      onApiError: "fail_open",
      timeoutSeconds: 5
    });
    const clientB = new OpenBoxClient({
      apiKey: "obx_test_same_creds",
      apiUrl: "https://example.test/api",
      onApiError: "fail_open",
      timeoutSeconds: 5
    });

    expect(clientA).not.toBe(clientB);

    const first = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      governanceClient: clientA,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });
    activeController = first;

    const second = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      governanceClient: clientB,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    expect(second).toBe(first);
  });

  it("returns the same controller when no governanceClient is provided on either call", async () => {
    const first = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    activeController = first;

    const second = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    expect(second).toBe(first);
  });
});
