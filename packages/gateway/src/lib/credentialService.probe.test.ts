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

  it('probes a private apiBase only when the credential opts in', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const args = { apiBase: 'http://10.0.0.5:8000/v1', apiKey: 'k', provider: 'vllm' };
    expect(await probeCredential(args)).toEqual({ error: 'blocked address', ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await probeCredential({ ...args, allowPrivateNetwork: true })).toEqual({
      ok: true,
      status: 200,
    });
  });

  it('still refuses a metadata address with the opt-in', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await probeCredential({
      allowPrivateNetwork: true,
      apiBase: 'http://169.254.169.254/v1',
      apiKey: 'k',
      provider: 'vllm',
    });
    expect(result).toEqual({ error: 'blocked address', ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
