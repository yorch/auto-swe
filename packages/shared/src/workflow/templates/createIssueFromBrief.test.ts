import { describe, expect, it } from 'vitest';
import { WorkflowSpecSchema } from '../spec.js';
import { CREATE_ISSUE_FROM_BRIEF_SPEC } from './createIssueFromBrief.js';

describe('CREATE_ISSUE_FROM_BRIEF_SPEC', () => {
  it('parses as a valid WorkflowSpec', () => {
    const result = WorkflowSpecSchema.safeParse(CREATE_ISSUE_FROM_BRIEF_SPEC);
    expect(result.success).toBe(true);
  });
});
