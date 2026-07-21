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
