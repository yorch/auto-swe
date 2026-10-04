import { describe, expect, it, vi } from 'vitest';
import {
  createIssueTrackerProvider,
  createKnowledgeBaseProvider,
  type ResolvedIssueTrackerConfig,
  type ResolvedKnowledgeBaseConfig,
} from './registry.js';

const INTERNAL_JIRA_BASE_URL = 'http://jira.internal';
const INTERNAL_CONFLUENCE_BASE_URL = 'http://confluence.internal';

function jiraConfig(
  overrides: Partial<ResolvedIssueTrackerConfig> = {}
): ResolvedIssueTrackerConfig {
  return {
    allowPrivateNetwork: false,
    apiToken: 'token',
    baseUrl: INTERNAL_JIRA_BASE_URL,
    email: 'bot@example.com',
    provider: 'jira',
    ...overrides,
  };
}

function confluenceConfig(
  overrides: Partial<ResolvedKnowledgeBaseConfig> = {}
): ResolvedKnowledgeBaseConfig {
  return {
    allowPrivateNetwork: false,
    apiToken: 'token',
    baseUrl: INTERNAL_CONFLUENCE_BASE_URL,
    email: 'bot@example.com',
    enabled: true,
    provider: 'confluence',
    spaces: [],
    ...overrides,
  };
}

describe('createIssueTrackerProvider — SSRF guard opt-in (Jira)', () => {
  it('rejects an internal baseUrl when allowPrivateNetwork is false', () => {
    const warn = vi.fn();
    const provider = createIssueTrackerProvider(jiraConfig({ allowPrivateNetwork: false }), {
      log: { warn },
    });
    expect(provider).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: INTERNAL_JIRA_BASE_URL }),
      expect.stringContaining('rejected by SSRF guard')
    );
  });

  it('builds a provider for the same internal baseUrl when allowPrivateNetwork is true', () => {
    const warn = vi.fn();
    const provider = createIssueTrackerProvider(jiraConfig({ allowPrivateNetwork: true }), {
      log: { warn },
    });
    expect(provider).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: INTERNAL_JIRA_BASE_URL }),
      expect.stringContaining('allowPrivateNetwork opt-in')
    );
  });
});

describe('createKnowledgeBaseProvider — SSRF guard opt-in (Confluence)', () => {
  it('rejects an internal baseUrl when allowPrivateNetwork is false', () => {
    const warn = vi.fn();
    const provider = createKnowledgeBaseProvider(confluenceConfig({ allowPrivateNetwork: false }), {
      log: { warn },
    });
    expect(provider).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: INTERNAL_CONFLUENCE_BASE_URL }),
      expect.stringContaining('rejected by SSRF guard')
    );
  });

  it('builds a provider for the same internal baseUrl when allowPrivateNetwork is true', () => {
    const warn = vi.fn();
    const provider = createKnowledgeBaseProvider(confluenceConfig({ allowPrivateNetwork: true }), {
      log: { warn },
    });
    expect(provider).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: INTERNAL_CONFLUENCE_BASE_URL }),
      expect.stringContaining('allowPrivateNetwork opt-in')
    );
  });
});

describe('allowPrivateNetwork waives only the private-address refusal', () => {
  const refused = [
    'http://127.0.0.1:8080',
    'http://localhost:8080',
    'http://169.254.169.254',
    'http://metadata.google.internal',
    'http://0.0.0.0',
    'ftp://jira.internal',
    'not a url',
  ];
  const cases: [string, (baseUrl: string) => unknown][] = [
    [
      'Jira',
      (baseUrl) => createIssueTrackerProvider(jiraConfig({ allowPrivateNetwork: true, baseUrl })),
    ],
    [
      'GitHub Issues',
      (baseUrl) =>
        createIssueTrackerProvider({
          allowPrivateNetwork: true,
          apiToken: 'token',
          baseUrl,
          email: null,
          provider: 'github',
        }),
    ],
    [
      'Confluence',
      (baseUrl) =>
        createKnowledgeBaseProvider(confluenceConfig({ allowPrivateNetwork: true, baseUrl })),
    ],
  ];

  describe.each(cases)('%s', (_name, create) => {
    it('still accepts a private address', () => {
      expect(create('http://10.0.0.5')).not.toBeNull();
    });

    it.each(refused)('refuses %s even with the opt-in', (baseUrl) => {
      expect(create(baseUrl)).toBeNull();
    });
  });
});
