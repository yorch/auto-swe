import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveIssueTrackerConfig: vi.fn(async () => ({ allowPrivateNetwork: false, baseUrl: null })),
}));

import { fetchIssue } from './issueTracker.js';
import { appendNotionBlocks, readNotionPage } from './notion.js';
import { postSlackMessage } from './slack.js';

// Each connector request carries a credential, so none of them may follow a redirect.
function stubFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ json: async () => body, ok: true, status: 200 });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function expectRedirectError(fetchMock: ReturnType<typeof vi.fn>) {
  expect(fetchMock).toHaveBeenCalled();
  for (const call of fetchMock.mock.calls) {
    expect(call[1]).toEqual(expect.objectContaining({ redirect: 'error' }));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('worker connectors refuse redirects', () => {
  it('Linear', async () => {
    const fetchMock = stubFetch({
      data: { issue: { identifier: 'ENG-1', title: 't', url: 'u' } },
    });
    await fetchIssue({ apiToken: 'k', config: { provider: 'linear' } }, 'ENG-1').catch(() => {});
    expectRedirectError(fetchMock);
  });

  it('Notion', async () => {
    const fetchMock = stubFetch({ id: 'p', object: 'page', properties: {}, results: [] });
    await readNotionPage({ apiToken: 'k' }, 'p');
    await appendNotionBlocks({ apiToken: 'k' }, 'p', []);
    expectRedirectError(fetchMock);
  });

  it('Slack', async () => {
    const fetchMock = stubFetch({ channel: 'C', ok: true, ts: '1' });
    await postSlackMessage({ apiToken: 'k' }, { channelId: 'C', text: 'hi' });
    expectRedirectError(fetchMock);
  });
});
