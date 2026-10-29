import { mergeNodes, type NodeMap, statusStamp, terminate } from './common.js';

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
   * End the run, FAILED, when `validate` reports the request is not actionable (its `actionable`
   * output is `false`: every criterion it found is an ambiguity), instead of handing over to
   * `next`. The terminate result carries a message for the requester and the ambiguities (and,
   * with `ticketContext`, why the ticket could not be read). A
   * validate step that threw, or an output with no verdict, does not stop the run. Default false.
   */
  stopIfNotActionable?: boolean;
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
  const withStop = opts.stopIfNotActionable ?? false;
  const afterCheck = withCriteria ? criteriaId : opts.next;
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
        next: withStop ? 'checkActionable' : afterCheck,
        onError: 'continue',
        step: 'validateContext',
        title: 'Validate the ticket context',
        type: 'step',
      },
    },
    withStop
      ? {
          checkActionable: {
            expr: 'nodes.validate.output.actionable == false',
            group,
            onFalse: afterCheck,
            onTrue: 'terminateNotActionable',
            title: 'Is the request actionable?',
            type: 'cond',
          },
          terminateNotActionable: terminate('FAILED', {
            group,
            result: {
              ambiguities: { default: [], from: 'nodes.validate.output.ambiguities' },
              message: {
                literal:
                  'The request is not actionable: validation found nothing it could verify, ' +
                  'only the ambiguities listed here. Paste the ticket text or add acceptance ' +
                  'criteria to the request, then re-run.',
              },
              // Why the gatherer could not read the ticket ('' when it did, or none was named),
              // so the stop does not leave the requester guessing whether they or the tracker erred.
              ...(withTicket
                ? {
                    ticketUnavailableReason: {
                      default: '',
                      from: 'nodes.gatherTicket.output.unavailableReason',
                    },
                  }
                : {}),
            },
            title: 'Stop: the request is not actionable',
          }),
        }
      : {},
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
