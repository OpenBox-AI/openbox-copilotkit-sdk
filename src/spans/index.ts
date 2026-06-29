export type { AttrValue, SpanData, SpanEvent } from "./span-data.js";

export type {
  EvictionEvent,
  OverflowEvent,
  SpanBufferOptions
} from "./span-buffer.js";
export {
  DEFAULT_MAX_PER_WORKFLOW,
  DEFAULT_TTL_MS,
  readSpanBufferEnv,
  SpanBuffer
} from "./span-buffer.js";

export type {
  SynthOpts,
  ToolCallArgsEventLike,
  ToolCallEndEventLike,
  ToolCallStartEventLike,
  ToolCallTriple
} from "./tool-span-synthesizer.js";
export { synthesizeToolSpan } from "./tool-span-synthesizer.js";

export type { SemanticType } from "./semantic-types.js";
export {
  SEMANTIC_TYPE_ATTR,
  SEMANTIC_TYPE_FUNCTION_CALL,
  SEMANTIC_TYPE_INTERNAL,
  SEMANTIC_TYPE_LLM_COMPLETION,
  SYNTHESIZER_ATTR,
  TOOL_SPAN_SYNTHESIZER_NAME
} from "./semantic-types.js";
