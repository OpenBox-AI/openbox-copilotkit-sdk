/**
 * Semantic-type vocabulary shared across OpenBox SDKs. Locked at the
 * boundary-of-responsibility review (2026-06-29):
 *
 *   - `function_call`  → owned by openbox-copilotkit-sdk (this SDK); emitted
 *     at the AG-UI middleware seam for every `TOOL_CALL_*` triple.
 *   - `llm_completion` → owned by openbox-mastra-sdk; emitted at the Vercel
 *     AI SDK model boundary via `createSyntheticModelUsageSpan`. NOT emitted
 *     here.
 *   - `internal`       → default for spans the synthesizer can't classify.
 *
 * Constant strings, not an enum — they cross repo boundaries by convention
 * (parity by string, not shared code), matching the idempotency-key formula
 * model in `audit/idempotency-key.ts`.
 */
export const SEMANTIC_TYPE_FUNCTION_CALL = "function_call" as const;
export const SEMANTIC_TYPE_LLM_COMPLETION = "llm_completion" as const;
export const SEMANTIC_TYPE_INTERNAL = "internal" as const;

export type SemanticType =
  | typeof SEMANTIC_TYPE_FUNCTION_CALL
  | typeof SEMANTIC_TYPE_INTERNAL
  | typeof SEMANTIC_TYPE_LLM_COMPLETION;

/**
 * Attribute key under which the semantic-type lives on each `SpanData`.
 * Aligned with Core's auto-classification reader.
 */
export const SEMANTIC_TYPE_ATTR = "openbox.semantic_type" as const;

/**
 * Marker attribute the AG-UI middleware sets so a downstream emitter can
 * skip a span the synthesizer already produced (de-duplication guard from
 * Phase 2 risk row).
 */
export const SYNTHESIZER_ATTR = "openbox.synthesizer" as const;
export const TOOL_SPAN_SYNTHESIZER_NAME = "tool-span-synthesizer" as const;
