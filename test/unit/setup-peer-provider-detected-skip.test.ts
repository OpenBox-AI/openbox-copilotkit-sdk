import { afterEach, describe, expect, it, vi } from "vitest";

import { trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import {
  OpenBoxSpanProcessor,
  setupOpenBoxOpenTelemetry,
  type OpenBoxTelemetryController
} from "../../src/index.js";

let activeController: OpenBoxTelemetryController | undefined;
let peerProvider: NodeTracerProvider | undefined;

afterEach(async () => {
  if (activeController) {
    await activeController.shutdown();
    activeController = undefined;
  }

  if (peerProvider) {
    await peerProvider.shutdown();
    peerProvider = undefined;
  }

  trace.disable();
});

describe("setupOpenBoxOpenTelemetry — peer tracer provider detected", () => {
  it("emits a no-op controller, logs a warning, and leaves globalThis.fetch unmodified when a foreign provider is already registered", async () => {
    const originalFetch = globalThis.fetch;
    peerProvider = new NodeTracerProvider({ spanProcessors: [] });
    peerProvider.register();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: true,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    activeController = controller;

    expect(controller.instrumentations).toEqual([]);
    expect(globalThis.fetch).toBe(originalFetch);
    expect(controller.tracerProvider).not.toBe(trace.getTracerProvider());
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("peer tracer provider detected")
    );

    warnSpy.mockRestore();
  });
});
