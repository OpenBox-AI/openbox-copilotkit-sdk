import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunAgentInput, RunFinishedEvent } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import { parseResumeEntries, parseRunOutcome } from "../../../src/copilotkit/run-outcome.js";

/**
 * Contract test (phase-04 risk mitigation): pins `parseRunOutcome`/
 * `parseResumeEntries` against the phase-1 recorded fixtures. If a pinned
 * peer's `RUN_FINISHED.outcome`/resume shape ever diverges from these
 * fixtures, this test — not a live integration — is the first to fail.
 */

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/interrupt");

interface EventsFixture {
  events: Array<Record<string, unknown>>;
}

interface ResumeFixture {
  events: Array<Record<string, unknown>>;
  runInput: Record<string, unknown>;
}

function loadEventsFixture(name: string): EventsFixture {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), "utf8")) as EventsFixture;
}

function loadResumeFixture(name: string): ResumeFixture {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), "utf8")) as ResumeFixture;
}

function findRunFinished(events: Array<Record<string, unknown>>): RunFinishedEvent {
  const found = events.find(e => e["type"] === "RUN_FINISHED");
  if (!found) {
    throw new Error("fixture has no RUN_FINISHED event");
  }
  return found as unknown as RunFinishedEvent;
}

describe("parseRunOutcome — phase-1 fixtures", () => {
  it("BuiltInAgent interrupt fixture: parses one interrupt keyed on id (RT-F5)", () => {
    const fixture = loadEventsFixture("run-finished-interrupt");
    const outcome = parseRunOutcome(findRunFinished(fixture.events));

    expect(outcome.kind).toBe("interrupt");
    if (outcome.kind !== "interrupt") {
      throw new Error("expected interrupt outcome");
    }
    expect(outcome.interrupts).toHaveLength(1);
    expect(outcome.interrupts[0]).toMatchObject({
      id: "call-approve-1",
      message: "Approve deleteAccount for u1?",
      reason: "approval_required",
      toolCallId: "call-approve-1"
    });
  });

  it("non-BuiltInAgent interrupt fixture: id !== toolCallId, toolCallId absent (RT-F5)", () => {
    const fixture = loadEventsFixture("run-finished-interrupt-non-builtin");
    const outcome = parseRunOutcome(findRunFinished(fixture.events));

    expect(outcome.kind).toBe("interrupt");
    if (outcome.kind !== "interrupt") {
      throw new Error("expected interrupt outcome");
    }
    expect(outcome.interrupts).toHaveLength(1);
    expect(outcome.interrupts[0]?.id).toBe("int-abc");
    expect(outcome.interrupts[0]?.reason).toBe("approval_required");
    expect(outcome.interrupts[0]?.toolCallId).toBeUndefined();
  });

  it("success-no-outcome fixture: undefined outcome resolves to success (RT-F11)", () => {
    const fixture = loadEventsFixture("run-finished-success-no-outcome");
    const event = findRunFinished(fixture.events);
    expect(event.outcome).toBeUndefined();

    expect(parseRunOutcome(event)).toEqual({ kind: "success" });
  });

  it("resume fixture: RUN_FINISHED outcome {type:'success'} resolves to success", () => {
    const fixture = loadResumeFixture("run-finished-resume");
    expect(parseRunOutcome(findRunFinished(fixture.events))).toEqual({ kind: "success" });
  });
});

describe("parseRunOutcome — guards", () => {
  it("treats a null outcome as success (AG-UI schema allows nullable, not just optional)", () => {
    const event = { outcome: null } as unknown as Pick<RunFinishedEvent, "outcome">;
    expect(parseRunOutcome(event)).toEqual({ kind: "success" });
  });

  it("treats an explicit {type:'success'} outcome as success", () => {
    const event = { outcome: { type: "success" } } as unknown as Pick<RunFinishedEvent, "outcome">;
    expect(parseRunOutcome(event)).toEqual({ kind: "success" });
  });

  it("redacts an interrupt's responseSchema via the shared lifecycle-redaction util", () => {
    const event = {
      outcome: {
        interrupts: [
          {
            id: "int-1",
            reason: "approval_required",
            responseSchema: { properties: { apiKey: { type: "string" } }, type: "object" }
          }
        ],
        type: "interrupt"
      }
    } as unknown as Pick<RunFinishedEvent, "outcome">;

    const outcome = parseRunOutcome(event, ["$..apiKey"]);
    if (outcome.kind !== "interrupt") {
      throw new Error("expected interrupt outcome");
    }
    const schema = outcome.interrupts[0]?.responseSchema as
      | { properties?: { apiKey?: unknown } }
      | undefined;
    expect(schema?.properties?.apiKey).toBe("[REDACTED]");
  });

  it("omits responseSchema entirely when the interrupt does not carry one", () => {
    const event = {
      outcome: {
        interrupts: [{ id: "int-1", reason: "approval_required" }],
        type: "interrupt"
      }
    } as unknown as Pick<RunFinishedEvent, "outcome">;

    const outcome = parseRunOutcome(event);
    if (outcome.kind !== "interrupt") {
      throw new Error("expected interrupt outcome");
    }
    expect("responseSchema" in outcome.interrupts[0]!).toBe(false);
  });
});

describe("parseResumeEntries", () => {
  it("parses forwardedProps.resume off the resume fixture's runInput", () => {
    const fixture = loadResumeFixture("run-finished-resume");
    const entries = parseResumeEntries(
      fixture.runInput as unknown as Pick<RunAgentInput, "forwardedProps">
    );

    expect(entries).toEqual([
      { interruptId: "call-approve-1", payload: { approved: true }, status: "resolved" }
    ]);
  });

  it("returns [] when forwardedProps has no resume array", () => {
    expect(parseResumeEntries({ forwardedProps: {} })).toEqual([]);
    expect(parseResumeEntries({ forwardedProps: undefined })).toEqual([]);
    expect(parseResumeEntries({ forwardedProps: null })).toEqual([]);
  });

  it("drops malformed resume entries instead of throwing (fail-safe parse)", () => {
    const entries = parseResumeEntries({
      forwardedProps: {
        resume: [
          { interruptId: "ok-1", status: "resolved" },
          { interruptId: 123, status: "resolved" },
          { interruptId: "ok-2", status: "not-a-real-status" },
          "not-an-object",
          { status: "cancelled" }
        ]
      }
    });

    expect(entries).toEqual([{ interruptId: "ok-1", status: "resolved" }]);
  });

  it("preserves an omitted payload rather than a key with an explicit undefined value", () => {
    const entries = parseResumeEntries({
      forwardedProps: { resume: [{ interruptId: "call-1", status: "cancelled" }] }
    });

    expect(entries).toHaveLength(1);
    expect("payload" in entries[0]!).toBe(false);
  });
});
