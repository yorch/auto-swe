import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@auto-swe/shared/lib/guardedDispatcher', () => ({ createGuardedFetch: () => h.fetch }));
vi.mock('@auto-swe/shared/lib/githubInstallation', () => ({ createGitHubAppJwt: () => 'app-jwt' }));

import { verifyGithubInstaller } from './githubConnect.js';

const config = {
  apiUrl: 'https://api.github.com',
  appClientId: 'client',
  appClientSecret: 'secret',
  appId: '1',
  appPrivateKey: 'pem',
  baseUrl: 'https://github.com',
} as never;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  vi.resetAllMocks();
});
describe('GitHub installer verification', () => {
  it('paginates user installations, then reads the account with an App JWT', async () => {
    h.fetch
      .mockResolvedValueOnce(response({ access_token: 'user-token' }))
      .mockResolvedValueOnce(
        response({ installations: Array.from({ length: 100 }, (_, i) => ({ id: i + 1000 })) })
      )
      .mockResolvedValueOnce(response({ installations: [{ id: 77 }] }))
      .mockResolvedValueOnce(response({ account: { login: 'acme' }, id: 77 }));
    expect(await verifyGithubInstaller(config, 'code', '77')).toBe('acme');
    expect(h.fetch.mock.calls[2][0]).toContain('page=2');
    expect(h.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer user-token');
    expect(h.fetch.mock.calls[3][1].headers.Authorization).toBe('Bearer app-jwt');
    expect(h.fetch.mock.calls.every(([, options]) => options.redirect === 'error')).toBe(true);
  });
  it('does not trust an installation absent from the user listing', async () => {
    h.fetch
      .mockResolvedValueOnce(response({ access_token: 'user-token' }))
      .mockResolvedValueOnce(response({ installations: [] }));
    expect(await verifyGithubInstaller(config, 'code', '77')).toBeNull();
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([response({ error: 'bad-code' }), response({}, 401)])(
    'refuses failed code exchange',
    async (r) => {
      h.fetch.mockResolvedValueOnce(r);
      await expect(verifyGithubInstaller(config, 'code', '77')).rejects.toThrow(
        'GitHub authorization could not be completed'
      );
    }
  );
  it('refuses an unavailable user listing', async () => {
    h.fetch
      .mockResolvedValueOnce(response({ access_token: 'user-token' }))
      .mockResolvedValueOnce(response({}, 503));
    await expect(verifyGithubInstaller(config, 'code', '77')).rejects.toThrow(
      'GitHub installations could not be verified'
    );
  });
  it('refuses suspended installations even if visible to the user', async () => {
    h.fetch
      .mockResolvedValueOnce(response({ access_token: 'user-token' }))
      .mockResolvedValueOnce(response({ installations: [{ id: 77 }] }))
      .mockResolvedValueOnce(
        response({ account: { login: 'acme' }, id: 77, suspended_at: '2026-01-01' })
      );
    expect(await verifyGithubInstaller(config, 'code', '77')).toBeNull();
  });
});
