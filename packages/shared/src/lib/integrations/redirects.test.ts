import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlassianClient, AtlassianError } from './atlassianClient.js';
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
  it('Atlassian client does not follow redirects', async () => {
    const fetchMock = stubFetch();
    const client = new AtlassianClient({
      apiToken: 't',
      baseUrl: 'https://x.atlassian.net',
      email: 'a@b.com',
    });
    await client.get('/rest/api/3/myself');
    // Followed by hand: any 3xx is refused (see the behavioural test below).
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ redirect: 'manual' }));
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

// ─── Behaviour against real local servers ────────────────────────────────────

interface Seen {
  method?: string;
  url?: string;
  authorization?: string;
  body: string;
}

const servers: Server[] = [];

async function listen(
  handler: (req: IncomingMessage, seen: Seen, res: import('node:http').ServerResponse) => void
) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const entry: Seen = {
      authorization: req.headers.authorization,
      body: '',
      method: req.method,
      url: req.url,
    };
    seen.push(entry);
    req.on('data', (c) => {
      entry.body += c;
    });
    req.on('end', () => handler(req, entry, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe('redirect behaviour against local servers', () => {
  it('Atlassian: a redirect is refused once, without retries and without reaching the target', async () => {
    const target = await listen((_req, _seen, res) => res.end('{}'));
    const origin = await listen((_req, _seen, res) => {
      res.writeHead(302, { location: `${target.url}/x` }).end();
    });
    const client = new AtlassianClient({
      apiToken: 't',
      baseUrl: origin.url,
      email: 'a@b.com',
      maxRetries: 3,
    });
    const err = (await client.get('/rest/api/3/myself').catch((e: unknown) => e)) as AtlassianError;
    expect(err).toBeInstanceOf(AtlassianError);
    expect(err.code).toBe('redirect');
    expect(origin.seen).toHaveLength(1);
    expect(target.seen).toHaveLength(0);
  });

  it('GitHub Issues: a redirect to another origin is refused and never receives the token', async () => {
    const target = await listen((_req, _seen, res) => res.end('{}'));
    const origin = await listen((_req, _seen, res) => {
      res.writeHead(301, { location: `${target.url}/issue` }).end();
    });
    const provider = new GitHubIssuesProvider({ apiToken: 'secret', baseUrl: origin.url });
    expect(await provider.fetchIssue('o/r#1')).toBeNull();
    expect(origin.seen).toHaveLength(1);
    expect(target.seen).toHaveLength(0);
  });

  it('GitHub Issues: a same-origin redirect is followed with the token', async () => {
    const origin = await listen((req, _seen, res) => {
      if (req.url === '/repos/o/r/issues/1') {
        res.writeHead(301, { location: '/repositories/5/issues/1' }).end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ number: 1, state: 'open', title: 'T' }));
    });
    const provider = new GitHubIssuesProvider({ apiToken: 'secret', baseUrl: origin.url });
    const issue = await provider.fetchIssue('o/r#1');
    expect(issue?.title).toBe('T');
    expect(origin.seen.map((s) => s.url)).toEqual([
      '/repos/o/r/issues/1',
      '/repositories/5/issues/1',
    ]);
    expect(origin.seen[1].authorization).toBe('Bearer secret');
  });

  it('GitHub Issues: a 307 on a write keeps the method and body', async () => {
    const origin = await listen((req, _seen, res) => {
      if (req.url === '/repos/o/r/issues') {
        res.writeHead(307, { location: '/repositories/5/issues' }).end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ html_url: 'u', id: 1, number: 7, title: 'T' }));
    });
    const provider = new GitHubIssuesProvider({ apiToken: 'secret', baseUrl: origin.url });
    const created = await provider.createIssue({
      description: 'd',
      issueType: 'Story',
      projectKey: 'o/r',
      title: 'T',
    });
    expect(created?.id).toBe('7');
    expect(origin.seen[1]).toMatchObject({ method: 'POST', url: '/repositories/5/issues' });
    expect(JSON.parse(origin.seen[1].body).title).toBe('T');
  });

  it('GitHub Issues: a redirect loop stops at the hop limit', async () => {
    const origin = await listen((_req, _seen, res) => {
      res.writeHead(301, { location: '/again' }).end();
    });
    const provider = new GitHubIssuesProvider({ apiToken: 'secret', baseUrl: origin.url });
    expect(await provider.fetchIssue('o/r#1')).toBeNull();
    expect(origin.seen).toHaveLength(4);
  });
});
