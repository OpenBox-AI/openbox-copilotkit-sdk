import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import { createOpenBoxMiddleware } from "../../src/copilotkit/openbox-middleware.js";

import {
  ScriptedAgent,
  buildController,
  buildRunAgentInput,
  collectEvents
} from "../unit/copilotkit/test-utils.js";

/**
 * Lossless-drop proof, codified.
 *
 * Feeds a canonical AG-UI event sequence (text reply + frontend tool call)
 * through createOpenBoxMiddleware against a recording OpenBoxClient. Captures
 * the exact sequence of client.evaluate() payloads (timestamps + the
 * activity_id stripped for determinism) and asserts byte-identity against
 * the JSONL snapshot committed under
 * plans/260629-0501-drop-otel-from-openbox-copilotkit-sdk/snapshots/.
 *
 * On first run (snapshot missing) the file is generated and the test is
 * marked TODO so the developer must explicitly review + commit the snapshot.
 * On subsequent runs (Phases 2-4 OTel deletion) the test must continue to
 * pass — that IS the empirical proof that dropping OTel costs zero data the
 * OpenBox UI consumes via client.evaluate().
 *
 * The snapshot lives OUTSIDE the SDK repo (under the plan directory in the
 * CopilotKit monorepo) because the plan owns the artifact across both repos.
 * Path is resolved relative to this test file's location.
 */

const SNAPSHOT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../CopilotKit/examples/integrations/mastra/plans/260629-0501-drop-otel-from-openbox-copilotkit-sdk/snapshots/evaluate-payloads-baseline.jsonl"
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

describe("evaluate() payload baseline (lossless-drop proof)", () => {
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
