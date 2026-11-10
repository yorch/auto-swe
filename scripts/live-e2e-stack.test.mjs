import { describe, expect, it } from 'vitest';
import {
  envLines,
  fixtureFiles,
  missingEnv,
  parseRepoSlug,
  REQUIRED_ENV,
} from './live-e2e-stack.mjs';

describe('live-e2e-stack', () => {
  it('names every required variable that is absent', () => {
    expect(missingEnv({})).toEqual(Object.keys(REQUIRED_ENV));
    const all = Object.fromEntries(Object.keys(REQUIRED_ENV).map((n) => [n, 'x']));
    expect(missingEnv(all)).toEqual([]);
    expect(missingEnv({ ...all, GITHUB_TOKEN: '' })).toEqual(['GITHUB_TOKEN']);
  });

  it('parses owner/name and refuses anything else', () => {
    expect(parseRepoSlug('acme/live-fixture')).toEqual({ owner: 'acme', repo: 'live-fixture' });
    expect(() => parseRepoSlug('acme')).toThrow(/owner\/name/);
    expect(() => parseRepoSlug('a/b/c')).toThrow(/owner\/name/);
    expect(() => parseRepoSlug(undefined)).toThrow(/owner\/name/);
  });

  it('masks a token before it is exported', () => {
    const lines = envLines({ LIVE_E2E_REPO_ID: 'r', LIVE_E2E_TOKEN: 'ats_secret' });
    expect(lines).toEqual([
      { env: 'LIVE_E2E_REPO_ID=r' },
      { mask: 'ats_secret' },
      { env: 'LIVE_E2E_TOKEN=ats_secret' },
    ]);
  });

  it('ships a fixture whose default branch is red on purpose', () => {
    const files = fixtureFiles();
    const paths = files.map((f) => f.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('src/sum.js');
    expect(paths).toContain('test/sum.test.js');
    expect(paths).toContain('.github/workflows/ci.yml');
    const sum = files.find((f) => f.path === 'src/sum.js')?.content.toString() ?? '';
    expect(sum).toMatch(/a - b/);
  });
});
