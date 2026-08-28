import { describe, expect, it } from 'vitest';
import { WorkflowSpecSchema } from '../spec.js';
import { CREATE_ISSUE_SPEC } from './createIssue.js';

describe('CREATE_ISSUE_SPEC', () => {
  it('parses as a valid WorkflowSpec', () => {
    const result = WorkflowSpecSchema.safeParse(CREATE_ISSUE_SPEC);
    expect(result.success).toBe(true);
  });
});
