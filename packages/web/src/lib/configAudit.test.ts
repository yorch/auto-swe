import { describe, expect, it } from 'vitest';
import { auditEntityLabel, auditGroupOf, summarizeAuditChange } from './configAudit';

describe('auditGroupOf', () => {
  it('sorts entity types into the slice a page opens on', () => {
    expect(auditGroupOf('ProviderCredential')).toBe('models');
    expect(auditGroupOf('GitHubConfig')).toBe('integrations');
    expect(auditGroupOf('WorkflowDefaults')).toBe('settings');
    expect(auditGroupOf('SomethingNew')).toBe('settings');
    // A join-request notice is delivered through Slack or email, so it sorts with the integrations.
    expect(auditGroupOf('JoinRequestNotification')).toBe('integrations');
  });
});

describe('auditEntityLabel', () => {
  it('names the join-request notification, and humanizes a type it does not know', () => {
    expect(auditEntityLabel('JoinRequestNotification')).toBe('Join-request notification');
    expect(auditEntityLabel('ProviderCredential')).toBe('Provider credential');
    expect(auditEntityLabel('SomethingNew')).toBe('Something new');
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
