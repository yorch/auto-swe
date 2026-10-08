import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@auto-swe/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The crypto helper reads the key lazily; set it before anything encrypts.
process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { BUILTIN_MODELS } from '@auto-swe/shared/lib/builtinModels';
import { encryptSecret } from '@auto-swe/shared/lib/crypto';
import { SsrfBlockedError } from '@auto-swe/shared/lib/guardedDispatcher';
import {
  discoverProviderModels,
  isPrivateHostListed,
  listProviderModels,
  modelCallFetch,
  modelListRequest,
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
    ).toMatchObject({
      ids: ['claude-opus-6'],
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
    // `aqa` serves neither chat nor embeddings, but it is still listed.
    expect(page.ids).toEqual(['gemini-4-pro', 'gemini-embedding-002', 'aqa']);
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
    ).toMatchObject({
      ids: ['gpt-6.2', 'text-embedding-4'],
      models: [
        { displayName: null, kind: 'CHAT', modelId: 'gpt-6.2' },
        { displayName: null, kind: 'EMBEDDING', modelId: 'text-embedding-4' },
      ],
      next: null,
    });
  });

  it('yields nothing for a shape it does not recognise', () => {
    for (const body of [{ unexpected: true }, null, [], '<html>']) {
      expect(parseModelListPage('openai', body)).toMatchObject({
        ids: [],
        models: [],
        next: null,
        recognised: false,
      });
    }
    expect(parseModelListPage('google', null)).toMatchObject({ models: [], recognised: false });
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
    catalog: Array<{ provider: string; modelId: string; status?: string }>
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
      {
        complete: false,
        error: 'HTTP 401',
        models: [],
        ok: false,
        provider: 'anthropic',
        retirementCandidates: [],
      },
      {
        complete: true,
        // gpt-5.5 is built in and acme-ft is cataloged: only gpt-6.2 is new.
        models: [{ displayName: null, kind: 'CHAT', modelId: 'gpt-6.2', spec: 'openai/gpt-6.2' }],
        ok: true,
        provider: 'openai',
        retirementCandidates: expect.any(Array),
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

  describe('retirement candidates', () => {
    const builtinOpenAi = BUILTIN_MODELS.filter(
      (m) => m.provider === 'openai' && m.status === 'ACTIVE'
    );

    it('flags a priced model the provider no longer lists, never a retired or still-listed one', async () => {
      const [stillListed, ...gone] = builtinOpenAi;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ data: [{ id: stillListed?.modelId }, { id: 'tts-1' }] }))
      );
      const prisma = fakePrisma(
        [credential('openai')],
        [
          { modelId: 'acme-ft', provider: 'openai' },
          { modelId: 'acme-old', provider: 'openai', status: 'RETIRED' },
        ]
      );
      const [result] = await discoverProviderModels(prisma);
      const flagged = result?.retirementCandidates.map((c) => c.modelId);
      expect(flagged).toContain('acme-ft');
      expect(flagged).not.toContain('acme-old');
      expect(flagged).not.toContain(stillListed?.modelId);
      expect(gone.every((m) => flagged?.includes(m.modelId))).toBe(true);
    });

    it('counts a non-text id the provider lists as still listed', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ data: [{ id: 'whisper-1' }] }))
      );
      const [result] = await discoverProviderModels(
        fakePrisma([credential('openai')], [{ modelId: 'whisper-1', provider: 'openai' }])
      );
      expect(result?.retirementCandidates.map((c) => c.modelId)).not.toContain('whisper-1');
    });

    it('flags nothing when the listing is empty or cut short — absence proves nothing', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ data: [] }))
      );
      const [empty] = await discoverProviderModels(fakePrisma([credential('openai')], []));
      expect(empty).toMatchObject({ complete: false, ok: true, retirementCandidates: [] });

      // An Anthropic list that still says has_more after the page cap.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }))
      );
      const [partial] = await discoverProviderModels(fakePrisma([credential('anthropic')], []));
      expect(partial).toMatchObject({ complete: false, ok: true, retirementCandidates: [] });
    });
  });
});

describe('listProviderModels failures', () => {
  const SECRET = 'sk-TOPSECRET-1234';

  it('never lets a key or URL credential from a fetch error reach the result', async () => {
    // Node quotes the offending header value or URL, userinfo included.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError(
          `Headers.append: "Bearer ${SECRET}\r\nX-Evil: 1" is an invalid header value. bob:hunter2@host`
        );
      })
    );
    const result = await listProviderModels({
      apiKey: `${SECRET}\r\nX-Evil: 1`,
      provider: 'openai',
    });
    expect(result).toEqual({ error: 'request failed (TypeError)', ok: false });
    expect(JSON.stringify(result)).not.toMatch(/TOPSECRET|hunter2|Bearer/);
  });

  it('reports a timeout as a fixed string and keeps only a clean error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('x'), { name: 'TimeoutError' });
      })
    );
    expect(await listProviderModels({ apiKey: 'k', provider: 'openai' })).toEqual({
      error: 'timed out',
      ok: false,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new TypeError('fetch failed sk-LEAK'), {
          cause: { code: 'ECONNREFUSED', message: 'connect sk-LEAK' },
        });
      })
    );
    expect(await listProviderModels({ apiKey: 'k', provider: 'openai' })).toEqual({
      error: 'request failed (TypeError, ECONNREFUSED)',
      ok: false,
    });
  });

  it('refuses an apiBase with userinfo without echoing it, and a private one as blocked', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const withUserinfo = await listProviderModels({
      apiBase: 'https://bob:hunter2@openrouter.ai/api/v1',
      apiKey: 'k',
      provider: 'openrouter',
    });
    expect(withUserinfo).toEqual({ error: 'blocked address', ok: false });
    const local = await listProviderModels({
      apiBase: 'http://localhost:11434/v1',
      apiKey: 'k',
      provider: 'ollama',
    });
    expect(local).toEqual({ error: 'blocked address', ok: false });
    expect(await listProviderModels({ apiKey: 'k', provider: 'ollama' })).toEqual({
      error: 'apiBase required',
      ok: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a 200 that is not a list as a failure, not an empty success', async () => {
    for (const body of ['<html>login</html>', '{}', '[]', '{"data":"x"}']) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body))
      );
      expect(await listProviderModels({ apiKey: 'k', provider: 'openai' })).toEqual({
        error: 'unrecognised response',
        ok: false,
      });
    }
  });

  it('is incomplete when the provider signals more pages it gave no cursor for', async () => {
    const cases: Array<[string, unknown]> = [
      ['openai', { data: [{ id: 'gpt-x' }], has_more: true, last_id: 'gpt-x' }],
      ['anthropic', { data: [{ id: 'claude-x' }], has_more: true }],
      ['openrouter', { data: [{ id: 'm' }], next_page_token: 'abc' }],
    ];
    for (const [provider, body] of cases) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(body))
      );
      const result = await listProviderModels({
        apiBase: 'https://example.com/v1',
        apiKey: 'k',
        provider,
      });
      expect(result).toMatchObject({ complete: false, ok: true });
    }
  });
});

describe('discoverProviderModels secrecy', () => {
  it('keeps a key out of the discovery result when fetch rejects with it in the message', async () => {
    const sealed = encryptSecret('sk-TOPSECRET-1234\r\nX-Evil: 1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError(
          'Headers.append: "Bearer sk-TOPSECRET-1234" is an invalid header value.'
        );
      })
    );
    const prisma = {
      modelCatalogEntry: { findMany: vi.fn().mockResolvedValue([]) },
      providerCredential: {
        findMany: vi.fn().mockResolvedValue([
          {
            apiBase: null,
            apiKeyAuthTag: sealed.authTag,
            apiKeyCiphertext: sealed.ciphertext,
            apiKeyNonce: sealed.nonce,
            keyVersion: sealed.keyVersion,
            provider: 'openai',
            scope: 'GLOBAL',
          },
        ]),
      },
    } as unknown as PrismaClient;
    const results = await discoverProviderModels(prisma);
    expect(results[0]).toMatchObject({ error: 'request failed (TypeError)', ok: false });
    expect(JSON.stringify(results)).not.toContain('TOPSECRET');
  });
});

describe('private-network provider hosts', () => {
  const base = { apiKey: 'k', provider: 'internal-llm' };

  it('refuses a private apiBase unless its host is listed', () => {
    const refused = modelListRequest({ ...base, apiBase: 'https://10.1.2.3/v1' });
    expect(refused).toEqual({ error: expect.stringMatching(/private network/) });

    const allowed = modelListRequest({
      ...base,
      apiBase: 'https://10.1.2.3/v1',
      privateHosts: ['10.1.2.3'],
    });
    expect(allowed).toMatchObject({ url: 'https://10.1.2.3/v1/models' });
  });

  it('matches host and port exactly, case-insensitively', () => {
    expect(isPrivateHostListed('https://Internal.Example.com/v1', ['internal.example.com'])).toBe(
      true
    );
    expect(isPrivateHostListed('http://10.0.0.5:8000/v1', ['10.0.0.5'])).toBe(false);
    expect(isPrivateHostListed('http://10.0.0.5:8000/v1', ['10.0.0.5:8000'])).toBe(true);
    expect(isPrivateHostListed('not a url', ['10.0.0.5'])).toBe(false);
  });

  it.each([
    'http://127.0.0.1:8000/v1',
    'http://localhost:8000/v1',
    'http://169.254.169.254/v1',
    'http://[::1]:8000/v1',
  ])('still refuses %s when listed', (apiBase) => {
    const host = new URL(apiBase).host;
    const result = modelListRequest({ ...base, apiBase, privateHosts: [host] });
    expect(result).toEqual({ error: expect.stringMatching(/never allowed/) });
  });

  it('does not let a listed host waive other refusals', () => {
    const result = modelListRequest({
      ...base,
      apiBase: 'ftp://10.1.2.3/v1',
      privateHosts: ['10.1.2.3'],
    });
    expect(result).toEqual({ error: expect.stringMatching(/protocol/) });
  });
});

describe('built-in providers with a custom apiBase', () => {
  const proxy = 'https://proxy.example.com/openai_rest/v1/';

  it('lists openai models from the apiBase, not api.openai.com', () => {
    expect(modelListRequest({ apiBase: proxy, apiKey: 'k', provider: 'openai' })).toEqual({
      init: { headers: { Authorization: 'Bearer k' }, redirect: 'manual' },
      url: 'https://proxy.example.com/openai_rest/v1/models',
    });
  });

  it('keeps the anthropic auth headers against a custom apiBase', () => {
    expect(
      modelListRequest({
        apiBase: 'https://proxy.example.com/v1',
        apiKey: 'k',
        provider: 'anthropic',
      })
    ).toEqual({
      init: {
        headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'k' },
        redirect: 'manual',
      },
      url: 'https://proxy.example.com/v1/models',
    });
  });

  it('keeps the google key query against a custom apiBase', () => {
    expect(
      modelListRequest({
        apiBase: 'https://proxy.example.com/v1beta',
        apiKey: 'k',
        provider: 'google',
      })
    ).toEqual({
      init: { redirect: 'manual' },
      url: 'https://proxy.example.com/v1beta/models?key=k',
    });
  });

  it('passes the query through to the custom base', () => {
    const result = modelListRequest({
      apiBase: proxy,
      apiKey: 'k',
      provider: 'openai',
      query: { limit: '5' },
    });
    expect(result).toMatchObject({
      url: 'https://proxy.example.com/openai_rest/v1/models?limit=5',
    });
  });

  it('still uses the vendor endpoint when there is no apiBase, or it is empty', () => {
    for (const apiBase of [undefined, null, '']) {
      expect(modelListRequest({ apiBase, apiKey: 'k', provider: 'openai' })).toEqual({
        init: { headers: { Authorization: 'Bearer k' } },
        url: 'https://api.openai.com/v1/models',
      });
    }
  });

  it('puts a custom apiBase behind the same guard as any other provider', () => {
    const refused = modelListRequest({
      apiBase: 'https://10.1.2.3/v1',
      apiKey: 'k',
      provider: 'openai',
    });
    expect(refused).toEqual({ error: expect.stringMatching(/private network/) });
    expect(
      modelListRequest({
        apiBase: 'https://10.1.2.3/v1',
        apiKey: 'k',
        privateHosts: ['10.1.2.3'],
        provider: 'openai',
      })
    ).toMatchObject({ url: 'https://10.1.2.3/v1/models' });
    expect(
      modelListRequest({
        apiBase: 'https://u:p@proxy.example.com/v1',
        apiKey: 'k',
        provider: 'openai',
      })
    ).toEqual({ error: expect.stringMatching(/credentials in the URL/) });
  });
});

describe('modelCallFetch', () => {
  it('refuses redirects whatever the caller asked for', async () => {
    const stub = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', stub);
    const f = modelCallFetch(async () => []);
    await f('https://93.184.216.34/v1/chat/completions', { method: 'POST', redirect: 'follow' });
    expect(stub.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error' });
  });

  it('refuses a private address unless its host is listed, reading the list per call', async () => {
    const stub = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', stub);
    let listed: string[] = [];
    const f = modelCallFetch(async () => listed);
    await expect(f('http://10.0.0.5:8000/v1/models')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(stub).not.toHaveBeenCalled();
    listed = ['10.0.0.5:8000'];
    await f('http://10.0.0.5:8000/v1/models');
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('never reaches loopback or metadata, listed or not', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const f = modelCallFetch(async () => ['127.0.0.1:11434', '169.254.169.254']);
    await expect(f('http://127.0.0.1:11434/v1/chat')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(f('http://169.254.169.254/latest')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
