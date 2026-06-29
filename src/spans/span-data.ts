/**
 * SDK-local span shape. It mirrors common trace attribute-value constraints
 * without importing a tracing runtime.
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
