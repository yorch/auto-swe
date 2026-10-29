/**
 * The contract between whoever starts a pull-request evaluation (the gateway's webhook handler,
 * a manual re-run) and the worker that runs it. Kept out of `prEvaluation/`, which is pure
 * classification, so the workflow isolate and the gateway can import it without that code.
 */

export const PR_EVALUATION_WORKFLOW_TYPE = 'prEvaluationWorkflow';

export type PrEvaluationInput = {
  connectionId: string;
  prNumber: number;
  /** What caused the evaluation, e.g. `pull_request.synchronize`, `pull_request_review.submitted`, `manual`. */
  trigger: string;
};

/**
 * `preval-<connection first 8>-<pr>-<delivery first 8, [a-z0-9] only>`; `manual` when the
 * delivery id has no usable character. One id per delivery makes a redelivered webhook a no-op
 * start, while a new push or review is a new evaluation.
 */
export function prEvaluationWorkflowId(
  connectionId: string,
  prNumber: number,
  deliveryId: string
): string {
  const delivery = deliveryId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  return `preval-${connectionId.slice(0, 8)}-${prNumber}-${delivery === '' ? 'manual' : delivery}`;
}
