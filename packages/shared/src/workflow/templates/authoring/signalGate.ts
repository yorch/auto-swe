import { type NodeMap, prResult, terminate } from './common.js';

export interface SignalGateOptions {
  /** Human name of the gate ("deploy gate"). It is the group and builds the node titles. */
  label: string;
  /** Node ids the gate is made of. */
  ids: { wait: string; check: string; rejected: string; timedOut: string };
  /** Temporal signal name, where the payload is stored, and how long to wait. */
  signal: string;
  storeAs: string;
  timeout: string;
  /** Expression over the stored payload that is true when the gate lets the run through. */
  expr: string;
  /** Where a go goes next. */
  passed: string;
}

/**
 * An external go/no-go gate: wait for a signal, branch on its payload, and end
 * the run FAILED on a no-go or TIMED_OUT if nothing arrives. Four nodes:
 *
 *   wait (signal) --received--> check (cond) --go--> `passed`
 *        |                          |
 *     (timeout)                  (no-go)
 *        v                          v
 *     timedOut                   rejected
 *
 * Both terminals report the pull request. Entry node: `ids.wait`.
 */
export function signalGate(opts: SignalGateOptions): NodeMap {
  const group = opts.label;
  return {
    [opts.ids.check]: {
      expr: opts.expr,
      group,
      onFalse: opts.ids.rejected,
      onTrue: opts.passed,
      title: `${opts.label}: go?`,
      type: 'cond',
    },
    [opts.ids.rejected]: terminate('FAILED', {
      group,
      result: prResult(),
      title: `${opts.label} said no`,
    }),
    [opts.ids.timedOut]: terminate('TIMED_OUT', {
      group,
      result: prResult(),
      title: `${opts.label} timed out`,
    }),
    [opts.ids.wait]: {
      group,
      name: opts.signal,
      onReceive: opts.ids.check,
      onTimeout: opts.ids.timedOut,
      storeAs: opts.storeAs,
      timeout: opts.timeout,
      title: `Wait for ${opts.label}`,
      type: 'signal',
    },
  };
}
