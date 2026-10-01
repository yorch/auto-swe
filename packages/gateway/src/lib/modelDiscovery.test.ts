import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@auto-swe/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The crypto helper reads the key lazily; set it before anything encrypts.
process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { encryptSecret } from '@auto-swe/shared/lib/crypto';
import {
  discoverProviderModels,
  listProviderModels,
  parseModelListPage,
} from './modelDiscovery.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

describe('parseModelListPage', () => {
  it('reads Anthropic ids and display names, and pages by cursor', () => {
    expect(
      parseModelListPage('anthropic', {
        data: [{ display_name: 'Claude Opus 6', id: 'claude-opus-6', type: 'model' }],
        has_more: true,
        last_id: 'claude-opus-6',
      })
    ).toEqual({
      models: [{ displayName: 'Claude Opus 6', kind: 'CHAT', modelId: 'claude-opus-6' }],
      next: { after_id: 'claude-opus-6' },
    });
  });

  it("strips Google's models/ prefix and reads the kind from its generation methods", () => {
    const page = parseModelListPage('google', {
      models: [
        {
          displayName: 'Gemini 4 Pro',
          name: 'models/gemini-4-pro',
          supportedGenerationMethods: ['generateContent'],
        },
        { name: 'models/gemini-embedding-002', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] },
      ],
      nextPageToken: 'tok',
    });
    expect(page.models).toEqual([
      { displayName: 'Gemini 4 Pro', kind: 'CHAT', modelId: 'gemini-4-pro' },
      { displayName: null, kind: 'EMBEDDING', modelId: 'gemini-embedding-002' },
    ]);
    expect(page.next).toEqual({ pageToken: 'tok' });
  });

  it('reads an OpenAI-shaped list, guessing embeddings by name, with no paging', () => {
    expect(
      parseModelListPage('openai', {
        data: [{ id: 'gpt-6.2' }, { id: 'text-embedding-4' }],
        object: 'list',
      })
    ).toEqual({
      models: [
        { displayName: null, kind: 'CHAT', modelId: 'gpt-6.2' },
        { displayName: null, kind: 'EMBEDDING', modelId: 'text-embedding-4' },
      ],
      next: null,
    });
  });

  it('yields nothing for a shape it does not recognise', () => {
    expect(parseModelListPage('openai', { unexpected: true })).toEqual({ models: [], next: null });
    expect(parseModelListPage('google', null)).toEqual({ models: [], next: null });
  });
});

describe('listProviderModels', () => {
  it('follows Anthropic pages and asks for the largest page first', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'b' }], has_more: false, last_id: 'b' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await listProviderModels({ apiKey: 'k', provider: 'anthropic' });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.models.map((m) => m.modelId)).toEqual(['a', 'b']);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('limit=1000');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('after_id=a');
  });

  it('drops speech, image and moderation models a provider lists beside its chat models', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            'gpt-6.2',
            'text-embedding-4',
            'tts-1',
            'whisper-1',
            'dall-e-3',
            'gpt-image-2',
            'omni-moderation-latest',
            'gpt-6-realtime',
            'gpt-6-audio-preview',
          ].map((id) => ({ id })),
        })
      )
    );
    const result = await listProviderModels({ apiKey: 'k', provider: 'openai' });
    expect(result.ok && result.models.map((m) => m.modelId)).toEqual([
      'gpt-6.2',
      'text-embedding-4',
    ]);
  });

  it('reports an HTTP failure and never fetches a private apiBase', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 401)));
    expect(await listProviderModels({ apiKey: 'bad', provider: 'openai' })).toEqual({
      error: 'HTTP 401',
      ok: false,
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const blocked = await listProviderModels({
      apiBase: 'http://169.254.169.254/v1',
      apiKey: 'k',
      provider: 'vllm',
    });
    expect(blocked.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('discoverProviderModels', () => {
  function credential(provider: string, apiBase: string | null = null) {
    const sealed = encryptSecret(`sk-${provider}`);
    return {
      apiBase,
      apiKeyAuthTag: sealed.authTag,
      apiKeyCiphertext: sealed.ciphertext,
      apiKeyNonce: sealed.nonce,
      keyVersion: sealed.keyVersion,
      provider,
      scope: 'GLOBAL',
    };
  }

  function fakePrisma(
    credentials: unknown[],
    catalog: Array<{ provider: string; modelId: string }>
  ) {
    return {
      modelCatalogEntry: { findMany: vi.fn().mockResolvedValue(catalog) },
      providerCredential: { findMany: vi.fn().mockResolvedValue(credentials) },
    } as unknown as PrismaClient;
  }

  it('returns only what nothing prices, per provider, and one failure never stops the rest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.startsWith('https://api.openai.com')
          ? jsonResponse({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-6.2' }, { id: 'acme-ft' }] })
          : jsonResponse({}, 401)
      )
    );
    const prisma = fakePrisma(
      [credential('anthropic'), credential('openai')],
      [{ modelId: 'acme-ft', provider: 'openai' }]
    );
    expect(await discoverProviderModels(prisma)).toEqual([
      { error: 'HTTP 401', models: [], ok: false, provider: 'anthropic' },
      {
        // gpt-5.5 is built in and acme-ft is cataloged: only gpt-6.2 is new.
        models: [{ displayName: null, kind: 'CHAT', modelId: 'gpt-6.2', spec: 'openai/gpt-6.2' }],
        ok: true,
        provider: 'openai',
      },
    ]);
  });

  it('decrypts each key only to call its own provider', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await discoverProviderModels(fakePrisma([credential('openai')], []));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-openai');
  });
});
