import { describe, expect, it } from 'vitest';
import { auditGroupOf, summarizeAuditChange } from './configAudit';

describe('auditGroupOf', () => {
  it('sorts entity types into the slice a page opens on', () => {
    expect(auditGroupOf('ProviderCredential')).toBe('models');
    expect(auditGroupOf('GitHubConfig')).toBe('integrations');
    expect(auditGroupOf('WorkflowDefaults')).toBe('settings');
    expect(auditGroupOf('SomethingNew')).toBe('settings');
  });
});

describe('summarizeAuditChange', () => {
  it('prefers the recorded changed fields', () => {
    expect(summarizeAuditChange(null, { changedFields: ['token', 'apiUrl'] })).toBe(
      'token, apiUrl'
    );
  });

  it('falls back to visible deltas, and a dash when there are none', () => {
    expect(summarizeAuditChange({ modelSpec: 'a/b' }, { modelSpec: 'a/c' })).toBe(
      'modelSpec: "a/b" → "a/c"'
    );
    expect(summarizeAuditChange({ x: 1 }, { x: 2 })).toBe('—');
  });
});
