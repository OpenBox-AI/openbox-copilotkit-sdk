import type { ErrorInfo, JsonValue } from "@openbox-ai/openbox-sdk-ts";

import type { MultiAgentEventFields } from "./lifecycle-event-inputs.js";

/**
 * JSON-safety, `extra`-field, and `ErrorInfo` conversion helpers shared by the
 * builders in `lifecycle-events.ts`. `serializeOrNull` is also imported by
 * the still-hand-built hook-span path in `openbox-emitter.ts` (unmigrated —
 * see its own deferral note) so that path keeps identical `activity_input`
 * semantics without duplicating this helper.
 */

/**
 * Convert the adapter's loose `error` record into the base `ErrorInfo` shape
 * Core requires on the wire (`{type, message, ...}` — never a bare string).
 * `type` prefers an explicit `type`, then JS `Error#name`, then a string
 * `code` (the shape `RUN_ERROR` AG-UI events carry); `message` falls back to
 * a generic string. The two REQUIRED fields are therefore always present.
 * Every other key already on the input (e.g. `code`, `name`) passes through
 * unchanged so existing readers of `payload.error` keep working.
 */
export function toErrorInfo(error: Record<string, unknown>): ErrorInfo {
  const type =
    firstNonEmptyString(error["type"]) ??
    firstNonEmptyString(error["name"]) ??
    firstNonEmptyString(error["code"]) ??
    "Error";
  const message = firstNonEmptyString(error["message"]) ?? "Unknown error";

  return {
    ...(safeSerialize(error) as Record<string, JsonValue>),
    type,
    message
  };
}

/**
 * `undefined` -> `null` (the field's wire key always appears, matching the
 * adapter's pre-migration helpers); otherwise a JSON-safe clone.
 */
export function serializeOrNull(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }
  return safeSerialize(value) as JsonValue;
}

/**
 * Multi-agent mode emits array-shaped signal args (`[value]`) for the
 * OpenBox timeline; standalone mode keeps the legacy `{ value }` wrapper.
 */
export function serializeSignalArgs(value: unknown, asArray: boolean): JsonValue {
  const serialized: JsonValue =
    value === undefined || value === null
      ? null
      : (safeSerialize(value) as JsonValue);
  return asArray ? [serialized] : { value: serialized };
}

/** `metadata`, omitted when unset — matches the adapter's pre-migration truthy guard. */
export function metadataExtra(
  metadata: Record<string, unknown> | undefined
): Record<string, JsonValue> {
  return metadata ? { metadata: safeSerialize(metadata) as JsonValue } : {};
}

/** `parent_workflow_id`, omitted when unset (multi-agent child-workflow linkage). */
export function parentWorkflowIdExtra(
  input: Pick<MultiAgentEventFields, "parentWorkflowId">
): Record<string, JsonValue> {
  return input.parentWorkflowId
    ? { parent_workflow_id: input.parentWorkflowId }
    : {};
}

/** Omits the key entirely when unset (never writes an explicit `undefined`). */
export function multiAgentSessionIdOption(
  multiAgentSessionId: string | undefined
): { multiAgentSessionId: string } | Record<string, never> {
  return multiAgentSessionId ? { multiAgentSessionId } : {};
}

/** `undefined`/empty string -> `undefined` (caller falls back); a real string passes through. */
function firstNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Best-effort structural clone to a JSON-safe value. Falls back to a JSON
 * round-trip, then a stringified type tag, so an exotic/circular value never
 * throws while an envelope is being built.
 */
function safeSerialize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value)) as unknown;
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
}
