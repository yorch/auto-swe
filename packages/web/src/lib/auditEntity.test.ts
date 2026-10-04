import { describe, expect, it } from 'vitest';
import { entityHref, entityTypeLabel } from './auditEntity';

describe('audit entities', () => {
  it('names a type in words and links to the entity, or its list', () => {
    expect(entityTypeLabel('PersonalAccessToken')).toBe('Personal access token');
    expect(entityHref('Team', 't1')).toBe('/govern/teams/t1');
    expect(entityHref('Session', 's1')).toBe('/govern/sessions');
    expect(entityHref('McpToolCall', 'x')).toBeNull();
  });
});
