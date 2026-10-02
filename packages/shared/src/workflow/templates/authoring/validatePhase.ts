import { mergeNodes, type NodeMap, statusStamp } from './common.js';

export interface ValidatePhaseOptions {
  /** Node the phase hands over to once it is done (normally `setImplementing`). */
  next: string;
  /**
   * Add the `setSuccessCriteria` node that lifts `validate`'s success criteria
   * into `context.successCriteria` for the review. Default true; a template with
   * no review leaves it out and `validate` goes straight to `next`.
   */
  successCriteria?: boolean;
  /** Id of the success-criteria node, for a template that already names it differently. */
  successCriteriaId?: string;
  /**
   * Add the `setValidating` status stamp in front of `validate` (default true).
   * With it, the phase's entry node is `setValidating`; without it, `validate`.
   */
  stamp?: boolean;
}

/**
 * The validate-context prologue: `setValidating -> validate -> setSuccessCriteria`.
 *
 * `validate` is non-blocking (`onError: 'continue'`): a validation failure is
 * a finding for the implementer, not a reason to stop the run.
 */
export function validatePhase(opts: ValidatePhaseOptions): NodeMap {
  const group = 'validate';
  const withCriteria = opts.successCriteria ?? true;
  const criteriaId = opts.successCriteriaId ?? 'setSuccessCriteria';
  return mergeNodes(
    opts.stamp === false
      ? {}
      : { setValidating: statusStamp('VALIDATING_CONTEXT', 'validate', { group }) },
    {
      validate: {
        group,
        next: withCriteria ? criteriaId : opts.next,
        onError: 'continue',
        step: 'validateContext',
        title: 'Validate the ticket context',
        type: 'step',
      },
    },
    withCriteria
      ? {
          [criteriaId]: {
            group,
            next: opts.next,
            title: 'Keep the success criteria',
            type: 'set',
            values: {
              'context.successCriteria': {
                default: [],
                from: 'nodes.validate.output.successCriteria',
              },
            },
          },
        }
      : {}
  );
}
