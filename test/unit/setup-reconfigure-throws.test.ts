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

describe("setupOpenBoxOpenTelemetry — reconfigure throws", () => {
  it("throws when called a second time with a different governanceClient config and surfaces a documented shutdown-first instruction", () => {
    const clientA = new OpenBoxClient({
      apiKey: "obx_test_reconfigure_A",
      apiUrl: "https://example.test/api",
      onApiError: "fail_open",
      timeoutSeconds: 5
    });
    const clientB = new OpenBoxClient({
      apiKey: "obx_test_reconfigure_B",
      apiUrl: "https://example.test/api",
      onApiError: "fail_open",
      timeoutSeconds: 5
    });

    const first = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      governanceClient: clientA,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    activeController = first;

    expect(() =>
      setupOpenBoxOpenTelemetry({
        captureHttpBodies: false,
        governanceClient: clientB,
        instrumentDatabases: false,
        instrumentFileIo: false,
        spanProcessor: new OpenBoxSpanProcessor()
      })
    ).toThrow(/Call controller\.shutdown\(\) first/);
  });

  it("allows a reconfigure after the previous controller is shut down", async () => {
    const clientA = new OpenBoxClient({
      apiKey: "obx_test_reconfigure_after_shutdown_A",
      apiUrl: "https://example.test/api",
      onApiError: "fail_open",
      timeoutSeconds: 5
    });
    const clientB = new OpenBoxClient({
      apiKey: "obx_test_reconfigure_after_shutdown_B",
      apiUrl: "https://example.test/api",
      onApiError: "fail_open",
      timeoutSeconds: 5
    });

    const first = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      governanceClient: clientA,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });
    await first.shutdown();

    const second = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      governanceClient: clientB,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });
    activeController = second;

    expect(second).not.toBe(first);
  });
});
