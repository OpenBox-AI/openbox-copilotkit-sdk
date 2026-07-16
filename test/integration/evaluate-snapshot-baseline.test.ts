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
 * INVERTED (Phase 3b — defect B4 FIXED; was FROZEN as the buggy baseline in
 * Phase 1). The 0.3.0 middleware forwarded each AG-UI event to the user
 * stream only *after* awaiting that event's `client.evaluate()`, serially
 * (the `pendingHandling` chain in `#processStream`) — a slow or hung Core
 * throttled the user-visible stream even in telemetry-only mode.
 *
 * Phase 3b's bounded, non-blocking telemetry queue (`lifecycle-telemetry.ts`)
 * fixes this: the five pure-telemetry emitter methods enqueue and return
 * before `client.evaluate` settles, so `#processStream` forwards every AG-UI
 * event regardless of Core's latency. This test DEFERS THE FIRST EVALUATE
 * (RUN_STARTED's WorkflowStarted) FOREVER — it is never resolved for the
 * remainder of the test — and asserts every event still reaches the
 * subscriber and the stream still completes. This is a real assertion, not a
 * relaxed one: were forwarding still gated on Core (the old bug), `forwarded`
 * would stay empty and `completed` would stay false, exactly as the frozen
 * baseline this test replaces used to assert.
 */
describe("telemetry ordering fixed (defect B4)", () => {
  it("forwards every AG-UI event and completes the stream without the deferred evaluate ever resolving", async () => {
    const deferredEvaluate = defer<null>();
    let calls = 0;
    const evaluateMock = vi.fn().mockImplementation(() => {
      calls += 1;
      // Only the FIRST evaluate (RUN_STARTED's WorkflowStarted) is deferred;
      // every other telemetry send resolves immediately.
      return calls === 1 ? deferredEvaluate.promise : Promise.resolve(null);
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

    // Wait for the stream's OWN completion signal — never for the deferred
    // evaluate (this test never resolves it). AG-UI's own `runNextWithState`
    // paces each event through its own `setTimeout(0)` hop independent of
    // anything here, so a fixed microtask/macrotask count can't stand in for
    // this; only the real signal proves the point. If forwarding/completion
    // were still gated on Core (the B4 bug), this would hang instead of
    // resolving (the deferred evaluate never settles for the test's duration).
    await done.promise;

    // B4 FIXED: the whole run forwarded and completed WITHOUT the first
    // evaluate ever resolving.
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(completed).toBe(true);
    expect(forwarded.map(e => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED
    ]);

    subscription.unsubscribe();
    // Release the deferred evaluate so nothing lingers past the test.
    deferredEvaluate.resolve(null);
  });
});
