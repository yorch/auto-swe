import { describe, expect, it, vi } from 'vitest';
import { type AtlassianClient, AtlassianError } from '../atlassianClient.js';
import { TICKET_FAILURE_CLASSES } from '../ticketFailure.js';
import type { TrackerSyncEvent } from '../types.js';
import { JiraProvider, jiraOutcomeKind } from './jira.js';

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

describe('jiraOutcomeKind', () => {
  it.each(TICKET_FAILURE_CLASSES)('maps %s', (failure) => {
    expect(jiraOutcomeKind(failure)).toBe(failure === 'not_found' ? 'refused' : 'unavailable');
  });
});

describe('JiraProvider.fetchIssueOutcome', () => {
  it('returns the issue when it is read', async () => {
    const { client } = stubClient({ '/issue/AIDEVEX-8?': ISSUE });
    const outcome = await provider(client).fetchIssueOutcome('AIDEVEX-8');
    expect(outcome.kind).toBe('found');
    expect(outcome.kind === 'found' && outcome.issue.id).toBe('AIDEVEX-8');
  });

  it('says refused for a 404 on the issue read', async () => {
    const { client } = stubClient({ '/issue/': new AtlassianError(404, 'not_found', 'gone') });
    expect(await provider(client).fetchIssueOutcome('AIDEVEX-8')).toEqual({ kind: 'refused' });
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limited'],
    [500, 'server'],
    [503, 'server'],
    [0, 'network'],
  ] as const)('says unavailable for %s (%s)', async (status, code) => {
    const { client } = stubClient({ '/issue/': new AtlassianError(status, code, 'later') });
    expect(await provider(client).fetchIssueOutcome('AIDEVEX-8')).toEqual({
      kind: 'unavailable',
    });
  });

  it('says unavailable for an error that is not the tracker’s answer', async () => {
    const { client } = stubClient({ '/issue/': new Error('boom') });
    expect(await provider(client).fetchIssueOutcome('AIDEVEX-8')).toEqual({
      kind: 'unavailable',
    });
  });

  it('leaves fetchIssue as it was: null for every miss', async () => {
    const { client } = stubClient({ '/issue/': new AtlassianError(403, 'auth', 'denied') });
    expect(await provider(client).fetchIssue('AIDEVEX-8')).toBeNull();
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

describe('JiraProvider.syncOnEvent', () => {
  const failed = { issueId: 'AIDEVEX-8', summary: 'stopped', type: 'workflow_failed' } as const;

  it('reports no failure when the tracker accepts the comment', async () => {
    const post = vi.fn(async (..._args: unknown[]) => ({ id: '10001' }));
    const client = { post } as unknown as AtlassianClient;
    await expect(provider(client).syncOnEvent(failed)).resolves.toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, 'auth', 'unauthorized'],
    [403, 'auth', 'forbidden'],
    [404, 'not_found', 'not_found'],
    [429, 'rate_limited', 'rate_limited'],
    [500, 'server', 'server_error'],
  ] as const)('reports the class of a refused comment (%s)', async (status, code, failure) => {
    const post = vi.fn(async () => {
      throw new AtlassianError(status, code, 'refused');
    });
    const client = { post } as unknown as AtlassianClient;
    await expect(provider(client).syncOnEvent(failed)).resolves.toBe(failure);
  });

  it('classifies a failure that is not an Atlassian error as unknown', async () => {
    const post = vi.fn(async () => {
      throw new Error('boom');
    });
    const client = { post } as unknown as AtlassianClient;
    await expect(provider(client).syncOnEvent(failed)).resolves.toBe('unknown');
  });

  describe('workflow_completed (a status transition, no comment)', () => {
    const completed = { issueId: 'AIDEVEX-8', type: 'workflow_completed' } as const;
    const withPr = { ...completed, prTitle: 'Fix it', prUrl: 'https://gh/pr/1' } as const;
    const transitions = { transitions: [{ id: '31', name: 'Done', to: { name: 'Done' } }] };

    it('reports no failure when the transition lands', async () => {
      const get = vi.fn(async () => transitions);
      const post = vi.fn(async (..._args: unknown[]) => ({}));
      const client = { get, post } as unknown as AtlassianClient;
      await expect(provider(client).syncOnEvent(completed)).resolves.toBeNull();
      expect(post).toHaveBeenCalledTimes(1);
      expect(String(post.mock.calls[0]?.[0])).toContain('/transitions');
    });

    it.each([
      [401, 'auth', 'unauthorized'],
      [403, 'auth', 'forbidden'],
      [429, 'rate_limited', 'rate_limited'],
      [500, 'server', 'server_error'],
    ] as const)('reports a refused transition POST (%s)', async (status, code, failure) => {
      const get = vi.fn(async () => transitions);
      const post = vi.fn(async () => {
        throw new AtlassianError(status, code, 'refused');
      });
      const client = { get, post } as unknown as AtlassianClient;
      await expect(provider(client).syncOnEvent(completed)).resolves.toBe(failure);
    });

    it('reports a refused read of the transitions', async () => {
      const get = vi.fn(async () => {
        throw new AtlassianError(403, 'auth', 'forbidden');
      });
      const client = { get, post: vi.fn() } as unknown as AtlassianClient;
      await expect(provider(client).syncOnEvent(completed)).resolves.toBe('forbidden');
    });

    describe('with no transition to the target status', () => {
      const noMatch = { transitions: [{ id: '1', name: 'Start' }] };
      const answering = (status: unknown) =>
        vi.fn(async (path: string) =>
          path.includes('/transitions') ? noMatch : { fields: { status } }
        );

      it('reports no_transition when the ticket is in another status', async () => {
        const get = answering({ name: 'In Progress' });
        const post = vi.fn();
        const client = { get, post } as unknown as AtlassianClient;
        await expect(provider(client).syncOnEvent(completed)).resolves.toBe('no_transition');
        expect(post).not.toHaveBeenCalled();
        expect(get).toHaveBeenCalledWith('/rest/api/3/issue/AIDEVEX-8?fields=status');
      });

      it('stays null when the ticket is already in the target status (case-insensitive)', async () => {
        const get = answering({ name: 'DONE' });
        const post = vi.fn();
        const client = { get, post } as unknown as AtlassianClient;
        await expect(provider(client).syncOnEvent(completed)).resolves.toBeNull();
        expect(post).not.toHaveBeenCalled();
      });

      it.each([
        ['Closed', 'done', 'Done'],
        ['Fertig', 'done', 'Done'],
        ['In Review', 'indeterminate', 'In Review'],
        ['Code Review', 'indeterminate', 'In Review'],
        ['In Progress', 'indeterminate', 'In Progress'],
        ['Doing', 'indeterminate', 'In Progress'],
      ])(
        'stays null for status %s (category %s) when the target is %s',
        async (name, key, target) => {
          const get = answering({ name, statusCategory: { key } });
          const client = { get, post: vi.fn() } as unknown as AtlassianClient;
          await expect(
            provider(client).transitionIssue('AIDEVEX-8', target)
          ).resolves.toBeUndefined();
          const events: Record<string, TrackerSyncEvent> = {
            Done: completed,
            'In Progress': { issueId: 'AIDEVEX-8', type: 'workflow_started' },
            'In Review': { issueId: 'AIDEVEX-8', type: 'pr_opened' },
          };
          await expect(provider(client).syncOnEvent(events[target])).resolves.toBeNull();
        }
      );

      it('reports no_transition for a new-category ticket when the target is Done', async () => {
        const get = answering({ name: 'To Do', statusCategory: { key: 'new' } });
        const client = { get, post: vi.fn() } as unknown as AtlassianClient;
        await expect(provider(client).syncOnEvent(completed)).resolves.toBe('no_transition');
      });

      it('reports no_transition for workflow_started and pr_opened when the ticket is in another category', async () => {
        const todo = answering({ name: 'To Do', statusCategory: { key: 'new' } });
        const started = { issueId: 'AIDEVEX-8', type: 'workflow_started' } as const;
        await expect(
          provider({ get: todo, post: vi.fn() } as unknown as AtlassianClient).syncOnEvent(started)
        ).resolves.toBe('no_transition');
        const opened = { issueId: 'AIDEVEX-8', type: 'pr_opened' } as const;
        await expect(
          provider({ get: todo, post: vi.fn() } as unknown as AtlassianClient).syncOnEvent(opened)
        ).resolves.toBe('no_transition');
      });

      it('reports no_transition when a done ticket is asked to move to In Progress', async () => {
        const get = answering({ name: 'Done', statusCategory: { key: 'done' } });
        const client = { get, post: vi.fn() } as unknown as AtlassianClient;
        await expect(
          provider(client).syncOnEvent({ issueId: 'AIDEVEX-8', type: 'workflow_started' })
        ).resolves.toBe('no_transition');
      });

      it('compares the name only when the status has no category', async () => {
        const get = answering({ name: 'Closed' });
        const client = { get, post: vi.fn() } as unknown as AtlassianClient;
        await expect(provider(client).syncOnEvent(completed)).resolves.toBe('no_transition');
      });

      it('stays null when the status read fails', async () => {
        const get = vi.fn(async (path: string) => {
          if (path.includes('/transitions')) {
            return noMatch;
          }
          throw new AtlassianError(403, 'auth', 'forbidden');
        });
        const client = { get, post: vi.fn() } as unknown as AtlassianClient;
        await expect(provider(client).syncOnEvent(completed)).resolves.toBeNull();
      });

      it('stays null when the status read returns no status', async () => {
        const client = { get: answering(undefined), post: vi.fn() } as unknown as AtlassianClient;
        await expect(provider(client).syncOnEvent(completed)).resolves.toBeNull();
      });

      it('keeps the public transitionIssue void', async () => {
        const client = {
          get: answering({ name: 'To Do' }),
          post: vi.fn(),
        } as unknown as AtlassianClient;
        await expect(
          provider(client).transitionIssue('AIDEVEX-8', 'Done')
        ).resolves.toBeUndefined();
      });
    });

    it('does not read the status when a transition matches', async () => {
      const get = vi.fn(async () => transitions);
      const post = vi.fn(async () => ({}));
      const client = { get, post } as unknown as AtlassianClient;
      await expect(provider(client).syncOnEvent(completed)).resolves.toBeNull();
      expect(get).toHaveBeenCalledTimes(1);
    });

    it('reports a refused remote link, and still tries the transition', async () => {
      const get = vi.fn(async () => transitions);
      const post = vi.fn(async (path: string) => {
        if (path.includes('/remotelink')) {
          throw new AtlassianError(403, 'auth', 'refused');
        }
        return {};
      });
      const client = { get, post } as unknown as AtlassianClient;
      await expect(provider(client).syncOnEvent(withPr)).resolves.toBe('forbidden');
      expect(post).toHaveBeenCalledTimes(2);
    });

    it('reports the first refused write when both are refused', async () => {
      const get = vi.fn(async () => transitions);
      const post = vi.fn(async (path: string) => {
        throw path.includes('/remotelink')
          ? new AtlassianError(401, 'auth', 'refused')
          : new AtlassianError(403, 'auth', 'refused');
      });
      const client = { get, post } as unknown as AtlassianClient;
      await expect(provider(client).syncOnEvent(withPr)).resolves.toBe('unauthorized');
    });

    it('keeps the public transitionIssue and addRemoteLink void and silent', async () => {
      const get = vi.fn(async () => transitions);
      const post = vi.fn(async () => {
        throw new AtlassianError(403, 'auth', 'refused');
      });
      const p = provider({ get, post } as unknown as AtlassianClient);
      await expect(p.transitionIssue('AIDEVEX-8', 'Done')).resolves.toBeUndefined();
      await expect(p.addRemoteLink('AIDEVEX-8', 'https://x', 't')).resolves.toBeUndefined();
    });
  });

  it('reports a refused pr_opened transition', async () => {
    const get = vi.fn(async () => ({ transitions: [{ id: '2', name: 'In Review' }] }));
    const post = vi.fn(async () => {
      throw new AtlassianError(403, 'auth', 'refused');
    });
    const client = { get, post } as unknown as AtlassianClient;
    await expect(
      provider(client).syncOnEvent({ issueId: 'AIDEVEX-8', type: 'pr_opened' })
    ).resolves.toBe('forbidden');
  });

  it('reports a refused workflow_started transition', async () => {
    const get = vi.fn(async () => {
      throw new AtlassianError(403, 'auth', 'forbidden');
    });
    const client = { get, post: vi.fn() } as unknown as AtlassianClient;
    await expect(
      provider(client).syncOnEvent({ issueId: 'AIDEVEX-8', type: 'workflow_started' })
    ).resolves.toBe('forbidden');
  });
});

describe('JiraProvider.searchIssues', () => {
  const hit = (key: string, project = 'AIDEVEX') => ({
    fields: { project: { key: project }, summary: `Summary of ${key}` },
    id: key.replace(/\D/g, ''),
    key,
  });

  /** A client whose `post` answers each call with the next page. */
  function pagedClient(pages: unknown[]) {
    const calls: { path: string; body: unknown }[] = [];
    const post = vi.fn(async (path: string, body: unknown) => {
      calls.push({ body, path });
      const page = pages[calls.length - 1];
      if (page instanceof Error) {
        throw page;
      }
      return page;
    });
    return {
      calls,
      client: { baseUrl: 'https://acme.atlassian.net', post } as unknown as AtlassianClient,
    };
  }

  it('returns each match with its key, summary and project key', async () => {
    const { client, calls } = pagedClient([
      { isLast: true, issues: [hit('AIDEVEX-1'), hit('OPS-2', 'OPS')] },
    ]);
    const result = await provider(client).searchIssues('status = Open', { maxResults: 50 });
    expect(result).toEqual({
      issues: [
        { key: 'AIDEVEX-1', projectKey: 'AIDEVEX', summary: 'Summary of AIDEVEX-1' },
        { key: 'OPS-2', projectKey: 'OPS', summary: 'Summary of OPS-2' },
      ],
      truncated: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/rest/api/3/search/jql');
    expect(calls[0]?.body).toMatchObject({
      fields: ['summary', 'project', 'status'],
      jql: 'status = Open',
    });
  });

  it('returns the status name when Jira reports one, and omits it otherwise', async () => {
    const { client } = pagedClient([
      {
        isLast: true,
        issues: [
          {
            ...hit('AIDEVEX-1'),
            fields: { ...hit('AIDEVEX-1').fields, status: { name: 'In Review' } },
          },
          hit('AIDEVEX-2'),
        ],
      },
    ]);
    const result = await provider(client).searchIssues('status = Open', { maxResults: 50 });
    expect(result.issues[0]?.status).toBe('In Review');
    expect(result.issues[1]).not.toHaveProperty('status');
  });

  it('follows nextPageToken until the last page', async () => {
    const { client, calls } = pagedClient([
      { issues: [hit('AIDEVEX-1')], nextPageToken: 'tok-1' },
      { issues: [hit('AIDEVEX-2')], nextPageToken: 'tok-2' },
      { isLast: true, issues: [hit('AIDEVEX-3')] },
    ]);
    const result = await provider(client).searchIssues('x', { maxResults: 50 });
    expect(result.issues.map((i) => i.key)).toEqual(['AIDEVEX-1', 'AIDEVEX-2', 'AIDEVEX-3']);
    expect(result.truncated).toBe(false);
    expect(calls.map((c) => (c.body as { nextPageToken?: string }).nextPageToken)).toEqual([
      undefined,
      'tok-1',
      'tok-2',
    ]);
  });

  it('flags truncation and stops paging when more than maxResults match', async () => {
    const { client, calls } = pagedClient([
      { issues: [hit('AIDEVEX-1'), hit('AIDEVEX-2')], nextPageToken: 'tok-1' },
      { issues: [hit('AIDEVEX-3'), hit('AIDEVEX-4')], nextPageToken: 'tok-2' },
      { isLast: true, issues: [hit('AIDEVEX-5')] },
    ]);
    const result = await provider(client).searchIssues('x', { maxResults: 3 });
    expect(result.truncated).toBe(true);
    expect(result.issues).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });

  it('is not truncated when exactly maxResults match', async () => {
    const { client } = pagedClient([
      { isLast: true, issues: [hit('AIDEVEX-1'), hit('AIDEVEX-2'), hit('AIDEVEX-3')] },
    ]);
    const result = await provider(client).searchIssues('x', { maxResults: 3 });
    expect(result.truncated).toBe(false);
    expect(result.issues).toHaveLength(3);
  });

  it('skips a row that has no key or no project', async () => {
    const { client } = pagedClient([
      {
        isLast: true,
        issues: [
          { fields: { summary: 'no key' }, id: '1' },
          { fields: {}, key: 'AIDEVEX-2' },
          hit('AIDEVEX-3'),
        ],
      },
    ]);
    const result = await provider(client).searchIssues('x', { maxResults: 50 });
    expect(result.issues.map((i) => i.key)).toEqual(['AIDEVEX-3']);
  });

  it('stops and reports truncation when Jira echoes the same page token', async () => {
    const post = vi.fn(async () => ({ issues: [], nextPageToken: 'same' }));
    const client = { baseUrl: 'https://acme.atlassian.net', post } as unknown as AtlassianClient;
    const result = await provider(client).searchIssues('x', { maxResults: 50 });
    expect(result).toEqual({ issues: [], truncated: true });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('stops after a page limit when every page is empty but the token keeps changing', async () => {
    let n = 0;
    const post = vi.fn(async () => ({ issues: [], nextPageToken: `tok-${++n}` }));
    const client = { baseUrl: 'https://acme.atlassian.net', post } as unknown as AtlassianClient;
    const result = await provider(client).searchIssues('x', { maxResults: 50 });
    expect(result.truncated).toBe(true);
    expect(post.mock.calls.length).toBeLessThanOrEqual(100);
  });

  it('lets a Jira rejection reach the caller with its status', async () => {
    const rejection = new AtlassianError(400, 'server', 'Atlassian request failed: 400');
    const { client } = pagedClient([rejection]);
    await expect(provider(client).searchIssues('not jql', { maxResults: 50 })).rejects.toBe(
      rejection
    );
  });
});

describe('JiraProvider.readIssue failure classes', () => {
  const failing = (err: Error) => stubClient({ '/issue/': err }).client;

  it.each([
    [new AtlassianError(401, 'auth', 'Atlassian auth failed: 401'), 'unauthorized'],
    [new AtlassianError(403, 'auth', 'Atlassian auth failed: 403'), 'forbidden'],
    [new AtlassianError(404, 'not_found', 'nope'), 'not_found'],
    [new AtlassianError(429, 'rate_limited', 'slow down'), 'rate_limited'],
    [new AtlassianError(500, 'server', 'boom'), 'server_error'],
    [new AtlassianError(400, 'server', 'bad'), 'rejected'],
    [new AtlassianError(422, 'server', 'bad'), 'rejected'],
    [new AtlassianError(0, 'timeout', 'timed out'), 'timeout'],
    [new AtlassianError(0, 'network', 'ECONNREFUSED'), 'network'],
    [new AtlassianError(302, 'redirect', 'moved'), 'redirect'],
    [new TypeError('unexpected shape'), 'unknown'],
  ] as const)('answers %# with the class %s', async (err, failure) => {
    const result = await provider(failing(err)).readIssue('SHMC-798');
    expect(result).toEqual({ failure, issue: null });
  });

  it('keeps fetchIssue returning null for the same failure', async () => {
    const client = failing(new AtlassianError(403, 'auth', 'no'));
    expect(await provider(client).fetchIssue('SHMC-798')).toBeNull();
  });

  it('reports no failure when the issue was read', async () => {
    const { client } = stubClient({ '/issue/AIDEVEX-8?': ISSUE });
    const result = await provider(client).readIssue('AIDEVEX-8');
    expect(result.failure).toBeUndefined();
    expect(result.issue?.id).toBe('AIDEVEX-8');
  });

  it('puts no provider text, URL or token in the answer', async () => {
    const secret = 'https://acme.atlassian.net/rest?token=SECRET Bearer abc';
    const result = await provider(failing(new AtlassianError(0, 'network', secret))).readIssue(
      'X-1'
    );
    // The answer is the class and nothing else: no field can carry the error text.
    expect(result).toEqual({ failure: 'network', issue: null });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|acme|Bearer/);
  });
});
