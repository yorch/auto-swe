import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addComment: vi.fn(async (..._args: unknown[]) => true),
  createProvider: vi.fn(),
  findConnections: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  findRunInput: vi.fn(),
  resolveConfig: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findMany: (...args: unknown[]) => mocks.findConnections(...args) },
    runInput: { findUnique: (...args: unknown[]) => mocks.findRunInput(...args) },
  },
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveIssueTrackerConfig: () => mocks.resolveConfig(),
}));
vi.mock('@auto-swe/shared/lib/integrations/registry', () => ({
  createIssueTrackerProvider: (...args: unknown[]) => mocks.createProvider(...args),
}));

import {
  MAX_TICKET_COMMENT_CHARS,
  postTicketComment,
  TICKET_COMMENT_TRUNCATION_MARKER,
} from './postTicketComment.js';

const GITHUB_ID = 'acme/web#7';
const OWN_REPO = { organizationName: 'Acme', repoName: 'Web' };
const JIRA = { apiToken: 't', baseUrl: 'https://acme.atlassian.net', provider: 'jira' };

function githubRun(overrides: Record<string, unknown> = {}) {
  mocks.resolveConfig.mockResolvedValue({ ...JIRA, provider: 'github' });
  mocks.findRunInput.mockResolvedValue({
    connection: OWN_REPO,
    externalTicketId: GITHUB_ID,
    knowledgeRepoSources: null,
    ticketIsSynthetic: false,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRunInput.mockResolvedValue({ externalTicketId: 'DEMO-4', ticketIsSynthetic: false });
  mocks.resolveConfig.mockResolvedValue(JIRA);
  mocks.createProvider.mockReturnValue({ addComment: mocks.addComment });
  mocks.addComment.mockResolvedValue(true);
  mocks.findConnections.mockResolvedValue([]);
});

describe('postTicketComment', () => {
  it("posts exactly one comment with the body to the run's ticket", async () => {
    await expect(postTicketComment({ body: 'X', workRequestId: 'wr-1' })).resolves.toEqual({
      posted: true,
    });
    expect(mocks.findRunInput).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wr-1' } })
    );
    expect(mocks.createProvider).toHaveBeenCalledWith(JIRA, expect.anything());
    expect(mocks.addComment).toHaveBeenCalledTimes(1);
    expect(mocks.addComment).toHaveBeenCalledWith('DEMO-4', 'X');
  });

  it('puts the heading on the first line, followed by a blank line', async () => {
    await postTicketComment({
      body: 'Evidence follows.',
      heading: 'auto-swe triage: NOT EXPLOITABLE',
      workRequestId: 'wr-1',
    });
    expect(mocks.addComment).toHaveBeenCalledWith(
      'DEMO-4',
      'auto-swe triage: NOT EXPLOITABLE\n\nEvidence follows.'
    );
  });

  it('ignores a blank heading', async () => {
    await postTicketComment({ body: 'X', heading: '  ', workRequestId: 'wr-1' });
    expect(mocks.addComment).toHaveBeenCalledWith('DEMO-4', 'X');
  });

  it('cuts a body over the limit and marks the cut', async () => {
    const body = 'a'.repeat(MAX_TICKET_COMMENT_CHARS + 5_000);
    await expect(postTicketComment({ body, workRequestId: 'wr-1' })).resolves.toEqual({
      posted: true,
    });
    const posted = mocks.addComment.mock.calls[0]?.[1] as string;
    expect(posted.length).toBe(MAX_TICKET_COMMENT_CHARS);
    expect(posted.endsWith(TICKET_COMMENT_TRUNCATION_MARKER)).toBe(true);
    expect(posted.startsWith('a'.repeat(1_000))).toBe(true);
  });

  it('does not split an emoji at the cut', async () => {
    const keep = MAX_TICKET_COMMENT_CHARS - TICKET_COMMENT_TRUNCATION_MARKER.length;
    // The emoji's high surrogate is the last code unit a plain cut would keep.
    const body = `${'a'.repeat(keep - 1)}😀${'b'.repeat(5_000)}`;
    await postTicketComment({ body, workRequestId: 'wr-1' });
    const posted = mocks.addComment.mock.calls[0]?.[1] as string;
    expect(posted).toBe(`${'a'.repeat(keep - 1)}${TICKET_COMMENT_TRUNCATION_MARKER}`);
    expect(posted.length).toBeLessThanOrEqual(MAX_TICKET_COMMENT_CHARS);
  });

  it('keeps an emoji that ends exactly at the cut', async () => {
    const keep = MAX_TICKET_COMMENT_CHARS - TICKET_COMMENT_TRUNCATION_MARKER.length;
    const body = `${'a'.repeat(keep - 2)}😀${'b'.repeat(5_000)}`;
    await postTicketComment({ body, workRequestId: 'wr-1' });
    const posted = mocks.addComment.mock.calls[0]?.[1] as string;
    expect(posted).toBe(`${'a'.repeat(keep - 2)}😀${TICKET_COMMENT_TRUNCATION_MARKER}`);
  });

  it.each(['github', 'linear'])(
    'neutralises @mentions and images in the comment for %s',
    async (provider) => {
      mocks.resolveConfig.mockResolvedValue({ ...JIRA, provider });
      if (provider === 'github') {
        githubRun();
      }
      await postTicketComment({
        body: 'cc @alice and @acme/security, mail bob@example.com\n![x](https://evil.example/p.png)',
        heading: '@here verdict',
        workRequestId: 'wr-1',
      });
      expect(mocks.addComment).toHaveBeenCalledWith(
        provider === 'github' ? GITHUB_ID : 'DEMO-4',
        '@‍here verdict\n\ncc @‍alice and @‍acme/security, mail bob@example.com\n[x](https://evil.example/p.png)'
      );
    }
  );

  it('leaves no image behind when several ! precede the bracket', async () => {
    githubRun();
    await postTicketComment({
      body: '!![x](https://evil.example/p.png) !!![y](u)',
      workRequestId: 'wr-1',
    });
    expect(mocks.addComment).toHaveBeenCalledWith(
      GITHUB_ID,
      '[x](https://evil.example/p.png) [y](u)'
    );
  });

  it('neutralises a mention inside emphasis', async () => {
    githubRun();
    await postTicketComment({ body: '_@alice_ and __@bob__', workRequestId: 'wr-1' });
    expect(mocks.addComment).toHaveBeenCalledWith(GITHUB_ID, '_@‍alice_ and __@‍bob__');
  });

  it('leaves @mentions and images as written for jira, which posts plain text', async () => {
    const body = 'cc @alice\n![x](https://evil.example/p.png)';
    await postTicketComment({ body, workRequestId: 'wr-1' });
    expect(mocks.addComment).toHaveBeenCalledWith('DEMO-4', body);
  });

  it.each(['jira', 'github', 'linear'])(
    'masks credential-shaped text before posting to %s',
    async (provider) => {
      mocks.resolveConfig.mockResolvedValue({ ...JIRA, provider });
      if (provider === 'github') {
        githubRun();
      }
      const token = `ghp_${'A'.repeat(36)}`;
      await postTicketComment({ body: `leaked ${token} here`, workRequestId: 'wr-1' });
      const posted = mocks.addComment.mock.calls[0]?.[1] as string;
      expect(posted).not.toContain(token);
      expect(posted).toBe('leaked *** here');
    }
  );

  it('leaves a body at the limit as written', async () => {
    const body = 'a'.repeat(MAX_TICKET_COMMENT_CHARS);
    await postTicketComment({ body, workRequestId: 'wr-1' });
    expect(mocks.addComment).toHaveBeenCalledWith('DEMO-4', body);
  });

  it.each([
    ['the run has no input row', null, /no ticket/],
    ['the run names no ticket', { externalTicketId: '', ticketIsSynthetic: false }, /no ticket/],
    [
      'the ticket id was generated by the platform',
      { externalTicketId: 'agent-1', ticketIsSynthetic: true },
      /generated by the platform/,
    ],
  ])('skips with a reason when %s', async (_label, row, reason) => {
    mocks.findRunInput.mockResolvedValue(row);
    const out = await postTicketComment({ body: 'X', workRequestId: 'wr-1' });
    expect(out).toEqual({ posted: false, reason: expect.stringMatching(reason) });
    expect(mocks.addComment).not.toHaveBeenCalled();
  });

  it('posts for a legacy run whose synthetic-ticket flag was never recorded', async () => {
    mocks.findRunInput.mockResolvedValue({ externalTicketId: 'DEMO-4', ticketIsSynthetic: null });
    await expect(postTicketComment({ body: 'X', workRequestId: 'wr-1' })).resolves.toEqual({
      posted: true,
    });
    expect(mocks.addComment).toHaveBeenCalledWith('DEMO-4', 'X');
  });

  it('skips with a reason when no tracker is configured', async () => {
    mocks.resolveConfig.mockResolvedValue({ provider: null });
    const out = await postTicketComment({ body: 'X', workRequestId: 'wr-1' });
    expect(out).toEqual({ posted: false, reason: expect.stringMatching(/no issue tracker/i) });
    expect(mocks.createProvider).not.toHaveBeenCalled();
  });

  it('skips with a reason when the tracker settings are incomplete or refused', async () => {
    mocks.createProvider.mockReturnValue(null);
    const out = await postTicketComment({ body: 'X', workRequestId: 'wr-1' });
    expect(out).toEqual({ posted: false, reason: expect.stringMatching(/settings/i) });
  });

  it('reports a comment the tracker did not accept, without throwing', async () => {
    mocks.addComment.mockResolvedValue(false);
    const out = await postTicketComment({ body: 'X', workRequestId: 'wr-1' });
    expect(out).toEqual({ posted: false, reason: expect.stringMatching(/did not accept/) });
  });

  it('reports a failed lookup, without throwing', async () => {
    mocks.findRunInput.mockRejectedValue(new Error('db down'));
    const out = await postTicketComment({ body: 'X', workRequestId: 'wr-1' });
    expect(out).toEqual({ posted: false, reason: expect.stringMatching(/could not be posted/) });
  });

  it('skips an empty body without a lookup', async () => {
    const out = await postTicketComment({ body: '  \n ', workRequestId: 'wr-1' });
    expect(out).toEqual({ posted: false, reason: expect.stringMatching(/empty/) });
    expect(mocks.findRunInput).not.toHaveBeenCalled();
  });
});

describe('postTicketComment on the GitHub tracker', () => {
  const REFUSED = {
    posted: false,
    reason: "the ticket's repository is not one this run targets",
  };

  it('refuses a ticket in a repository the run does not target', async () => {
    githubRun({ externalTicketId: 'attacker/public#1' });
    await expect(postTicketComment({ body: 'X', workRequestId: 'wr-1' })).resolves.toEqual(REFUSED);
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.addComment).not.toHaveBeenCalled();
  });

  it("allows a ticket in the run's own repository", async () => {
    githubRun();
    await expect(postTicketComment({ body: 'X', workRequestId: 'wr-1' })).resolves.toEqual({
      posted: true,
    });
    expect(mocks.addComment).toHaveBeenCalledWith(GITHUB_ID, 'X');
  });

  it('matches the owner and repository case-insensitively', async () => {
    githubRun({ externalTicketId: 'ACME/wEb#7' });
    await expect(postTicketComment({ body: 'X', workRequestId: 'wr-1' })).resolves.toEqual({
      posted: true,
    });
  });

  it('allows a repository a multi-repo launch was authorized against', async () => {
    githubRun({
      connection: null,
      externalTicketId: 'acme/api#3',
      knowledgeRepoSources: [{ orgId: 'o', repoId: 'repo-2', teamId: 't' }, null, { repoId: 4 }],
    });
    mocks.findConnections.mockResolvedValue([{ organizationName: 'acme', repoName: 'api' }]);
    await expect(postTicketComment({ body: 'X', workRequestId: 'wr-1' })).resolves.toEqual({
      posted: true,
    });
    expect(mocks.findConnections).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['repo-2'] }, type: 'git_repo' } })
    );
  });

  it('refuses a bare issue number, which names no repository', async () => {
    githubRun({ externalTicketId: '#7' });
    await expect(postTicketComment({ body: 'X', workRequestId: 'wr-1' })).resolves.toEqual(REFUSED);
    expect(mocks.addComment).not.toHaveBeenCalled();
  });

  it('refuses when the run records no repository at all', async () => {
    githubRun({ connection: null });
    await expect(postTicketComment({ body: 'X', workRequestId: 'wr-1' })).resolves.toEqual(REFUSED);
  });

  it('reports a failed repository lookup without throwing', async () => {
    githubRun({ connection: null, knowledgeRepoSources: [{ repoId: 'repo-2' }] });
    mocks.findConnections.mockRejectedValue(new Error('db down'));
    const out = await postTicketComment({ body: 'X', workRequestId: 'wr-1' });
    expect(out).toEqual({ posted: false, reason: expect.stringMatching(/could not be posted/) });
    expect(mocks.addComment).not.toHaveBeenCalled();
  });

  it.each(['jira', 'linear'])('does not apply the repository check to %s', async (provider) => {
    mocks.resolveConfig.mockResolvedValue({ ...JIRA, provider });
    mocks.findRunInput.mockResolvedValue({
      connection: null,
      externalTicketId: 'attacker/public#1',
      knowledgeRepoSources: null,
      ticketIsSynthetic: false,
    });
    await expect(postTicketComment({ body: 'X', workRequestId: 'wr-1' })).resolves.toEqual({
      posted: true,
    });
    expect(mocks.addComment).toHaveBeenCalledWith('attacker/public#1', 'X');
  });
});
