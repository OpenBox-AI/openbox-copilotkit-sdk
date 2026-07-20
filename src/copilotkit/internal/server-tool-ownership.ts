const KEY_SEPARATOR = "::";

/**
 * Run-scoped registry recording which `(runId, toolCallId)` pairs a wrapped
 * `serverTool()` (Phase 5) has claimed for governance evaluation.
 *
 * The AG-UI observer (middleware) checks `isOwned` before emitting a
 * duplicate OpenBox activity for a tool call the wrapper already governs.
 * Ownership keys on the `(runId, toolCallId)` tuple — NEVER on tool name
 * (RT-F5/RT-F15): two concurrent runs that happen to reuse the same
 * `toolCallId` must not collide, and a name collision must not over-suppress
 * observation-only telemetry for an unrelated call.
 */
export class ServerToolOwnershipRegistry {
  readonly #claimed = new Map<string, true>();
  // Keys grouped per run so `releaseRun` drops every entry for a finished run
  // without scanning the whole map.
  readonly #keysByRun = new Map<string, Set<string>>();

  /** Claim ownership of `(runId, toolCallId)`. Idempotent. */
  claim(runId: string, toolCallId: string): void {
    const key = ServerToolOwnershipRegistry.#key(runId, toolCallId);
    this.#claimed.set(key, true);

    let keysForRun = this.#keysByRun.get(runId);
    if (!keysForRun) {
      keysForRun = new Set();
      this.#keysByRun.set(runId, keysForRun);
    }
    keysForRun.add(key);
  }

  /** Whether `(runId, toolCallId)` is currently claimed by a wrapped server tool. */
  isOwned(runId: string, toolCallId: string): boolean {
    return this.#claimed.has(ServerToolOwnershipRegistry.#key(runId, toolCallId));
  }

  /** Release a single `(runId, toolCallId)` claim (an activity's terminal/error path). */
  release(runId: string, toolCallId: string): void {
    const key = ServerToolOwnershipRegistry.#key(runId, toolCallId);
    this.#claimed.delete(key);
    this.#keysByRun.get(runId)?.delete(key);
  }

  /** Release every claim for `runId` (run teardown) — bounds the registry on a long-lived process. */
  releaseRun(runId: string): void {
    const keysForRun = this.#keysByRun.get(runId);
    if (!keysForRun) {
      return;
    }
    for (const key of keysForRun) {
      this.#claimed.delete(key);
    }
    this.#keysByRun.delete(runId);
  }

  static #key(runId: string, toolCallId: string): string {
    return `${runId}${KEY_SEPARATOR}${toolCallId}`;
  }
}
