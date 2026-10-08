/**
 * The per-client request limit, read once at boot from the environment.
 *
 * - `RATE_LIMIT_MAX` — requests allowed per window (default 200)
 * - `RATE_LIMIT_WINDOW_SECONDS` — window length in seconds (default 60)
 *
 * Raise them for an end-to-end suite that drives one signed-in user through
 * many page loads. A value that is not a positive integer is a failed boot:
 * silently falling back to the default would leave an operator who raised the
 * limit still being throttled, with nothing pointing at the cause.
 */
export const DEFAULT_RATE_LIMIT_MAX = 200;
export const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  const value = raw?.trim() ?? '';
  if (value === '') {
    return fallback;
  }
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name}=${value}: expected a positive integer`);
  }
  return Number(value);
}

export function parseRateLimitConfig(env: Record<string, string | undefined>): {
  max: number;
  timeWindowMs: number;
} {
  return {
    max: positiveInteger('RATE_LIMIT_MAX', env.RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
    timeWindowMs:
      positiveInteger(
        'RATE_LIMIT_WINDOW_SECONDS',
        env.RATE_LIMIT_WINDOW_SECONDS,
        DEFAULT_RATE_LIMIT_WINDOW_SECONDS
      ) * 1000,
  };
}
