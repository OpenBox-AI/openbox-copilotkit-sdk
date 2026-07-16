import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, it, vi } from "vitest";

import { createOpenBoxMiddleware } from "../../src/copilotkit/openbox-middleware.js";

import {
  ScriptedAgent,
  buildController,
  buildRunAgentInput,
  collectEvents
} from "../unit/copilotkit/test-utils.js";

function flushMacrotask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

const SNAPSHOT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/evaluate-payloads-baseline.jsonl"
);

const STRIPPED_KEYS = new Set([
  "timestamp",
  "start_time",
  "end_time",
  "duration_ms",
  "activity_id",
  "metadata"
]);

function canonicalize(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    if (STRIPPED_KEYS.has(key)) {
      continue;
    }
    out[key] = payload[key];
  }
  return out;
}

const canonicalTextRun: BaseEvent[] = [
  {
    messageId: "msg-out-1",
    role: "assistant",
    type: EventType.TEXT_MESSAGE_START
  } as BaseEvent,
  {
    delta: "Hello",
    messageId: "msg-out-1",
    type: EventType.TEXT_MESSAGE_CONTENT
  } as BaseEvent,
  {
    delta: " world",
    messageId: "msg-out-1",
    type: EventType.TEXT_MESSAGE_CONTENT
  } as BaseEvent,
  {
    messageId: "msg-out-1",
    type: EventType.TEXT_MESSAGE_END
  } as BaseEvent,
  { type: EventType.RUN_FINISHED } as BaseEvent
];

const canonicalToolCallRun: BaseEvent[] = [
  {
    toolCallId: "call-1",
    toolCallName: "setThemeColor",
    type: EventType.TOOL_CALL_START
  } as BaseEvent,
  {
    delta: '{"color":"blue"}',
    toolCallId: "call-1",
    type: EventType.TOOL_CALL_ARGS
  } as BaseEvent,
  { toolCallId: "call-1", type: EventType.TOOL_CALL_END } as BaseEvent,
  {
    content: '{"ok":true}',
    toolCallId: "call-1",
    type: "TOOL_CALL_RESULT"
  } as BaseEvent,
  { type: EventType.RUN_FINISHED } as BaseEvent
];

async function recordPayloads(events: BaseEvent[]): Promise<Record<string, unknown>[]> {
  const { controller, evaluateMock } = buildController();
  const middleware = createOpenBoxMiddleware(controller, {
    frontendToolNames: ["setThemeColor"]
  });
  const agent = new ScriptedAgent({ events });
  await collectEvents(middleware.run(buildRunAgentInput(), agent));
  return evaluateMock.mock.calls.map(args => args[0] as Record<string, unknown>);
}

describe("evaluate() payload baseline", () => {
  it("text-only + frontend-tool-call canonical sequence matches snapshot", async () => {
    const textPayloads = await recordPayloads(canonicalTextRun);
    const toolPayloads = await recordPayloads(canonicalToolCallRun);
    const all = [...textPayloads, ...toolPayloads].map(canonicalize);
    const serialized = all.map(p => JSON.stringify(p)).join("\n") + "\n";

    if (!existsSync(SNAPSHOT_PATH)) {
      mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
      writeFileSync(SNAPSHOT_PATH, serialized, "utf8");
      throw new Error(
        `Snapshot generated at ${SNAPSHOT_PATH}. Review and re-run the test to confirm.`
      );
    }

    const expected = readFileSync(SNAPSHOT_PATH, "utf8");
    expect(serialized).toBe(expected);
  });
});

/**
 * FREEZE (Phase 1 — defect B4). The 0.3.0 middleware forwards each AG-UI event
 * to the user stream only *after* awaiting that event's `client.evaluate()`,
 * and serially (the `pendingHandling` chain in `#processStream`). So a slow or
 * hung Core throttles the user-visible stream even in telemetry-only mode.
 *
 * This test blocks the FIRST evaluate (RUN_STARTED's WorkflowStarted) and shows
 * the entire downstream stream stalls — no events reach the subscriber until
 * evaluate resolves. Phase 3 INVERTS this: a bounded non-blocking telemetry
 * queue forwards events without awaiting Core.
 */
describe("telemetry ordering baseline (defect B4, frozen)", () => {
  it("does not forward ANY AG-UI event until the in-flight evaluate resolves", async () => {
    const firstEvaluate = defer<null>();
    let calls = 0;
    const evaluateMock = vi.fn().mockImplementation(() => {
      calls += 1;
      return calls === 1 ? firstEvaluate.promise : Promise.resolve(null);
    });

    const { controller } = buildController({ evaluateMock });
    const middleware = createOpenBoxMiddleware(controller, { frontendToolNames: [] });
    const agent = new ScriptedAgent({ events: canonicalTextRun });

    const forwarded: BaseEvent[] = [];
    let completed = false;
    const done = defer<void>();
    const subscription = middleware.run(buildRunAgentInput(), agent).subscribe({
      complete: () => {
        completed = true;
        done.resolve();
      },
      error: () => done.resolve(),
      next: event => {
        forwarded.push(event);
      }
    });

    // Let all microtasks drain while the first evaluate is still pending.
    await flushMacrotask();

    // BUG B4: the stream is blocked on telemetry — nothing forwarded yet.
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(forwarded).toHaveLength(0);
    expect(completed).toBe(false);
    // PHASE-3 WILL INVERT: telemetry-only mode forwards events without awaiting Core.

    // Release Core; the whole serial chain now drains to completion.
    firstEvaluate.resolve(null);
    await done.promise;

    expect(forwarded.length).toBeGreaterThan(0);
    expect(completed).toBe(true);
    subscription.unsubscribe();
  });
});
