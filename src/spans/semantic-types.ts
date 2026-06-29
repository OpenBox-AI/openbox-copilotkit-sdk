/**
 * Semantic-type vocabulary for spans emitted by this SDK.
 *
 *   - `function_call` marks AG-UI tool-call spans.
 *   - `llm_completion` is reserved for model-completion spans.
 *   - `internal` is the default for spans the synthesizer cannot classify.
 */
export const SEMANTIC_TYPE_FUNCTION_CALL = "function_call" as const;
export const SEMANTIC_TYPE_LLM_COMPLETION = "llm_completion" as const;
export const SEMANTIC_TYPE_INTERNAL = "internal" as const;

export type SemanticType =
  | typeof SEMANTIC_TYPE_FUNCTION_CALL
  | typeof SEMANTIC_TYPE_INTERNAL
  | typeof SEMANTIC_TYPE_LLM_COMPLETION;

/** Attribute key under which the semantic type lives on each `SpanData`. */
export const SEMANTIC_TYPE_ATTR = "openbox.semantic_type" as const;

/** Marker attribute for spans produced by the tool-call synthesizer. */
export const SYNTHESIZER_ATTR = "openbox.synthesizer" as const;
export const TOOL_SPAN_SYNTHESIZER_NAME = "tool-span-synthesizer" as const;
