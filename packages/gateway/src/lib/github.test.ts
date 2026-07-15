import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const githubConfigState = vi.hoisted(() => ({
  apiUrl: 'https://api.github.com',
  appId: null as string | null,
  appInstallationId: null as string | null,
  appPrivateKey: null as string | null,
  authMode: 'auto' as 'auto' | 'pat' | 'app',
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: vi.fn(async () => githubConfigState),
}));

vi.mock('./githubAuth.js', () => ({
  GitHubTokenMissingError: class GitHubTokenMissingError extends Error {},
  resolveGitHubToken: vi.fn(async () => 'gh-pat-token'),
}));

import { listGitHubRepos, verifyGitHubSignature } from './github.js';

function rawRepo(name: string) {
  return {
    default_branch: 'main',
    description: null,
    html_url: `https://github.com/acme/${name}`,
    language: null,
    name,
    owner: { login: 'acme' },
    url: `https://api.github.com/repos/acme/${name}`,
  };
}

const SECRET = 'top-secret-webhook-key';

function sign(payload: string | Buffer, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
}

describe('verifyGitHubSignature', () => {
  it('accepts a valid signature for a string payload', () => {
    const payload = JSON.stringify({ action: 'closed', number: 42 });
    expect(verifyGitHubSignature(payload, sign(payload, SECRET), SECRET)).toBe(true);
  });

  it('accepts a valid signature for a Buffer payload', () => {
    const payload = Buffer.from(JSON.stringify({ action: 'completed' }), 'utf8');
    expect(verifyGitHubSignature(payload, sign(payload, SECRET), SECRET)).toBe(true);
  });

  it('string and Buffer forms of the same payload produce the same signature', () => {
    const text = '{"a":1}';
    const sig = sign(text, SECRET);
    expect(verifyGitHubSignature(text, sig, SECRET)).toBe(true);
    expect(verifyGitHubSignature(Buffer.from(text, 'utf8'), sig, SECRET)).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const payload = '{"hello":"world"}';
    const wrong = sign(payload, 'some-other-secret');
    expect(verifyGitHubSignature(payload, wrong, SECRET)).toBe(false);
  });

  it('rejects when the payload was tampered with after signing', () => {
    const sig = sign('{"merged":false}', SECRET);
    expect(verifyGitHubSignature('{"merged":true}', sig, SECRET)).toBe(false);
  });

  it('returns false (does not throw) for a malformed short signature', () => {
    // timingSafeEqual throws on length mismatch — the helper must guard it.
    expect(() => verifyGitHubSignature('{}', 'sha256=abc', SECRET)).not.toThrow();
    expect(verifyGitHubSignature('{}', 'sha256=abc', SECRET)).toBe(false);
  });

  it('returns false for an empty signature', () => {
    expect(verifyGitHubSignature('{}', '', SECRET)).toBe(false);
  });

  it('returns false for a signature missing the sha256= prefix', () => {
    const payload = '{"x":1}';
    const bare = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    expect(verifyGitHubSignature(payload, bare, SECRET)).toBe(false);
  });

  it('returns false for an over-long signature without throwing', () => {
    const payload = '{"x":1}';
    const tooLong = `${sign(payload, SECRET)}deadbeef`;
    expect(() => verifyGitHubSignature(payload, tooLong, SECRET)).not.toThrow();
    expect(verifyGitHubSignature(payload, tooLong, SECRET)).toBe(false);
  });
});

describe('listGitHubRepos', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    githubConfigState.authMode = 'auto';
    githubConfigState.appId = null;
    githubConfigState.appInstallationId = null;
    githubConfigState.appPrivateKey = null;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stops after the first page when fewer than per_page repos come back (PAT auth)', async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => [rawRepo('alpha'), rawRepo('beta')],
      ok: true,
    });
    const repos = await listGitHubRepos();
    expect(repos.map((r) => r.name)).toEqual(['alpha', 'beta']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/user/repos?type=all&per_page=100&sort=updated&page=1'),
      expect.anything()
    );
  });

  it('paginates across multiple pages until a short page is returned (PAT auth)', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => rawRepo(`repo-${i}`));
    const shortPage = [rawRepo('last-one')];
    fetchMock
      .mockResolvedValueOnce({ json: async () => fullPage, ok: true })
      .mockResolvedValueOnce({ json: async () => shortPage, ok: true });
    const repos = await listGitHubRepos();
    expect(repos).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('page=2'),
      expect.anything()
    );
  });

  it('caps at MAX_PAGES (5) even if every page comes back full', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => rawRepo(`repo-${i}`));
    fetchMock.mockResolvedValue({ json: async () => fullPage, ok: true });
    const repos = await listGitHubRepos();
    expect(repos).toHaveLength(500);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('uses the installation-repositories endpoint and total_count-wrapped pages for GitHub App auth', async () => {
    githubConfigState.authMode = 'app';
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ repositories: [rawRepo('gamma')], total_count: 1 }),
      ok: true,
    });
    const repos = await listGitHubRepos();
    expect(repos.map((r) => r.name)).toEqual(['gamma']);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/installation/repositories?per_page=100&page=1'),
      expect.anything()
    );
  });

  it('throws with the response status when a page request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502 });
    await expect(listGitHubRepos()).rejects.toThrow(/502/);
  });
});
