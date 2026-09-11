/**
 * The subset of an authenticated caller an access decision reads.
 *
 * Structural rather than the gateway's `JwtPayload`, because the worker takes
 * this same decision now: the Slack channel assistant's code task pushes and
 * opens a pull request like any other launch, and it runs in the worker. Two
 * implementations of an access decision drift, so there is one, here.
 */
export interface AccessActor {
  /** User UUID. */
  sub: string;
  /** Platform role — `ADMIN` bypasses what it is allowed to bypass. */
  role: string;
}

/** The logger shape these take, so neither process's logger type leaks in. */
export interface AccessLog {
  warn(obj: unknown, msg?: string): void;
}
