import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeCredential } from './credentialService.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeCredential', () => {
  it('reports a failed request by error name, never by message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError(
          'Headers.append: "Bearer sk-TOPSECRET-1234" is an invalid header value.'
        );
      })
    );
    const result = await probeCredential({ apiKey: 'sk-TOPSECRET-1234', provider: 'openai' });
    expect(result).toEqual({ error: 'request failed (TypeError)', ok: false });
  });

  it('refuses an apiBase with userinfo without echoing it', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await probeCredential({
      apiBase: 'https://bob:hunter2@openrouter.ai/api/v1',
      apiKey: 'k',
      provider: 'openrouter',
    });
    expect(result).toEqual({ error: 'blocked address', ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
