import { Context } from '@temporalio/activity';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    current: vi.fn(() => ({ info: { attempt: 1, workflowId: 'wf-1' } })),
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
    connection: { findUnique: vi.fn() },
    workflowOutcomeReference: { create: vi.fn(), findUnique: vi.fn() },
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
    (prisma.workflowOutcomeReference.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
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
