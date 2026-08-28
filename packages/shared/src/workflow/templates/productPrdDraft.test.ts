import { describe, expect, it } from 'vitest';
import { WorkflowSpecSchema } from '../spec.js';
import { PRODUCT_PRD_DRAFT_SPEC } from './productPrdDraft.js';

describe('PRODUCT_PRD_DRAFT_SPEC', () => {
  it('parses as a valid WorkflowSpec', () => {
    const result = WorkflowSpecSchema.safeParse(PRODUCT_PRD_DRAFT_SPEC);
    expect(result.success).toBe(true);
  });
});
