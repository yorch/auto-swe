/**
 * SignalSlots — small state machine for the signal-payload buffer the
 * RunnableWorkflow dispatcher uses to bridge Temporal `setHandler` callbacks
 * and the interpreter's `await waitSignal(name, timeout)` calls.
 *
 * Why a class: the interpreter is pure and signal-name-agnostic. The dispatcher
 * needs a slot per signal name where the handler can deliver a payload and
 * where a `wait` can consume it. A payload that arrives before anyone waits is
 * kept — a CI webhook can land before the interpreter reaches its wait node —
 * and `take()` consumes it, so no wait ever sees a payload an earlier wait used.
 *
 * Slot states:
 *   - unset            : no payload received since last `take()` / `clear()`
 *   - { payload: ... } : the next caller of `take()` will receive this
 *
 * `null` is a legal payload (it's how engineering's humanMergeSignal arrives —
 * the `payload ?? null` normalization preserves "delivered but falsy"). The
 * sentinel for "not yet delivered" is therefore a distinct unset state, not
 * `undefined` mixed into the value.
 *
 * One delivery, one consumer: a slot holds at most one payload, and `take()`
 * hands it to exactly one waiter. When several waits on the same name are
 * pending at once (a `signal` node inside concurrent fan-out branches), one
 * delivery wakes every one of them, but only the first to resume gets the
 * payload; {@link waitForSignal} sends the others back to waiting for the rest
 * of their own timeout.
 */

import { waitDurationMs } from './waitDuration.js';

export class SignalSlots {
  private readonly slots = new Map<string, { payload: unknown }>();
  private readonly registered = new Set<string>();

  /** Declare a slot. Idempotent — calling twice does nothing. */
  register(name: string): void {
    this.registered.add(name);
  }

  /** Was this signal name ever registered? */
  isRegistered(name: string): boolean {
    return this.registered.has(name);
  }

  /** Has a payload been delivered (and not yet consumed) for this name? */
  hasPending(name: string): boolean {
    return this.slots.has(name);
  }

  /**
   * Called by the Temporal signal handler. If a previous payload is still
   * pending, it is replaced (Temporal signals are at-least-once; the caller
   * should treat repeated deliveries idempotently).
   */
  deliver(name: string, payload: unknown): void {
    this.slots.set(name, { payload: payload === undefined ? null : payload });
  }

  /** Clear any pending payload. Safe even when nothing is pending. */
  clear(name: string): void {
    this.slots.delete(name);
  }

  /**
   * Atomically consume the pending payload, or return `undefined` if nothing
   * is pending. Always leaves the slot empty.
   */
  take(name: string): unknown | undefined {
    const slot = this.slots.get(name);
    if (!slot) {
      return undefined;
    }
    this.slots.delete(name);
    return slot.payload;
  }
}

/**
 * The Temporal primitives {@link waitForSignal} needs, injected so the wait
 * logic stays pure (and testable) while the workflow supplies the real ones.
 */
export interface SignalWaitRuntime {
  /** Temporal's `condition(fn, timeout)`: true once `fn()` holds, false when the timeout fires. */
  condition(fn: () => boolean, timeout: string | number): Promise<boolean>;
  /** Workflow time in ms (Temporal's deterministic `Date.now()`). */
  now(): number;
  /** Temporal's `patched(id)`. Called only on the path the patch changed. */
  patched(id: string): boolean;
}

/**
 * Patch id gating the re-wait below. A history recorded before it routed a
 * waiter that woke to an empty slot straight to `onTimeout`; replaying such a
 * history must take that path again rather than start a new timer.
 */
export const SIGNAL_REWAIT_PATCH = 'shared-signal-wait-rewaits-on-empty-slot';

/**
 * Wait up to `timeout` for a payload on `name` and consume it, or return
 * `undefined` when the timeout elapses.
 *
 * Temporal evaluates every blocked `condition` after an activation's signals
 * are applied, before any of the woken code runs. So when two waits on the
 * same name are pending and one delivery lands, both conditions resolve true,
 * the first to resume `take()`s the payload, and the second finds the slot
 * empty. That second waiter has not timed out: it waits again for whatever is
 * left of its own timeout (measured on the workflow clock from when this wait
 * began). The first wait issues exactly the commands it always has; the
 * re-wait — a new timer — happens only on the empty-slot path, behind
 * {@link SIGNAL_REWAIT_PATCH}.
 *
 * `leaveForLater` is asked each time a delivery wakes the wait (not on timeout).
 * Returning true leaves the payload in the slot for a later wait and ends this
 * one with `undefined` (a fan-out branch the interpreter has abandoned).
 */
export async function waitForSignal(
  slots: SignalSlots,
  name: string,
  timeout: string,
  runtime: SignalWaitRuntime,
  leaveForLater?: () => boolean
): Promise<unknown | undefined> {
  // `waitDurationMs` is 0 for a timeout it cannot parse (the schema refuses
  // one, so only a hand-built spec gets here). The deadline is then already
  // past, so an empty-slot wake ends at once — the behaviour before the re-wait.
  const deadline = runtime.now() + waitDurationMs(timeout);
  const pending = () => slots.hasPending(name);
  let received = await runtime.condition(pending, timeout);
  while (received && !leaveForLater?.()) {
    if (slots.hasPending(name)) {
      return slots.take(name);
    }
    // Woke to an empty slot: a concurrent wait on the same name consumed the
    // delivery that woke us both.
    if (!runtime.patched(SIGNAL_REWAIT_PATCH)) {
      return undefined;
    }
    // Whole milliseconds, rounded up, so a fractional duration never shortens the wait.
    const remainingMs = Math.ceil(deadline - runtime.now());
    if (remainingMs <= 0) {
      return undefined;
    }
    received = await runtime.condition(pending, remainingMs);
  }
  return undefined;
}
