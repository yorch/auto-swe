import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConfluencePage,
  readConfluencePage,
  updateConfluencePage,
} from '../connectors/confluence.js';
import { createIssue, fetchIssue } from '../connectors/issueTracker.js';
import { appendNotionBlocks, createNotionPage, readNotionPage } from '../connectors/notion.js';
import { fetchZendeskTicket, postZendeskComment } from '../connectors/zendesk.js';
import { readSource, runTool, writeOutcome } from './genericActions.js';

vi.mock('@temporalio/activity', () => ({
  ApplicationFailure: {
    nonRetryable: (message: string) => {
      const err = new Error(message);
      return err;
    },
  },
  Context: {
    current: vi.fn(() => ({
      info: { attempt: 1, workflowExecution: { workflowId: 'wf-1' } },
    })),
  },
}));

vi.mock('@auto-swe/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@auto-swe/shared')>();
  return {
    ...mod,
    decryptConnectionApiToken: () => 'test-token',
  };
});

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    autonomyDecision: { findFirst: vi.fn() },
    connection: { findUnique: vi.fn() },
    workflowOutcomeReference: { create: vi.fn(), findFirst: vi.fn() },
    workflowRun: { findUnique: vi.fn() },
  },
}));

vi.mock('../connectors/notion.js', () => ({
  appendNotionBlocks: vi.fn(),
  createNotionPage: vi.fn(),
  readNotionPage: vi.fn(),
}));

vi.mock('../connectors/zendesk.js', () => ({
  fetchZendeskTicket: vi.fn(),
  postZendeskComment: vi.fn(),
}));

vi.mock('../connectors/issueTracker.js', () => ({
  createIssue: vi.fn(),
  fetchIssue: vi.fn(),
}));

vi.mock('../connectors/confluence.js', () => ({
  createConfluencePage: vi.fn(),
  readConfluencePage: vi.fn(),
  updateConfluencePage: vi.fn(),
}));

const { prisma } = await import('@auto-swe/shared/db');

function makeConnection(type: string, options?: { config?: unknown; token?: boolean }) {
  return {
    apiKeyAuthTag: options?.token ? Buffer.from('tag') : null,
    apiKeyCiphertext: options?.token ? Buffer.from('cipher') : null,
    apiKeyNonce: options?.token ? Buffer.from('nonce') : null,
    apiKeyVersion: 1,
    config: options?.config ?? { baseUrl: 'https://example.com' },
    isActive: true,
    type,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('input validation', () => {
  it('rejects a non-UUID connectionId for readSource', async () => {
    await expect(readSource({ connectionId: 'not-a-uuid' })).rejects.toThrow('Invalid input');
  });

  it('rejects an empty tool name for runTool', async () => {
    await expect(
      runTool({ connectionId: '5af1a0ac-d2a0-4896-ad7e-ca8845e819c5', inputs: {}, tool: '' })
    ).rejects.toThrow('Invalid input');
  });

  it('rejects a non-UUID connectionId for writeOutcome', async () => {
    await expect(writeOutcome({ connectionId: 'not-a-uuid', data: { ok: true } })).rejects.toThrow(
      'Invalid input'
    );
  });
});

describe('readSource', () => {
  it('reads from an http_api connection (placeholder)', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('http_api')
    );

    const result = await readSource({ connectionId: '5af1a0ac-d2a0-4896-ad7e-ca8845e819c5' });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('http_api');
    expect(result.placeholder).toBe(true);
  });

  it('reads from a notion connection', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (readNotionPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      blocks: [{ type: 'paragraph' }],
      page: { id: 'page-1', object: 'page', properties: {}, url: 'https://notion.so/page-1' },
    });

    const result = await readSource({
      connectionId: '5af1a0ac-d2a0-4896-ad7e-ca8845e819c5',
      query: { pageId: 'page-1' },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('notion');
    expect(result.data).toEqual({
      blocks: [{ type: 'paragraph' }],
      page: { id: 'page-1', object: 'page', properties: {}, url: 'https://notion.so/page-1' },
    });
  });

  it('throws when the notion connection has no page id', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );

    await expect(
      readSource({ connectionId: '5af1a0ac-d2a0-4896-ad7e-ca8845e819c5' })
    ).rejects.toThrow('Notion readSource requires a pageId');
  });

  it('throws when the connection is inactive', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      isActive: false,
      type: 'http_api',
    });

    await expect(
      readSource({ connectionId: '5af1a0ac-d2a0-4896-ad7e-ca8845e819c5' })
    ).rejects.toThrow('not found or inactive');
  });
});

describe('writeOutcome approval guard', () => {
  const args = {
    connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
    data: { blocks: [{ type: 'paragraph' }], pageId: 'page-1' },
  };
  const publishedAt = new Date('2026-01-01T00:00:00Z');

  beforeEach(() => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'run-1' });
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (appendNotionBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      appended: 1,
      pageId: 'page-1',
    });
  });

  it('refuses when the latest publish decision requires approval and none was recorded', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        createdAt: publishedAt,
        payload: { decision: 'require_approval' },
        policyName: 'default',
        riskClass: 'internal_write',
      })
      .mockResolvedValueOnce(null);

    await expect(writeOutcome(args)).rejects.toThrow('requires human approval');
    expect(appendNotionBlocks).not.toHaveBeenCalled();
  });

  it('writes when an approval was recorded after the publish decision', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        createdAt: publishedAt,
        payload: { decision: 'require_approval' },
      })
      .mockResolvedValueOnce({ id: 'approval-1' });

    const result = await writeOutcome(args);
    expect(result.ok).toBe(true);
  });

  it('writes when the publish decision is auto', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      createdAt: publishedAt,
      payload: { decision: 'auto' },
    });

    const result = await writeOutcome(args);
    expect(result.ok).toBe(true);
  });

  it('does not gate a run that recorded no publish decision', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const result = await writeOutcome(args);
    expect(result.ok).toBe(true);
  });
});

describe('writeOutcome', () => {
  it('throws for a notion connection without a token', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion')
    );

    await expect(
      writeOutcome({
        connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
        data: { page: { title: 'Q3' } },
      })
    ).rejects.toThrow('Connection API token is required');
  });

  it('appends blocks to a notion page', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (appendNotionBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      appended: 1,
      pageId: 'page-1',
    });

    const result = await writeOutcome({
      connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
      data: {
        blocks: [{ type: 'paragraph' }],
        pageId: 'page-1',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('notion');
    expect(result.reference).toBe('page-1');
  });

  it('creates a new notion page', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (createNotionPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      pageId: 'new-page',
      url: 'https://notion.so/new-page',
    });

    const result = await writeOutcome({
      connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
      data: {
        pageId: 'parent-1',
        title: 'Draft',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('notion');
    expect(result.reference).toBe('https://notion.so/new-page');
  });

  it('appends text to a notion page as paragraph blocks', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (appendNotionBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      appended: 2,
      pageId: 'page-1',
    });

    const result = await writeOutcome({
      connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
      data: { pageId: 'page-1', text: 'Line one\nLine two' },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('notion');
    expect(result.reference).toBe('page-1');
    expect(appendNotionBlocks).toHaveBeenCalledWith({ apiToken: expect.any(String) }, 'page-1', [
      {
        paragraph: { rich_text: [{ text: { content: 'Line one' }, type: 'text' }] },
        type: 'paragraph',
      },
      {
        paragraph: { rich_text: [{ text: { content: 'Line two' }, type: 'text' }] },
        type: 'paragraph',
      },
    ]);
  });

  it('throws when the notion payload has no text, blocks, or create fields', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );

    await expect(
      writeOutcome({
        connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
        data: { unknown: 'field' },
      })
    ).rejects.toThrow(
      'Notion writeOutcome data must include text, blocks, or a create-page request'
    );
  });

  it('records an outcome reference when nodeId is provided', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
    });
    (appendNotionBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      appended: 1,
      pageId: 'page-1',
    });

    await writeOutcome({
      connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
      data: { blocks: [{ type: 'paragraph' }], pageId: 'page-1' },
      nodeId: 'node-1',
    });

    expect(prisma.workflowOutcomeReference.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attempt: 1,
        connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
        nodeId: 'node-1',
        runId: '11111111-1111-4111-8111-111111111111',
      }),
    });
  });

  it('returns a stored outcome reference on retry without re-calling the provider', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
    });
    (prisma.workflowOutcomeReference.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      result: {
        connectionType: 'notion',
        ok: true,
        reference: 'stored-page',
      },
    });
    (appendNotionBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      appended: 1,
      pageId: 'page-1',
    });

    const result = await writeOutcome({
      connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
      data: { blocks: [{ type: 'paragraph' }], pageId: 'page-1' },
      nodeId: 'node-1',
    });

    expect(result).toEqual({ connectionType: 'notion', ok: true, reference: 'stored-page' });
    expect(appendNotionBlocks).not.toHaveBeenCalled();
    // The lookup must not key on the Temporal attempt: a retry is a new attempt
    // number, so an attempt-scoped key could never find the previous write.
    expect(prisma.workflowOutcomeReference.findFirst).toHaveBeenCalledWith({
      orderBy: { attempt: 'asc' },
      where: {
        connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
        nodeId: 'node-1',
        runId: '11111111-1111-4111-8111-111111111111',
      },
    });
  });

  it('returns the stored result on the second call and does not repeat the external write', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
    });
    (prisma.workflowOutcomeReference.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        result: {
          connectionType: 'notion',
          ok: true,
          reference: 'page-1',
        },
      });
    (appendNotionBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      appended: 1,
      pageId: 'page-1',
    });

    const args = {
      connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
      data: { blocks: [{ type: 'paragraph' }], pageId: 'page-1' },
      nodeId: 'node-1',
    };

    const first = await writeOutcome(args);
    const second = await writeOutcome(args);

    expect(first).toEqual({ connectionType: 'notion', ok: true, reference: 'page-1' });
    expect(second).toEqual(first);
    expect(appendNotionBlocks).toHaveBeenCalledTimes(1);
    expect(prisma.workflowOutcomeReference.create).toHaveBeenCalledTimes(1);
  });
});

describe('runTool', () => {
  it('fetches a zendesk ticket via fetchTicket tool', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('zendesk', { config: { email: 'a@b.com', subdomain: 'x' }, token: true })
    );
    (fetchZendeskTicket as ReturnType<typeof vi.fn>).mockResolvedValue({
      ticket: { description: 'Help', id: 42, status: 'open', subject: 'Problem' },
    });

    const result = await runTool({
      connectionId: 'e9108636-3b75-440c-a4f9-987449669502',
      inputs: { ticketId: '42' },
      tool: 'fetchTicket',
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('zendesk');
    expect(result.output).toEqual({
      ticket: { description: 'Help', id: 42, status: 'open', subject: 'Problem' },
    });
  });

  it('posts a zendesk comment via postComment tool', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('zendesk', { config: { email: 'a@b.com', subdomain: 'x' }, token: true })
    );
    (postZendeskComment as ReturnType<typeof vi.fn>).mockResolvedValue({
      comment: { body: 'reply', public: false },
      ticketId: '42',
    });

    const result = await runTool({
      connectionId: 'e9108636-3b75-440c-a4f9-987449669502',
      inputs: { body: 'reply', public: false, ticketId: '42' },
      tool: 'postComment',
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('zendesk');
    expect(result.output).toEqual({ comment: { body: 'reply', public: false }, ticketId: '42' });
  });

  it('throws for unsupported zendesk tool', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('zendesk', { config: { email: 'a@b.com', subdomain: 'x' }, token: true })
    );

    await expect(
      runTool({
        connectionId: 'e9108636-3b75-440c-a4f9-987449669502',
        inputs: {},
        tool: 'deleteTicket',
      })
    ).rejects.toThrow('Unsupported Zendesk tool: deleteTicket');
  });
});

describe('readSource', () => {
  it('fetches a zendesk ticket', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('zendesk', { config: { email: 'a@b.com', subdomain: 'x' }, token: true })
    );
    (fetchZendeskTicket as ReturnType<typeof vi.fn>).mockResolvedValue({
      ticket: { description: 'Help', id: 42, status: 'open', subject: 'Problem' },
    });

    const result = await readSource({
      connectionId: 'e9108636-3b75-440c-a4f9-987449669502',
      query: { ticketId: '42' },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('zendesk');
    expect(result.data).toEqual({
      ticket: { description: 'Help', id: 42, status: 'open', subject: 'Problem' },
    });
  });
});

describe('writeOutcome', () => {
  it('posts a zendesk comment', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('zendesk', { config: { email: 'a@b.com', subdomain: 'x' }, token: true })
    );
    (postZendeskComment as ReturnType<typeof vi.fn>).mockResolvedValue({
      comment: { body: 'reply', public: false },
      ticketId: '42',
    });

    const result = await writeOutcome({
      connectionId: 'e9108636-3b75-440c-a4f9-987449669502',
      data: { body: 'reply', ticketId: '42' },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('zendesk');
    expect(result.reference).toBe('42');
  });

  it('creates an issue_tracker issue', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('issue_tracker', { config: { provider: 'linear' }, token: true })
    );
    (createIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'issue-1',
      url: 'https://linear.app/issue/TEAM-1',
    });

    const result = await writeOutcome({
      connectionId: 'bd4483f7-1fcc-4abe-916c-deab2811a4dc',
      data: { description: 'A bug', projectKey: 'team-uuid', title: 'Bug' },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('issue_tracker');
    expect(result.reference).toBe('https://linear.app/issue/TEAM-1');
  });
});

describe('readSource', () => {
  it('fetches an issue_tracker issue', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('issue_tracker', { config: { provider: 'linear' }, token: true })
    );
    (fetchIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'issue-1',
      identifier: 'TEAM-1',
      title: 'Bug',
      url: 'https://linear.app/issue/TEAM-1',
    });

    const result = await readSource({
      connectionId: 'bd4483f7-1fcc-4abe-916c-deab2811a4dc',
      query: { issueId: 'TEAM-1' },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('issue_tracker');
    expect(result.data).toEqual({
      id: 'issue-1',
      identifier: 'TEAM-1',
      title: 'Bug',
      url: 'https://linear.app/issue/TEAM-1',
    });
  });
});

describe('runTool', () => {
  it('creates an issue via the issue_tracker createIssue tool', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('issue_tracker', { config: { provider: 'jira' }, token: true })
    );
    (createIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '10001',
      identifier: 'PROJ-42',
      url: 'https://x.atlassian.net/browse/PROJ-42',
    });

    const result = await runTool({
      connectionId: 'bd4483f7-1fcc-4abe-916c-deab2811a4dc',
      inputs: { description: 'A task', projectKey: 'PROJ', title: 'Task' },
      tool: 'createIssue',
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('issue_tracker');
    expect(result.output).toEqual({
      id: '10001',
      identifier: 'PROJ-42',
      url: 'https://x.atlassian.net/browse/PROJ-42',
    });
  });
});

const confluenceConfig = { baseUrl: 'https://x.atlassian.net', email: 'a@b.com' };
const confluenceConnectionId = '4dcf895a-9ed7-450c-8858-e45b8415db4b';

describe('confluence readSource', () => {
  it('reads a page and returns its plain text', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('confluence', { config: confluenceConfig, token: true })
    );
    (readConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      bodyText: 'Steps',
      id: '123',
      title: 'Runbook',
      url: 'https://x.atlassian.net/wiki/pages/123',
      version: 2,
    });

    const result = await readSource({
      connectionId: confluenceConnectionId,
      query: { pageId: '123' },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('confluence');
    expect(result.data).toEqual({
      bodyText: 'Steps',
      id: '123',
      title: 'Runbook',
      url: 'https://x.atlassian.net/wiki/pages/123',
      version: 2,
    });
    expect(readConfluencePage).toHaveBeenCalledWith(
      expect.objectContaining({ apiToken: 'test-token' }),
      '123'
    );
  });

  it('throws when no page id is supplied', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('confluence', { config: confluenceConfig, token: true })
    );

    await expect(readSource({ connectionId: confluenceConnectionId })).rejects.toThrow(
      'Confluence readSource requires a pageId'
    );
  });
});

describe('confluence writeOutcome', () => {
  beforeEach(() => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('confluence', { config: confluenceConfig, token: true })
    );
  });

  it('creates a page when no target page is named', async () => {
    (createConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '9',
      url: 'https://x.atlassian.net/wiki/spaces/ENG/pages/9',
      version: 1,
    });

    const result = await writeOutcome({
      connectionId: confluenceConnectionId,
      data: { bodyText: 'Draft', spaceKey: 'ENG', title: 'From a ticket' },
    });

    expect(result).toEqual({
      connectionType: 'confluence',
      ok: true,
      reference: 'https://x.atlassian.net/wiki/spaces/ENG/pages/9',
    });
    expect(createConfluencePage).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ baseUrl: confluenceConfig.baseUrl }),
      }),
      expect.objectContaining({ bodyText: 'Draft', spaceKey: 'ENG', title: 'From a ticket' })
    );
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });

  it('updates the named page instead of creating one', async () => {
    (updateConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '9',
      url: 'https://x.atlassian.net/wiki/pages/9',
      version: 3,
    });

    const result = await writeOutcome({
      connectionId: confluenceConnectionId,
      data: { bodyText: 'Draft', targetPageId: '9', title: 'Doc' },
    });

    expect(result).toEqual({
      connectionType: 'confluence',
      ok: true,
      reference: 'https://x.atlassian.net/wiki/pages/9',
    });
    expect(updateConfluencePage).toHaveBeenCalledWith(
      expect.anything(),
      '9',
      expect.objectContaining({ bodyText: 'Draft', title: 'Doc' })
    );
    expect(createConfluencePage).not.toHaveBeenCalled();
  });

  it('refuses a write with no body', async () => {
    await expect(
      writeOutcome({ connectionId: confluenceConnectionId, data: { title: 'Doc' } })
    ).rejects.toThrow('Confluence writeOutcome requires bodyText');
  });

  it('refuses a create with no title', async () => {
    await expect(
      writeOutcome({ connectionId: confluenceConnectionId, data: { bodyText: 'Draft' } })
    ).rejects.toThrow('requires a title to create a page');
  });

  it('uses the fallback title when the request named none', async () => {
    (createConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '9',
      url: 'https://x.atlassian.net/wiki/spaces/ENG/pages/9',
      version: 1,
    });

    // A form submits an untouched optional field as `''`, and no binding can say
    // "the first non-empty of these", so the caller passes the source's title and
    // the choice is made here.
    await writeOutcome({
      connectionId: confluenceConnectionId,
      data: { bodyText: 'Draft', fallbackTitle: 'From the issue', title: '' },
    });

    expect(createConfluencePage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: 'From the issue' })
    );
  });

  it('propagates a connector failure instead of reporting success', async () => {
    (createConfluencePage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Confluence API error (400)')
    );

    await expect(
      writeOutcome({
        connectionId: confluenceConnectionId,
        data: { bodyText: 'Draft', title: 'Doc' },
      })
    ).rejects.toThrow('Confluence API error (400)');
  });
});

describe('confluence runTool', () => {
  beforeEach(() => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('confluence', { config: confluenceConfig, token: true })
    );
  });

  it('creates a page', async () => {
    (createConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '9',
      url: 'https://x.atlassian.net/wiki/pages/9',
      version: 1,
    });

    const result = await runTool({
      connectionId: confluenceConnectionId,
      inputs: { bodyText: 'Draft', spaceKey: 'ENG', title: 'Doc' },
      tool: 'createPage',
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('confluence');
  });

  it('updates a page', async () => {
    (updateConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '9',
      url: 'https://x.atlassian.net/wiki/pages/9',
      version: 2,
    });

    const result = await runTool({
      connectionId: confluenceConnectionId,
      inputs: { bodyText: 'New', pageId: '9' },
      tool: 'updatePage',
    });
    expect(result.ok).toBe(true);
    expect(updateConfluencePage).toHaveBeenCalledWith(
      expect.anything(),
      '9',
      expect.objectContaining({ bodyText: 'New' })
    );
  });

  it('rejects an unknown tool', async () => {
    await expect(
      runTool({ connectionId: confluenceConnectionId, inputs: {}, tool: 'deletePage' })
    ).rejects.toThrow('Unsupported Confluence tool');
  });

  it('forwards a caller-supplied version rather than refreshing it', async () => {
    (updateConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '9',
      url: 'https://x.atlassian.net/wiki/pages/9',
      version: 8,
    });

    await runTool({
      connectionId: confluenceConnectionId,
      inputs: { bodyText: 'Draft', pageId: '9', version: 7 },
      tool: 'updatePage',
    });

    expect(updateConfluencePage).toHaveBeenCalledWith(
      expect.anything(),
      '9',
      expect.objectContaining({ bodyText: 'Draft', version: 7 })
    );
  });

  it('refuses a version that is not a positive whole number', async () => {
    await expect(
      runTool({
        connectionId: confluenceConnectionId,
        inputs: { bodyText: 'Draft', pageId: '9', version: 0 },
        tool: 'updatePage',
      })
    ).rejects.toThrow('positive whole number');
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });
});

describe('runTool approval guard', () => {
  const publishedAt = new Date('2026-01-01T00:00:00Z');

  beforeEach(() => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'run-1' });
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('confluence', { config: confluenceConfig, token: true })
    );
  });

  it('refuses a mutating tool when the policy required approval and none was recorded', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        createdAt: publishedAt,
        payload: { decision: 'require_approval' },
        policyName: 'default',
        riskClass: 'external_write',
      })
      .mockResolvedValueOnce(null);

    // `runTool` used to bypass the gate `writeOutcome` applies, so a template that
    // recorded "approval required" and then wrote through a tool published anyway.
    await expect(
      runTool({
        connectionId: confluenceConnectionId,
        inputs: { bodyText: 'Draft', pageId: '9' },
        tool: 'updatePage',
      })
    ).rejects.toThrow('requires human approval');
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });

  it('writes through a tool when an approval was recorded', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        createdAt: publishedAt,
        payload: { decision: 'require_approval' },
      })
      .mockResolvedValueOnce({ id: 'approval-1' });
    (updateConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '9',
      url: 'https://x.atlassian.net/wiki/pages/9',
      version: 2,
    });

    const result = await runTool({
      connectionId: confluenceConnectionId,
      inputs: { bodyText: 'Draft', pageId: '9' },
      tool: 'updatePage',
    });
    expect(result.ok).toBe(true);
  });

  it('does not gate a read tool', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      createdAt: publishedAt,
      payload: { decision: 'require_approval' },
      policyName: 'default',
    });
    (readConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      bodyText: 'Body',
      id: '9',
      title: 'Runbook',
      url: 'https://x.atlassian.net/wiki/pages/9',
      version: 1,
    });

    const result = await runTool({
      connectionId: confluenceConnectionId,
      inputs: { pageId: '9' },
      tool: 'fetchPage',
    });

    expect(result.ok).toBe(true);
    // The gate is not consulted at all for a read: a run whose policy demanded
    // approval for a write has not asked for one to look a page up.
    expect(prisma.autonomyDecision.findFirst).not.toHaveBeenCalled();
  });
});
