import { describe, expect, it } from 'vitest';
import { WorkflowSpecSchema } from '../spec.js';
import { NOTION_CONTENT_BRAND_REVIEW_SPEC } from './notionContentBrandReview.js';

describe('NOTION_CONTENT_BRAND_REVIEW_SPEC', () => {
  it('parses as a valid WorkflowSpec', () => {
    const result = WorkflowSpecSchema.safeParse(NOTION_CONTENT_BRAND_REVIEW_SPEC);
    expect(result.success).toBe(true);
  });
});
