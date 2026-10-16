import { describe, expect, it, vi } from 'vitest';
import { type AtlassianClient, AtlassianError } from '../atlassianClient.js';
import { JiraProvider } from './jira.js';

const adf = (text: string) => ({
  content: [{ content: [{ text, type: 'text' }], type: 'paragraph' }],
  type: 'doc',
  version: 1,
});

const ISSUE = {
  fields: {
    description: adf('Add a health endpoint.'),
    labels: ['backend'],
    parent: {
      fields: {
        issuetype: { name: 'Epic' },
        status: { name: 'In Progress' },
        summary: 'Observability',
      },
      key: 'AIDEVEX-1',
    },
    status: { name: 'To Do' },
    summary: 'Health endpoint',
  },
  key: 'AIDEVEX-8',
};

/** A client answering by path fragment; anything else is a 404. */
function stubClient(answers: Record<string, unknown>) {
  const paths: string[] = [];
  const get = vi.fn(async (path: string) => {
    paths.push(path);
    const hit = Object.entries(answers).find(([fragment]) => path.includes(fragment));
    if (!hit) {
      throw new AtlassianError(404, 'not_found', 'nope');
    }
    if (hit[1] instanceof Error) {
      throw hit[1];
    }
    return hit[1];
  });
  const client = { baseUrl: 'https://acme.atlassian.net', get } as unknown as AtlassianClient;
  return { client, paths };
}

const provider = (client: AtlassianClient) => new JiraProvider(client, {});

describe('JiraProvider.fetchIssue extras', () => {
  it('makes no extra calls unless asked, and the request is unchanged', async () => {
    const { client, paths } = stubClient({ '/issue/AIDEVEX-8?': ISSUE });
    const issue = await provider(client).fetchIssue('AIDEVEX-8');
    expect(paths).toEqual([
      '/rest/api/3/issue/AIDEVEX-8?fields=summary,description,status,labels,priority,assignee,components',
    ]);
    expect(issue?.comments).toBeUndefined();
    expect(issue?.parent).toBeUndefined();
  });

  describe('comments', () => {
    const comments = {
      comments: [
        {
          author: { displayName: 'Bea' },
          body: adf('Second'),
          created: '2026-10-02T10:00:00.000+0000',
        },
        {
          author: { displayName: 'Al' },
          body: adf('First'),
          created: '2026-10-01T10:00:00.000+0000',
        },
      ],
    };

    it('asks for the newest 20 and returns them oldest first as plain text', async () => {
      const { client, paths } = stubClient({ '/comment': comments, '/issue/AIDEVEX-8?': ISSUE });
      const issue = await provider(client).fetchIssue('AIDEVEX-8', { includeComments: true });
      expect(paths).toContain('/rest/api/3/issue/AIDEVEX-8/comment?maxResults=20&orderBy=-created');
      expect(issue?.comments).toEqual([
        { author: 'Al', body: 'First', created: '2026-10-01T10:00:00.000+0000' },
        { author: 'Bea', body: 'Second', created: '2026-10-02T10:00:00.000+0000' },
      ]);
    });

    it('keeps the ticket when the comments cannot be read', async () => {
      const { client } = stubClient({
        '/comment': new AtlassianError(403, 'auth', 'forbidden'),
        '/issue/AIDEVEX-8?': ISSUE,
      });
      const issue = await provider(client).fetchIssue('AIDEVEX-8', { includeComments: true });
      expect(issue?.title).toBe('Health endpoint');
      expect(issue?.comments).toBeUndefined();
    });

    it('drops comments with no text and tolerates a missing author', async () => {
      const { client } = stubClient({
        '/comment': {
          comments: [
            { body: adf('   '), created: 'x' },
            { body: adf('Hi'), created: 'y' },
          ],
        },
        '/issue/AIDEVEX-8?': ISSUE,
      });
      const issue = await provider(client).fetchIssue('AIDEVEX-8', { includeComments: true });
      expect(issue?.comments).toEqual([{ author: 'unknown', body: 'Hi', created: 'y' }]);
    });
  });

  describe('parent', () => {
    it('adds parent to the fields, then reads the parent description', async () => {
      const { client, paths } = stubClient({
        '/issue/AIDEVEX-1?': {
          fields: { description: adf('Make it observable.'), summary: 'Observability' },
          key: 'AIDEVEX-1',
        },
        '/issue/AIDEVEX-8?': ISSUE,
      });
      const issue = await provider(client).fetchIssue('AIDEVEX-8', { includeParent: true });
      expect(paths[0]).toContain('components,parent');
      expect(paths[1]).toBe('/rest/api/3/issue/AIDEVEX-1?fields=summary,description,status');
      expect(issue?.parent).toEqual({
        description: 'Make it observable.',
        id: 'AIDEVEX-1',
        status: 'In Progress',
        title: 'Observability',
        type: 'Epic',
      });
    });

    it('keeps title and type when the parent description cannot be read', async () => {
      const { client } = stubClient({
        '/issue/AIDEVEX-1?': new AtlassianError(403, 'auth', 'forbidden'),
        '/issue/AIDEVEX-8?': ISSUE,
      });
      const issue = await provider(client).fetchIssue('AIDEVEX-8', { includeParent: true });
      expect(issue?.parent).toEqual({
        description: '',
        id: 'AIDEVEX-1',
        status: 'In Progress',
        title: 'Observability',
        type: 'Epic',
      });
    });

    it('has no parent when the issue has none', async () => {
      const { client, paths } = stubClient({
        '/issue/AIDEVEX-8?': { ...ISSUE, fields: { ...ISSUE.fields, parent: undefined } },
      });
      const issue = await provider(client).fetchIssue('AIDEVEX-8', { includeParent: true });
      expect(issue?.parent).toBeUndefined();
      expect(paths).toHaveLength(1);
    });
  });
});

describe('JiraProvider.addComment', () => {
  it('posts the text as an ADF comment and reports it posted', async () => {
    const post = vi.fn(async (..._args: unknown[]) => ({ id: '10001' }));
    const client = { post } as unknown as AtlassianClient;
    await expect(provider(client).addComment('AIDEVEX-8', 'Looks good')).resolves.toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/rest/api/3/issue/AIDEVEX-8/comment', {
      body: adf('Looks good'),
    });
  });

  it('reports a failed post as not posted, without throwing', async () => {
    const post = vi.fn(async () => {
      throw new AtlassianError(403, 'auth', 'forbidden');
    });
    const client = { post } as unknown as AtlassianClient;
    await expect(provider(client).addComment('AIDEVEX-8', 'Looks good')).resolves.toBe(false);
  });
});
