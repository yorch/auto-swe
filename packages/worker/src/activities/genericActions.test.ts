import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendNotionBlocks, createNotionPage, readNotionPage } from '../connectors/notion.js';
import { fetchZendeskTicket, postZendeskComment } from '../connectors/zendesk.js';
import { readSource, runTool, writeOutcome } from './genericActions.js';

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

describe('readSource', () => {
  it('reads from an http_api connection (placeholder)', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('http_api')
    );

    const result = await readSource({ connectionId: 'conn-1' });
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

    const result = await readSource({ connectionId: 'conn-1', query: { pageId: 'page-1' } });
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

    await expect(readSource({ connectionId: 'conn-1' })).rejects.toThrow(
      'Notion readSource requires a pageId'
    );
  });

  it('throws when the connection is inactive', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      isActive: false,
      type: 'http_api',
    });

    await expect(readSource({ connectionId: 'conn-1' })).rejects.toThrow('not found or inactive');
  });
});

describe('writeOutcome', () => {
  it('throws for a notion connection without a token', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion')
    );

    await expect(
      writeOutcome({ connectionId: 'conn-2', data: { page: { title: 'Q3' } } })
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
      connectionId: 'conn-2',
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
      connectionId: 'conn-2',
      data: {
        pageId: 'parent-1',
        title: 'Draft',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('notion');
    expect(result.reference).toBe('https://notion.so/new-page');
  });

  it('throws when the notion payload has no blocks or create fields', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );

    await expect(
      writeOutcome({ connectionId: 'conn-2', data: { unknown: 'field' } })
    ).rejects.toThrow('Notion writeOutcome data must include blocks or a create-page request');
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
      connectionId: 'conn-3',
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
      connectionId: 'conn-3',
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
      runTool({ connectionId: 'conn-3', inputs: {}, tool: 'deleteTicket' })
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

    const result = await readSource({ connectionId: 'conn-3', query: { ticketId: '42' } });
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
      connectionId: 'conn-3',
      data: { body: 'reply', ticketId: '42' },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('zendesk');
    expect(result.reference).toBe('42');
  });
});
