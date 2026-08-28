import { describe, expect, it } from 'vitest';
import { WorkflowSpecSchema } from '../spec.js';
import { SEND_SLACK_UPDATE_SPEC } from './sendSlackUpdate.js';

describe('SEND_SLACK_UPDATE_SPEC', () => {
  it('parses as a valid WorkflowSpec', () => {
    const result = WorkflowSpecSchema.safeParse(SEND_SLACK_UPDATE_SPEC);
    expect(result.success).toBe(true);
  });
});
