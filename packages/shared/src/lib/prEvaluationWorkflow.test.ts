import { describe, expect, it } from 'vitest';
import { PR_EVALUATION_WORKFLOW_TYPE, prEvaluationWorkflowId } from './prEvaluationWorkflow.js';

const CONNECTION = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';

describe('prEvaluationWorkflowId', () => {
  it('joins the connection prefix, the pull request and the delivery prefix', () => {
    expect(prEvaluationWorkflowId(CONNECTION, 42, '9F8E7D6C-1111-2222')).toBe(
      'preval-1a2b3c4d-42-9f8e7d6c'
    );
  });

  it('keeps only [a-z0-9] before taking eight characters', () => {
    expect(prEvaluationWorkflowId(CONNECTION, 1, 'a-b_c d!e/f.g:h+ij')).toBe(
      'preval-1a2b3c4d-1-abcdefgh'
    );
  });

  it('falls back to manual when nothing usable is left', () => {
    expect(prEvaluationWorkflowId(CONNECTION, 7, '')).toBe('preval-1a2b3c4d-7-manual');
    expect(prEvaluationWorkflowId(CONNECTION, 7, '---')).toBe('preval-1a2b3c4d-7-manual');
  });

  it('names the workflow type the worker registers', () => {
    expect(PR_EVALUATION_WORKFLOW_TYPE).toBe('prEvaluationWorkflow');
  });
});
