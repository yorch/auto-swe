import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedFigmaConfig } from '../registry.js';
import { FigmaProvider } from './figma.js';

const config: ResolvedFigmaConfig = { apiToken: 'figd_test', enabled: true, maxNodes: 12 };

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    json: async () => body,
    ok,
    status,
    text: async () => JSON.stringify(body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FigmaProvider.fetchDesignSummary', () => {
  it('summarizes a node response with frames, text, and color/font tokens', async () => {
    const nodesBody = {
      name: 'Checkout',
      nodes: {
        '1:23': {
          document: {
            children: [
              {
                children: [
                  {
                    characters: 'Pay now',
                    id: '1:25',
                    style: { fontFamily: 'Inter', fontSize: 16, fontWeight: 600 },
                    type: 'TEXT',
                  },
                ],
                fills: [{ color: { a: 1, b: 0, g: 0.5, r: 1 }, type: 'SOLID', visible: true }],
                id: '1:24',
                name: 'PrimaryButton',
                type: 'FRAME',
              },
            ],
            id: '1:23',
            name: 'Checkout Screen',
            type: 'FRAME',
          },
        },
      },
    };
    // First call: nodes. Second call: variables/local (return empty meta).
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => nodesBody,
        ok: true,
        status: 200,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        json: async () => ({ meta: { variables: {} } }),
        ok: true,
        status: 200,
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new FigmaProvider(config);
    const summary = await provider.fetchDesignSummary({
      fileKey: 'KEY',
      nodeIds: ['1:23'],
      url: 'https://www.figma.com/file/KEY/Checkout?node-id=1-23',
    });

    expect(summary).not.toBeNull();
    expect(summary?.fileName).toBe('Checkout');
    expect(summary?.nodes[0].name).toBe('Checkout Screen');
    expect(summary?.nodes[0].childNames).toContain('PrimaryButton');
    expect(summary?.nodes[0].texts).toContain('Pay now');
    // #ff8000 from rgba(1, 0.5, 0)
    expect(summary?.tokens.some((t) => t.value === '#ff8000')).toBe(true);
    expect(summary?.tokens.some((t) => t.name === 'font:Inter / 600 / 16px')).toBe(true);

    // Sends the Figma auth header.
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall[1].headers['X-Figma-Token']).toBe('figd_test');
  });

  it('returns null (never throws) on an API error', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ err: 'forbidden' }, false, 403));
    const provider = new FigmaProvider(config);
    const summary = await provider.fetchDesignSummary({
      fileKey: 'KEY',
      nodeIds: ['1:23'],
      url: 'https://www.figma.com/file/KEY/x?node-id=1-23',
    });
    expect(summary).toBeNull();
  });

  it('survives a failing variables call and still returns the node summary', async () => {
    const nodesBody = {
      name: 'F',
      nodes: { '1:1': { document: { id: '1:1', name: 'Root', type: 'FRAME' } } },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => nodesBody,
        ok: true,
        status: 200,
        text: async () => '',
      })
      .mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'no variables' });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new FigmaProvider(config);
    const summary = await provider.fetchDesignSummary({
      fileKey: 'KEY',
      nodeIds: ['1:1'],
      url: 'https://www.figma.com/file/KEY/x?node-id=1-1',
    });
    expect(summary?.nodes[0].name).toBe('Root');
  });
});
