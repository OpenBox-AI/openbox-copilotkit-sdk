import type { SpanData } from "./span-data.js";

export const DEFAULT_MAX_PER_WORKFLOW = 1000;
export const DEFAULT_TTL_MS = 300_000;
const DEFAULT_EVICTION_INTERVAL_DIVISOR = 2;

interface WorkflowEntry {
  lastTouchedAt: number;
  spans: SpanData[];
}

export interface OverflowEvent {
  dropped: SpanData;
  workflowId: string;
}

export interface EvictionEvent {
  evictedCount: number;
  workflowId: string;
}

export interface SpanBufferOptions {
  clock?: () => number;
  maxPerWorkflow?: number;
  onEvict?: (event: EvictionEvent) => void;
  onOverflow?: (event: OverflowEvent) => void;
  ttlMs?: number;
}

/**
 * Bounded, per-workflow span buffer with TTL eviction.
 *
 * - Memory bound: `maxPerWorkflow × activeWorkflows × avgSpanSize`.
 * - TTL eviction runs on a `setInterval` keyed at TTL/2; the interval is
 *   `unref()`'d so it never blocks process exit (Next.js / Vercel cold
 *   restart safety).
 * - On per-workflow cap overflow, the oldest span is dropped and the
 *   `onOverflow` callback fires — call sites translate this into a
 *   `late_detection` audit-envelope status (see `attachAuditEnvelope`).
 *
 * NOT an OTel SpanProcessor and has no OpenTelemetry import. Plain
 * `Map<workflowId, WorkflowEntry>` under the hood; FIFO array per workflow
 * (`shift()` is O(n) but `n ≤ cap`, accepted in property test).
 */
export class SpanBuffer {
  readonly #buckets = new Map<string, WorkflowEntry>();
  readonly #clock: () => number;
  readonly #maxPerWorkflow: number;
  readonly #onEvict: SpanBufferOptions["onEvict"];
  readonly #onOverflow: SpanBufferOptions["onOverflow"];
  readonly #ttlMs: number;
  #evictionTimer: ReturnType<typeof setInterval> | null = null;

  public constructor(opts: SpanBufferOptions = {}) {
    this.#maxPerWorkflow =
      opts.maxPerWorkflow !== undefined && opts.maxPerWorkflow > 0
        ? opts.maxPerWorkflow
        : DEFAULT_MAX_PER_WORKFLOW;
    this.#ttlMs =
      opts.ttlMs !== undefined && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    this.#clock = opts.clock ?? Date.now;
    this.#onEvict = opts.onEvict;
    this.#onOverflow = opts.onOverflow;
  }

  public append(workflowId: string, span: SpanData): void {
    const now = this.#clock();
    let entry = this.#buckets.get(workflowId);
    if (!entry) {
      entry = { lastTouchedAt: now, spans: [] };
      this.#buckets.set(workflowId, entry);
    }
    entry.spans.push(span);
    entry.lastTouchedAt = now;

    while (entry.spans.length > this.#maxPerWorkflow) {
      const dropped = entry.spans.shift();
      if (dropped && this.#onOverflow) {
        this.#onOverflow({ dropped, workflowId });
      }
    }
  }

  public flush(workflowId: string): SpanData[] {
    const entry = this.#buckets.get(workflowId);
    if (!entry) {
      return [];
    }
    const spans = entry.spans;
    this.#buckets.delete(workflowId);
    return spans;
  }

  public drain(): Map<string, SpanData[]> {
    const out = new Map<string, SpanData[]>();
    for (const [workflowId, entry] of this.#buckets) {
      out.set(workflowId, entry.spans);
    }
    this.#buckets.clear();
    return out;
  }

  public peek(workflowId: string): readonly SpanData[] {
    return this.#buckets.get(workflowId)?.spans ?? [];
  }

  public size(workflowId: string): number {
    return this.#buckets.get(workflowId)?.spans.length ?? 0;
  }

  public workflowCount(): number {
    return this.#buckets.size;
  }

  public evictExpired(): { evicted: number; workflows: string[] } {
    const now = this.#clock();
    const workflows: string[] = [];
    let evicted = 0;
    for (const [workflowId, entry] of this.#buckets) {
      if (now - entry.lastTouchedAt < this.#ttlMs) {
        continue;
      }
      const count = entry.spans.length;
      evicted += count;
      workflows.push(workflowId);
      this.#buckets.delete(workflowId);
      this.#onEvict?.({ evictedCount: count, workflowId });
    }
    return { evicted, workflows };
  }

  public startEvictionTimer(): void {
    if (this.#evictionTimer) {
      return;
    }
    const intervalMs = Math.max(
      1,
      Math.floor(this.#ttlMs / DEFAULT_EVICTION_INTERVAL_DIVISOR)
    );
    this.#evictionTimer = setInterval(() => {
      this.evictExpired();
    }, intervalMs);
    if (typeof this.#evictionTimer.unref === "function") {
      this.#evictionTimer.unref();
    }
  }

  public shutdown(): void {
    if (this.#evictionTimer) {
      clearInterval(this.#evictionTimer);
      this.#evictionTimer = null;
    }
    this.#buckets.clear();
  }
}

/**
 * Read SpanBuffer-related env knobs. Centralized so SDK integrations can
 * share the same parsing defaults.
 *
 *  - `OPENBOX_SPAN_BUFFER_MAX_PER_WORKFLOW` (default 1000)
 *  - `OPENBOX_SPAN_BUFFER_TTL_MS`            (default 300000)
 *  - `OPENBOX_DISABLE_SPAN_BUFFER=1`         emergency bypass for the AG-UI
 *    middleware seam — when set, the synthesizer is skipped entirely
 */
export function readSpanBufferEnv(
  env: NodeJS.ProcessEnv = process.env
): { disabled: boolean; maxPerWorkflow: number; ttlMs: number } {
  return {
    disabled: env["OPENBOX_DISABLE_SPAN_BUFFER"] === "1",
    maxPerWorkflow: parsePositiveInt(
      env["OPENBOX_SPAN_BUFFER_MAX_PER_WORKFLOW"],
      DEFAULT_MAX_PER_WORKFLOW
    ),
    ttlMs: parsePositiveInt(
      env["OPENBOX_SPAN_BUFFER_TTL_MS"],
      DEFAULT_TTL_MS
    )
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return fallback;
  }
  return n;
}
