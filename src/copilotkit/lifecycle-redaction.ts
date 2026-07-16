import type { JsonValue } from "@openbox-ai/openbox-sdk-ts";

import {
  DEFAULT_MAX_FIELD_BYTES,
  truncateFieldIfOversized
} from "./lifecycle-telemetry-payload-bounds.js";

/**
 * RT-F2 (Critical): `redactPaths` (JSONPath-like `$..key` / `$.a.b.key`) is
 * NOT the same shape as the base gate's `PrivacyConfig.redactKeys` (a flat
 * key-NAME set, matched case-insensitively at any depth via
 * `serialization/index.ts#applyRedaction`). Passing `redactPaths` verbatim as
 * `redactKeys` is a silent no-op that leaks secrets. This module implements
 * BOTH halves of the fix:
 *
 *  1. `redactPathsToKeySet` translates every configured path to its LEAF key
 *     name, fed into the base gate's `redactKeys` (`openbox-emitter.ts` merges
 *     this into the `PrivacyConfig` passed to `prepareLifecyclePayload`) — a
 *     conservative, depth-agnostic safety net that also covers fields the
 *     adapter doesn't explicitly redact below (e.g. `metadata`).
 *  2. `redactAndBoundRawField` re-implements the adapter's own precise,
 *     path-scoped redactor (mirrors `spans/tool-span-synthesizer.ts`'s
 *     algorithm — duplicated rather than importing from it, since the
 *     hook-span path is out of scope for this phase) plus a size bound, and
 *     applies BOTH to a raw activity_input/activity_output/signal-args value
 *     BEFORE it reaches the base event factory. This closes the exposure
 *     migrating those fields onto base factories introduced: previously only
 *     a 256-byte preview + hash of tool args/results ever shipped; the base
 *     factories otherwise carry the full raw value. Applying this before the
 *     factory means it protects BOTH the enforcing (direct-evaluate) path and
 *     the telemetry-queue path identically, since only the queue path also
 *     gets the (looser, whole-envelope) `maxPayloadBytes` bound.
 */

const REDACTED_TOKEN = "[REDACTED]";

/** Leaf key name for `$..key` / `$.a.b.key`; `undefined` for an unsupported shape (ignored, matching the legacy span redactor). */
function leafKeyOf(path: string): string | undefined {
  if (path.startsWith("$..")) {
    return path.slice(3) || undefined;
  }
  if (path.startsWith("$.")) {
    const segments = path.slice(2).split(".").filter(Boolean);
    return segments.at(-1);
  }
  return undefined;
}

/** Translate configured `redactPaths` into the leaf key-name set the base gate's `redactKeys` expects. */
export function redactPathsToKeySet(redactPaths: readonly string[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const path of redactPaths ?? []) {
    const leaf = leafKeyOf(path);
    if (leaf) {
      keys.add(leaf);
    }
  }
  return keys;
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

function redactFixedPath(target: unknown, segments: readonly string[]): void {
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
  redactFixedPath(record[head], rest);
}

/** Apply every configured path redaction to `target` IN PLACE — caller must pass an already-owned clone. */
function applyPathRedactions(target: unknown, redactPaths: readonly string[]): void {
  if (typeof target !== "object" || target === null) {
    return;
  }
  for (const path of redactPaths) {
    if (path.startsWith("$..")) {
      const key = path.slice(3);
      if (key) {
        redactKeyDeep(target, key);
      }
    } else if (path.startsWith("$.")) {
      const segments = path.slice(2).split(".").filter(Boolean);
      if (segments.length > 0) {
        redactFixedPath(target, segments);
      }
    }
  }
}

/** JSON-safe clone, tolerating exotic/circular values the same way the lifecycle-event builders do. */
function cloneJsonSafe(value: unknown): unknown {
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

/**
 * Redact configured paths and bound the size of a raw field (activity args,
 * activity output, or signal payload) BEFORE it is handed to a base event
 * factory. `undefined` passes through unchanged so the factory's own
 * omission rule still applies; every other value is cloned (never mutates
 * the caller's object), path-redacted, and collapsed to a preview+hash
 * marker if it still exceeds `maxFieldBytes` afterward.
 */
export function redactAndBoundRawField(
  value: unknown,
  redactPaths: readonly string[] | undefined,
  maxFieldBytes: number = DEFAULT_MAX_FIELD_BYTES
): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  const cloned = cloneJsonSafe(value);
  if (redactPaths && redactPaths.length > 0) {
    applyPathRedactions(cloned, redactPaths);
  }
  const { value: bounded } = truncateFieldIfOversized(cloned as JsonValue, maxFieldBytes);
  return bounded;
}
