/**
 * A minimal counting semaphore. Used by `lifecycle-telemetry.ts` to bound
 * cross-run concurrency (`maxConcurrentSends`) without serializing unrelated
 * runs behind one another — a run's own FIFO chain only ever holds ONE
 * permit at a time; different runs each acquire their own.
 */
export class Semaphore {
  #permits: number;
  readonly #waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.#permits = permits;
  }

  /** Resolves immediately if a permit is free; otherwise waits until `release()` hands one over. */
  acquire(): Promise<void> {
    if (this.#permits > 0) {
      this.#permits -= 1;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.#waiters.push(resolve);
    });
  }

  /** Return a permit — handed directly to the oldest waiter, if any, rather than idly incrementing the count. */
  release(): void {
    const next = this.#waiters.shift();
    if (next) {
      next();
      return;
    }
    this.#permits += 1;
  }
}
