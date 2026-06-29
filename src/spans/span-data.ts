/**
 * SDK-local span shape. Mirrors common OTel attribute-value constraints but
 * has no OpenTelemetry import — the drop-OTel ship gate (0.2.0-beta.0)
 * removed that coupling, and Phase 2 does not revive it. Spans land in a
 * `SpanBuffer` and are drained by consumers (tests + the example demo's
 * gated debug route in Phase 3).
 */
export type AttrValue =
  | boolean
  | boolean[]
  | number
  | number[]
  | string
  | string[];

export interface SpanEvent {
  attributes?: Record<string, AttrValue>;
  name: string;
  time_unix_nano: bigint;
}

export interface SpanData {
  attributes: Record<string, AttrValue>;
  end_time_unix_nano: bigint;
  events?: SpanEvent[];
  name: string;
  parent_span_id?: string;
  span_id: string;
  start_time_unix_nano: bigint;
  status: "ok" | "error";
  trace_id: string;
}
