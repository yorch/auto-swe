import { describe, expect, it } from 'vitest';
import { CONNECTION_TYPES } from './connectionTypes.js';
import { credentialDestination, credentialDestinationChanged } from './credentialDestination.js';

describe('credentialDestination', () => {
  it('answers for every connection type', () => {
    // The mapped type forces an entry at compile time; this is the runtime half, so
    // a type added to the union without going through the map fails here too.
    for (const type of CONNECTION_TYPES) {
      expect(() => credentialDestination(type, {})).not.toThrow();
    }
  });

  it('reads the destination from the field the connector actually requests', () => {
    expect(credentialDestination('confluence', { baseUrl: 'https://x.atlassian.net' })).toBe(
      'https://x.atlassian.net'
    );
    expect(
      credentialDestination('issue_tracker', { baseUrl: 'https://jira.corp', provider: 'jira' })
    ).toBe('https://jira.corp');
    expect(credentialDestination('zendesk', { subdomain: 'acme' })).toBe(
      'https://acme.zendesk.com'
    );
    expect(credentialDestination('mcp', { url: 'https://mcp.example.com/mcp' })).toBe(
      'https://mcp.example.com'
    );
  });

  it('treats a fixed-host connector as never moving, whatever the config says', () => {
    // Notion, Slack and Linear are reached on a constant host: there is no field a
    // LEAD could edit to send their token elsewhere.
    for (const config of [
      {},
      { baseUrl: 'https://attacker.example' },
      { url: 'https://attacker' },
    ]) {
      expect(credentialDestination('notion', config)).toBe('https://api.notion.com');
      expect(credentialDestination('slack_workspace', config)).toBe('https://slack.com');
    }
    expect(credentialDestination('issue_tracker', { provider: 'linear' })).toBe(
      'https://api.linear.app'
    );
  });

  it('reports no destination for a type whose secret is never sent', () => {
    // A placeholder handler makes no request, and a repository's credential lives in
    // the platform/user credential rows, not in this one.
    expect(credentialDestination('http_api', { baseUrl: 'https://x.example' })).toBeNull();
    expect(credentialDestination('hubspot', {})).toBeNull();
    expect(credentialDestination('git_repo', {})).toBeNull();
  });

  it('is null for a row that names no destination yet', () => {
    expect(credentialDestination('confluence', {})).toBeNull();
    expect(credentialDestination('confluence', null)).toBeNull();
    expect(credentialDestination('confluence', { baseUrl: 'not a url' })).toBeNull();
    expect(credentialDestination('zendesk', {})).toBeNull();
    // A provider that is neither of the two the connector knows sends nothing.
    expect(credentialDestination('issue_tracker', { provider: 'other' })).toBeNull();
  });

  it('normalises away the parts of a URL that do not change the host', () => {
    const a = credentialDestination('confluence', { baseUrl: 'https://x.atlassian.net' });
    const b = credentialDestination('confluence', { baseUrl: 'https://x.atlassian.net/wiki/' });
    expect(a).toBe(b);
  });
});

describe('credentialDestinationChanged', () => {
  const confluence = (baseUrl: string) => ({ config: { baseUrl }, type: 'confluence' as const });

  it('detects a repointed host', () => {
    expect(
      credentialDestinationChanged(confluence('https://a.example'), confluence('https://b.example'))
    ).toBe(true);
  });

  it('allows an edit that keeps the host', () => {
    expect(
      credentialDestinationChanged(
        confluence('https://a.example'),
        confluence('https://a.example/wiki')
      )
    ).toBe(false);
    expect(
      credentialDestinationChanged(confluence('https://a.example'), confluence('https://a.example'))
    ).toBe(false);
  });

  it('counts a missing destination as a value, so clearing it is a change', () => {
    // Otherwise this is a two-step way around the refusal: clear the URL in one
    // request, set the attacker's in the next.
    expect(credentialDestinationChanged(confluence('https://a.example'), confluence(''))).toBe(
      true
    );
    expect(credentialDestinationChanged(confluence(''), confluence('https://b.example'))).toBe(
      true
    );
  });

  it('detects a destination that moves without the URL changing', () => {
    // Switching an issue tracker from Jira to Linear sends the stored token to a
    // different service while `baseUrl` stays exactly as it was.
    expect(
      credentialDestinationChanged(
        { config: { baseUrl: 'https://jira.corp', provider: 'jira' }, type: 'issue_tracker' },
        { config: { baseUrl: 'https://jira.corp', provider: 'linear' }, type: 'issue_tracker' }
      )
    ).toBe(true);
  });

  it('sees a subdomain move', () => {
    expect(
      credentialDestinationChanged(
        { config: { subdomain: 'acme' }, type: 'zendesk' },
        { config: { subdomain: 'attacker' }, type: 'zendesk' }
      )
    ).toBe(true);
  });
});
