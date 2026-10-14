import { writeFileSync } from 'node:fs';

/**
 * The worker serves no HTTP, so the image's HEALTHCHECK reads this file's mtime
 * instead. Keep the path in step with the Dockerfile.
 */
export const LIVENESS_FILE = '/tmp/worker-alive';

/** How often the file is touched. The HEALTHCHECK tolerates two minutes of silence. */
export const LIVENESS_INTERVAL_MS = 10_000;

export interface LivenessOptions {
  /** Touch cadence in milliseconds. */
  intervalMs?: number;
  /** Whether the Temporal worker is still running; a stopped worker stops touching. */
  isRunning: () => boolean;
  /** Where to write; defaults to {@link LIVENESS_FILE}. */
  path?: string;
  /** Replaceable for tests. */
  touch?: (path: string) => void;
}

/**
 * Touch the liveness file now and then on a timer, but only while `isRunning()`
 * holds. A worker that hangs or stops polling stops refreshing it, and the
 * container is reported unhealthy. A failed write is swallowed: liveness is a
 * signal, never a reason to take the worker down. Returns the stop function.
 */
export function startLivenessFile(options: LivenessOptions): () => void {
  const path = options.path ?? LIVENESS_FILE;
  const touch = options.touch ?? ((p: string) => writeFileSync(p, String(Date.now())));
  const beat = () => {
    if (!options.isRunning()) {
      return;
    }
    try {
      touch(path);
    } catch (err) {
      console.warn('Worker liveness file write failed:', err);
    }
  };
  beat();
  const timer = setInterval(beat, options.intervalMs ?? LIVENESS_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
