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
 */

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
