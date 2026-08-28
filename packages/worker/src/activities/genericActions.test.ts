import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readSource, runTool, writeOutcome } from './genericActions.js';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findUnique: vi.fn() },
  },
}));

const { prisma } = await import('@auto-swe/shared/db');

function makeConnection(type: string) {
  return {
    apiKeyAuthTag: null,
    apiKeyCiphertext: null,
    apiKeyNonce: null,
    apiKeyVersion: 1,
    config: { baseUrl: 'https://example.com' },
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

  it('throws when the connection is inactive', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      isActive: false,
      type: 'http_api',
    });

    await expect(readSource({ connectionId: 'conn-1' })).rejects.toThrow('not found or inactive');
  });
});

describe('writeOutcome', () => {
  it('returns a placeholder for a notion connection', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion')
    );

    const result = await writeOutcome({ connectionId: 'conn-2', data: { page: { title: 'Q3' } } });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('notion');
    expect(result.placeholder).toBe(true);
  });
});

describe('runTool', () => {
  it('returns a placeholder for a zendesk connection', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('zendesk')
    );

    const result = await runTool({
      connectionId: 'conn-3',
      inputs: { ticketId: '42' },
      tool: 'fetchTicket',
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('zendesk');
    expect(result.placeholder).toBe(true);
  });
});
