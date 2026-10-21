import { describe, expect, it } from 'vitest';
import { entityHref, entityTypeLabel } from './auditEntity';

describe('audit entities', () => {
  it('names a type in words and links to the entity, or its list', () => {
    expect(entityTypeLabel('PersonalAccessToken')).toBe('Personal access token');
    expect(entityHref('Team', 't1')).toBe('/admin/teams/t1');
    expect(entityHref('Session', 's1')).toBe('/admin/sessions');
    expect(entityHref('McpToolCall', 'x')).toBeNull();
  });

  it('links a launch row to its request, or to the runs list when there was no request', () => {
    expect(entityHref('WorkRequest', 'req 1')).toBe('/requests?request=req%201');
    expect(entityHref('ActiveWorkflow', 'w1')).toBe('/runs');
  });

  it('opens the request panel for a run whose request is known, else the run page', () => {
    expect(entityHref('WorkflowRun', 'r1', 'req 1')).toBe('/requests?request=req%201');
    expect(entityHref('WorkflowRun', 'r1', null)).toBe('/runs/r1');
    expect(entityHref('WorkflowRun', 'r1')).toBe('/runs/r1');
  });
});
