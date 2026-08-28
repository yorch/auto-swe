import { describe, expect, it } from 'vitest';
import { WorkflowSpecSchema } from '../spec.js';
import { NOTION_CONTENT_DRAFT_SPEC } from './notionContentDraft.js';

describe('NOTION_CONTENT_DRAFT_SPEC', () => {
  it('parses as a valid WorkflowSpec', () => {
    const result = WorkflowSpecSchema.safeParse(NOTION_CONTENT_DRAFT_SPEC);
    expect(result.success).toBe(true);
  });
});
