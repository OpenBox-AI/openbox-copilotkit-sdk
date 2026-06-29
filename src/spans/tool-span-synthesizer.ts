import { createHash, randomBytes } from "node:crypto";

import {
  SEMANTIC_TYPE_ATTR,
  SEMANTIC_TYPE_FUNCTION_CALL,
  SYNTHESIZER_ATTR,
  TOOL_SPAN_SYNTHESIZER_NAME
} from "./semantic-types.js";
import type { AttrValue, SpanData } from "./span-data.js";

export interface ToolCallStartEventLike {
  toolCallId: string;
  toolCallName: string;
}

export interface ToolCallArgsEventLike {
  delta: string;
  toolCallId: string;
}

export interface ToolCallEndEventLike {
  result?: unknown;
  toolCallId: string;
}

export interface ToolCallTriple {
  activityId: string;
  args: ToolCallArgsEventLike[];
  attempt?: number;
  end: ToolCallEndEventLike;
  endTimeUnixNano: bigint;
  parentSpanId?: string;
  runId: string;
  start: ToolCallStartEventLike;
  startTimeUnixNano: bigint;
  traceId?: string;
  workflowId: string;
}

export interface SynthOpts {
  /** Override span id generator (tests use a deterministic stub). */
  genSpanId?: () => string;
  /** Override trace id generator when triple.traceId is absent. */
  genTraceId?: () => string;
  /** Treat the end event's result as an error span. */
  isError?: boolean;
  /**
   * JSONPath-like paths to redact from `tool.args_preview` and
   * `tool.result_preview`. Supports leaf forms `$..key` and `$.path.key`.
   */
  redactPaths?: string[];
}

const DEFAULT_PREVIEW_BYTES = 256;
const REDACTED_TOKEN = "[REDACTED]";

/**
 * Convert an AG-UI tool-call event triple into a synthesized `SpanData`.
 *
 * - `semantic_type` is always `function_call` (locked).
 * - `tool.args` is NOT stored raw — only `tool.args_hash` (sha256 hex) and a
 *   redacted, length-bounded `tool.args_preview` (<= 256 bytes).
 * - `tool.result_hash` + `tool.result_preview` mirror the args treatment when
 *   the end event carries a `result`.
 * - Span carries `openbox.synthesizer:"tool-span-synthesizer"` so downstream
 *   emitters can deduplicate.
 *
 * Pure given the triple — no buffer access, no logger calls. Append is the
 * middleware's responsibility.
 */
export function synthesizeToolSpan(
  triple: ToolCallTriple,
  opts: SynthOpts = {}
): SpanData {
  const argsJoined = triple.args.map(a => a.delta).join("");
  const argsParsed = tryParseJson(argsJoined);
  const argsHash = sha256Hex(argsJoined);
  const argsPreview = redactPreview(argsParsed ?? argsJoined, opts.redactPaths);

  const attributes: Record<string, AttrValue> = {
    [SEMANTIC_TYPE_ATTR]: SEMANTIC_TYPE_FUNCTION_CALL,
    [SYNTHESIZER_ATTR]: TOOL_SPAN_SYNTHESIZER_NAME,
    "tool.args_hash": argsHash,
    "tool.args_preview": argsPreview,
    "tool.call_id": triple.start.toolCallId,
    "tool.duration_ms": computeDurationMs(
      triple.startTimeUnixNano,
      triple.endTimeUnixNano
    ),
    "tool.name": triple.start.toolCallName
  };

  if (triple.end.result !== undefined && triple.end.result !== null) {
    const resultJoined =
      typeof triple.end.result === "string"
        ? triple.end.result
        : JSON.stringify(triple.end.result);
    attributes["tool.result_hash"] = sha256Hex(resultJoined);
    attributes["tool.result_preview"] = redactPreview(
      triple.end.result,
      opts.redactPaths
    );
  }

  const span: SpanData = {
    attributes,
    end_time_unix_nano: triple.endTimeUnixNano,
    name: `tool:${triple.start.toolCallName}`,
    span_id: opts.genSpanId ? opts.genSpanId() : randomSpanId(),
    start_time_unix_nano: triple.startTimeUnixNano,
    status: opts.isError ? "error" : "ok",
    trace_id:
      triple.traceId ?? (opts.genTraceId ? opts.genTraceId() : randomTraceId())
  };
  if (triple.parentSpanId) {
    span.parent_span_id = triple.parentSpanId;
  }
  return span;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tryParseJson(raw: string): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function redactPreview(
  value: unknown,
  redactPaths: string[] | undefined
): string {
  let working: unknown = value;
  if (
    typeof working === "object" &&
    working !== null &&
    redactPaths &&
    redactPaths.length > 0
  ) {
    working = structuredCloneSafe(working);
    for (const path of redactPaths) {
      applyRedaction(working, path);
    }
  }
  const serialized =
    typeof working === "string" ? working : JSON.stringify(working) ?? "";
  return serialized.length > DEFAULT_PREVIEW_BYTES
    ? `${serialized.slice(0, DEFAULT_PREVIEW_BYTES - 1)}…`
    : serialized;
}

function structuredCloneSafe(value: object): object {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as object;
  }
}

/**
 * Minimal JSONPath-leaf redactor. Supports two shapes used by the
 * recommended `redactPaths` defaults (`["$..password", "$..secret",
 * "$..token", "$..apiKey"]` from README/MIGRATION):
 *
 *  - `$..<key>`     → redact every leaf key with that name, at any depth.
 *  - `$.a.b.<key>`  → redact a fixed dotted path.
 *
 * Everything else is ignored; this intentionally avoids pulling in a full
 * JSONPath engine.
 */
function applyRedaction(target: unknown, path: string): void {
  if (typeof target !== "object" || target === null) {
    return;
  }
  if (path.startsWith("$..")) {
    const key = path.slice(3);
    redactKeyDeep(target, key);
    return;
  }
  if (path.startsWith("$.")) {
    const segments = path.slice(2).split(".").filter(Boolean);
    if (segments.length === 0) {
      return;
    }
    redactSegments(target, segments);
  }
}

function redactKeyDeep(target: unknown, key: string): void {
  if (Array.isArray(target)) {
    for (const item of target) {
      redactKeyDeep(item, key);
    }
    return;
  }
  if (typeof target !== "object" || target === null) {
    return;
  }
  const record = target as Record<string, unknown>;
  for (const k of Object.keys(record)) {
    if (k === key) {
      record[k] = REDACTED_TOKEN;
    } else {
      redactKeyDeep(record[k], key);
    }
  }
}

function redactSegments(target: unknown, segments: string[]): void {
  if (typeof target !== "object" || target === null) {
    return;
  }
  const record = target as Record<string, unknown>;
  const [head, ...rest] = segments;
  if (head === undefined) {
    return;
  }
  if (rest.length === 0) {
    if (head in record) {
      record[head] = REDACTED_TOKEN;
    }
    return;
  }
  redactSegments(record[head], rest);
}

function computeDurationMs(start: bigint, end: bigint): number {
  if (end <= start) {
    return 0;
  }
  const diffNs = end - start;
  return Number(diffNs / 1_000_000n);
}

function randomTraceId(): string {
  return randomBytes(16).toString("hex");
}

function randomSpanId(): string {
  return randomBytes(8).toString("hex");
}
