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
   * Gather the run's tracker ticket before validating: `gatherTicket` (the context gatherer, which
   * digests the ticket, its parent and its newest comments), then `setTicket`, which keeps its text
   * in `context.ticket` for `validate` and for later steps such as `implement`. Default false, so a
   * template that does not ask for it is unchanged.
   */
  ticketContext?: boolean;
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
  const withTicket = opts.ticketContext ?? false;
  return mergeNodes(
    opts.stamp === false
      ? {}
      : {
          setValidating: statusStamp(
            'VALIDATING_CONTEXT',
            withTicket ? 'gatherTicket' : 'validate',
            { group }
          ),
        },
    withTicket
      ? {
          // A failed gather is no ticket, not a stopped run: validate and implement go on with the
          // request's own description.
          gatherTicket: {
            group,
            next: 'setTicket',
            onError: 'continue',
            step: 'gatherTicketContext',
            title: 'Gather the ticket context',
            type: 'step',
          },
          setTicket: {
            group,
            next: 'validate',
            title: 'Keep the ticket context',
            type: 'set',
            values: {
              'context.ticket': { default: '', from: 'nodes.gatherTicket.output.text' },
            },
          },
        }
      : {},
    {
      validate: {
        group,
        ...(withTicket ? { inputs: { ticket: { from: 'context.ticket' } } } : {}),
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
