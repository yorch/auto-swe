import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlassianClient } from './atlassianClient.js';
import { FigmaProvider } from './providers/figma.js';
import { GitHubIssuesProvider } from './providers/githubIssues.js';
import { LinearProvider } from './providers/linear.js';
import { NotionKnowledgeBaseProvider } from './providers/notion.js';

// A credentialed request must never be bounced to another origin, so every
// outbound connector call asks fetch to reject a redirect instead of following it.
const okResponse = { json: async () => ({}), ok: true, status: 200, text: async () => '' };

function stubFetch() {
  const fetchMock = vi.fn().mockResolvedValue(okResponse);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function expectNoRedirects(fetchMock: ReturnType<typeof vi.fn>) {
  expect(fetchMock).toHaveBeenCalled();
  for (const call of fetchMock.mock.calls) {
    expect(call[1]).toEqual(expect.objectContaining({ redirect: 'error' }));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('connector requests do not follow redirects', () => {
  it('Atlassian client', async () => {
    const fetchMock = stubFetch();
    const client = new AtlassianClient({
      apiToken: 't',
      baseUrl: 'https://x.atlassian.net',
      email: 'a@b.com',
    });
    await client.get('/rest/api/3/myself');
    expectNoRedirects(fetchMock);
  });

  it('GitHub Issues (every method)', async () => {
    const fetchMock = stubFetch();
    const provider = new GitHubIssuesProvider({ apiToken: 't', baseUrl: 'https://ghe.corp.test' });
    await provider.fetchIssue('o/r#1');
    await provider.createIssue({
      description: 'd',
      issueType: 'Story',
      projectKey: 'o/r',
      title: 't',
    });
    await provider.transitionIssue('o/r#1', 'Done');
    await provider.addComment('o/r#1', 'hi');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expectNoRedirects(fetchMock);
  });

  it('Linear', async () => {
    const fetchMock = stubFetch();
    await new LinearProvider('t', {}).fetchIssue('ENG-1');
    expectNoRedirects(fetchMock);
  });

  it('Notion', async () => {
    const fetchMock = stubFetch();
    await new NotionKnowledgeBaseProvider({
      allowPrivateNetwork: false,
      apiToken: 't',
      baseUrl: null,
      email: null,
      enabled: true,
      provider: 'notion',
      spaces: [],
    }).fetchPage('abc');
    expectNoRedirects(fetchMock);
  });

  it('Figma', async () => {
    const fetchMock = stubFetch();
    await new FigmaProvider({ apiToken: 't', enabled: true }).fetchDesignSummary({
      fileKey: 'KEY',
      nodeIds: ['1:1'],
      url: 'https://www.figma.com/file/KEY/F?node-id=1-1',
    });
    expectNoRedirects(fetchMock);
  });
});
