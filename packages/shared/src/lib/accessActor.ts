/**
 * The subset of an authenticated caller an access decision reads.
 *
 * Structural rather than the gateway's `JwtPayload`, because the worker takes
 * this same decision now: the Slack channel assistant's code task pushes and
 * opens a pull request like any other launch, and it runs in the worker. Two
 * implementations of an access decision drift, so there is one, here.
 */

import type { Role } from '../index.js';
export interface AccessActor {
  /** User UUID. */
  sub: string;
  /**
   * Platform role — `ADMIN` bypasses what it is allowed to bypass.
   *
   * The enum, not `string`. Every consumer tests it with an exact
   * `=== 'ADMIN'`, so a caller that passes a lowercase or mistyped role would
   * compile and silently lose the bypass — a wrong answer that looks like a
   * working one, which is the same failure mode the required-and-nullable gate
   * argument was shaped to prevent.
   */
  role: Role;
}

/** The logger shape these take, so neither process's logger type leaks in. */
export interface AccessLog {
  warn(obj: unknown, msg?: string): void;
}
