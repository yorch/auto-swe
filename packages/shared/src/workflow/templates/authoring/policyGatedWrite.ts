import type { Binding } from '../../spec.js';
import { type NodeMap, terminate } from './common.js';

export interface PolicyGatedWriteOptions {
  /** The autonomy-policy risk class the write is judged as (`publishOutcome`'s `config.action`). */
  action: 'external_communication' | 'external_write' | 'internal_write';
  /** Context path whose value describes the action to the policy and the approver. */
  describeFrom: string;
  /** What the approver is shown. `title` is the inbox heading. */
  approval: { title: string; description: string; contextFrom: string };
  /** The write itself: its `inputs` and optional `config`, as `writeOutcome` takes them. */
  write: { inputs: Record<string, Binding>; config?: Record<string, unknown> };
  /**
   * `'split'` emits two identical write nodes, `autoWrite` (no approval needed)
   * and `manualWrite` (after approval), so a trace says which path wrote.
   * `'single'` emits one `writeOutcome` that both paths share.
   */
  writes: 'split' | 'single';
  /** Node a successful write goes to. Default `done`. */
  done?: string;
  /** What the run reports when the approver rejects or the approval times out. */
  rejectedResult: Record<string, Binding>;
}

/**
 * The policy-gated write: record the autonomy decision, branch on it, and make
 * the write unreachable without an approval when the policy says one is needed.
 *
 *   publishOutcome -> checkAuto --auto--------------> autoWrite --> done
 *                          |                           (or writeOutcome)
 *                   (require_approval)
 *                          v
 *                   humanApproval --approved--> manualWrite --> done
 *                          |                     (or writeOutcome)
 *                     (rejected / timed out)
 *                          v
 *                     doneRejected
 *
 * The cond between `publishOutcome` and the write is the point of the idiom: a
 * template that routes `publishOutcome` straight into `writeOutcome` records
 * "approval required" in the audit log and then writes anyway
 * (`builtinTemplates.test.ts` rejects that shape). Entry node: `publishOutcome`.
 */
export function policyGatedWrite(opts: PolicyGatedWriteOptions): NodeMap {
  const group = 'policy gate';
  const done = opts.done ?? 'done';
  const autoId = opts.writes === 'split' ? 'autoWrite' : 'writeOutcome';
  const manualId = opts.writes === 'split' ? 'manualWrite' : 'writeOutcome';
  const write = (title: string) =>
    ({
      // Cloned per node, so the two write nodes never share a mutable object.
      ...(opts.write.config ? { config: structuredClone(opts.write.config) } : {}),
      group,
      inputs: structuredClone(opts.write.inputs),
      next: done,
      step: 'writeOutcome',
      title,
      type: 'step',
    }) as const;
  return {
    checkAuto: {
      expr: "nodes.publishOutcome.output.decision == 'require_approval'",
      group,
      onFalse: autoId,
      onTrue: 'humanApproval',
      title: 'Needs approval?',
      type: 'cond',
    },
    doneRejected: terminate('SUCCESS', {
      group,
      result: opts.rejectedResult,
      title: 'Rejected, nothing written',
    }),
    humanApproval: {
      approverCount: { from: 'nodes.publishOutcome.output.approverCount' },
      contextFrom: opts.approval.contextFrom,
      description: opts.approval.description,
      group,
      onApprove: manualId,
      onReject: 'doneRejected',
      onTimeout: 'doneRejected',
      timeout: '24h',
      title: opts.approval.title,
      type: 'humanApproval',
    },
    publishOutcome: {
      config: { action: opts.action },
      group,
      inputs: { description: { from: opts.describeFrom } },
      next: 'checkAuto',
      step: 'publishOutcome',
      title: 'Check the autonomy policy',
      type: 'step',
    },
    ...(opts.writes === 'split'
      ? {
          autoWrite: write('Write (no approval needed)'),
          manualWrite: write('Write (approved)'),
        }
      : { writeOutcome: write('Write the outcome') }),
  };
}
