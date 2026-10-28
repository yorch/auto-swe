/**
 * A counting semaphore with a bounded wait queue, for the registry proxy's buffered fetches.
 *
 * `acquire()` resolves to a release function, or to `null` when the caller must give up: the
 * queue is full, the wait lasted `waitMs`, or the semaphore was closed. Nothing waits without
 * a bound, so a burst of large packument requests costs a 503 for the surplus, not memory.
 */
export class Semaphore {
  private free: number;
  private closed = false;
  private readonly waiters: Array<{
    resolve: (release: (() => void) | null) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(
    limit: number,
    private readonly maxQueue: number,
    private readonly waitMs: number
  ) {
    this.free = limit;
  }

  acquire(): Promise<(() => void) | null> {
    if (this.closed) {
      return Promise.resolve(null);
    }
    if (this.free > 0) {
      this.free--;
      return Promise.resolve(this.releaser());
    }
    if (this.waiters.length >= this.maxQueue) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const at = this.waiters.indexOf(waiter);
          if (at >= 0) {
            this.waiters.splice(at, 1);
          }
          resolve(null);
        }, this.waitMs),
      };
      waiter.timer.unref();
      this.waiters.push(waiter);
    });
  }

  /** Turns every waiter away and refuses later callers; permits already held are unaffected. */
  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // The permit passes straight to the next waiter.
        clearTimeout(next.timer);
        next.resolve(this.releaser());
      } else {
        this.free++;
      }
    };
  }
}
