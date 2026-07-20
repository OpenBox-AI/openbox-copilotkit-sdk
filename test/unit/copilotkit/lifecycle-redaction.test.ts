import { describe, expect, it } from "vitest";

import { OpenBoxCopilotKitEmitter } from "../../../src/copilotkit/openbox-emitter.js";
import {
  redactAndBoundRawField,
  redactPathsToKeySet
} from "../../../src/copilotkit/lifecycle-redaction.js";

import { buildController, flushMacrotask } from "./test-utils.js";

/**
 * RT-F2 (Critical): `redactPaths` (JSONPath-like) is NOT the base gate's
 * key-name `redactKeys` — a verbatim map is a no-op that leaks secrets. These
 * tests prove the fix at BOTH layers `lifecycle-redaction.ts` implements:
 * the leaf-key translation fed into the base gate's `PrivacyConfig`, and the
 * CopilotKit-side precise path redactor + size bound applied before a raw
 * field ever reaches a base event factory.
 */

describe("redactPathsToKeySet", () => {
  it("extracts the leaf key name from $..key and $.a.b.key shapes", () => {
    expect(redactPathsToKeySet(["$..token", "$.user.credentials.secret"])).toEqual(
      new Set(["token", "secret"])
    );
  });

  it("ignores an unsupported path shape and an empty/undefined list", () => {
    expect(redactPathsToKeySet(["not-a-jsonpath"])).toEqual(new Set());
    expect(redactPathsToKeySet(undefined)).toEqual(new Set());
    expect(redactPathsToKeySet([])).toEqual(new Set());
  });
});

describe("redactAndBoundRawField", () => {
  it("passes undefined through unchanged (preserves the factory's own omission rule)", () => {
    expect(redactAndBoundRawField(undefined, ["$..token"])).toBeUndefined();
  });

  it("redacts a deeply-nested key matched by $..key without mutating the caller's object", () => {
    const input = { user: { profile: { name: "Ada" }, token: "SECRET" } };
    const result = redactAndBoundRawField(input, ["$..token"]) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect((result.user as Record<string, unknown>).token).toBe("[REDACTED]");
    // Untouched sibling data survives.
    expect((result.user as { profile: { name: string } }).profile.name).toBe("Ada");
    // The caller's original object is never mutated.
    expect(input.user.token).toBe("SECRET");
  });

  it("redacts only the exact fixed path for $.a.b.key, leaving a same-named key elsewhere untouched", () => {
    const input = { a: { b: { key: "fixed-secret" } }, other: { key: "not-secret" } };
    const result = redactAndBoundRawField(input, ["$.a.b.key"]) as Record<string, unknown>;

    expect((result.a as { b: { key: string } }).b.key).toBe("[REDACTED]");
    expect((result.other as { key: string }).key).toBe("not-secret");
  });
});

describe("OpenBoxCopilotKitEmitter — RT-F2 redaction end to end", () => {
  it("a nested configured secret is absent from the prepared wire payload (activity args)", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined, ["$..token"]);

    await emitter.emitActivityStarted({
      activityArgs: { user: { token: "SECRET" } },
      activityId: "call-1",
      frontend: false,
      runId: "run-1",
      toolName: "chargeCard",
      toolOrigin: "copilotkit-observed",
      workflowId: "thread-1"
    });
    await flushMacrotask();

    expect(evaluateMock).toHaveBeenCalledTimes(1);
    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain("SECRET");
    // Redacted, not silently dropped — the key survives with a marked value.
    const activityInput = payload.activity_input as { user: { token: string } };
    expect(activityInput.user.token).toBe("[REDACTED]");
  });

  it("a nested configured secret is absent from the prepared wire payload (activity output)", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined, ["$..token"]);

    await emitter.emitActivityCompleted({
      activityId: "call-1",
      activityOutput: { user: { token: "SECRET" } },
      runId: "run-1",
      status: "completed",
      toolName: "chargeCard",
      workflowId: "thread-1"
    });
    await flushMacrotask();

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain("SECRET");
  });

  it("a nested configured secret is absent from the prepared wire payload (signal args)", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined, ["$..token"]);

    await emitter.emitSignalReceived({
      payload: { user: { token: "SECRET" } },
      runId: "run-1",
      signalName: "user_input",
      workflowId: "thread-1"
    });
    await flushMacrotask();

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain("SECRET");
  });

  it("also feeds redactPaths into the base gate's key-name redactKeys — redacts even a field this adapter doesn't explicitly bound (metadata)", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined, ["$..token"]);

    await emitter.emitWorkflowStarted({
      metadata: { token: "SECRET-IN-METADATA" },
      runId: "run-1",
      threadId: "thread-1",
      workflowId: "thread-1"
    });
    await flushMacrotask();

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain("SECRET-IN-METADATA");
  });

  it("without redactPaths configured, a plain key-name-verbatim map would have been a no-op — confirms the translation is what protects the payload", async () => {
    const { controller, evaluateMock } = buildController();
    // No 3rd argument (redactPaths) — the raw secret ships verbatim, proving
    // the PREVIOUS tests' absence of "SECRET" is the redaction path working,
    // not some unrelated base-gate default behavior.
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    await emitter.emitActivityStarted({
      activityArgs: { user: { token: "SECRET" } },
      activityId: "call-1",
      frontend: false,
      runId: "run-1",
      toolName: "chargeCard",
      toolOrigin: "copilotkit-observed",
      workflowId: "thread-1"
    });
    await flushMacrotask();

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(payload)).toContain("SECRET");
  });
});
