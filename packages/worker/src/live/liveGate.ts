/**
 * Gate for the live suites (`*.live.test.ts`).
 *
 * A live suite talks to a real service with a real credential, so it runs only when its own flag is
 * `1` and every credential it needs is present. Anywhere else (a developer's `yarn test`, the unit
 * job, a fork) it skips, and says why: a bare skip reads the same as a suite that was deleted.
 *
 * The flag is read by the suite itself, as `process.env.LIVE_X === '1'`, and passed in: the
 * invariant check (`yarn invariants:check`) finds the flag by that exact text to confirm that
 * `live-e2e.yml` sets it.
 */
export interface LiveGate {
  /** Run the suite. */
  enabled: boolean;
  /** Why it is skipped; undefined when it runs. */
  reason: string | undefined;
}

export function liveGate(
  suite: string,
  flagName: string,
  flagSet: boolean,
  required: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): LiveGate {
  let reason: string | undefined;
  if (!flagSet) {
    reason = `${flagName} is not 1`;
  } else {
    const missing = required.filter((name) => !env[name]);
    if (missing.length > 0) {
      reason = `${flagName}=1 but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`;
    }
  }
  if (reason !== undefined && flagSet) {
    // Only a deliberate opt-in with a gap is worth a line; an ordinary `yarn test` stays quiet.
    const line = `[live] ${suite} skipped: ${reason}`;
    console.warn(env.GITHUB_ACTIONS === 'true' ? `::warning::${line}` : line);
  }
  return { enabled: reason === undefined, reason };
}

/** A suite title that carries the skip reason, so the reporter shows it. */
export function liveTitle(suite: string, gate: LiveGate): string {
  return gate.reason === undefined ? suite : `${suite} (skipped: ${gate.reason})`;
}

/** An environment variable the gate has already confirmed is set. */
export function liveEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
