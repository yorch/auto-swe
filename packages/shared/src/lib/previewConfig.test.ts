import { describe, expect, it } from 'vitest';
import {
  looksRandom,
  PreviewConfigInputSchema,
  PreviewConfigSchema,
  secretLookingEnvKeys,
} from './previewConfig.js';

const validConfig = {
  readyUrl: 'http://localhost:4173/health',
  start: 'npm run dev -- --host 0.0.0.0',
};

describe('PreviewConfigSchema', () => {
  it('defaults the base URL to the readiness origin and the timeout', () => {
    expect(PreviewConfigSchema.parse(validConfig)).toMatchObject({
      baseUrl: 'http://localhost:4173',
      readyTimeoutMs: 180_000,
    });
  });

  it('accepts an explicitly supplied default HTTP port', () => {
    expect(
      PreviewConfigSchema.parse({ readyUrl: 'http://localhost:80/health', start: 'npm start' })
    ).toMatchObject({ baseUrl: 'http://localhost' });
  });

  it('accepts a bounded recipe with smoke, e2e, environment and services', () => {
    expect(
      PreviewConfigSchema.parse({
        ...validConfig,
        allowedHosts: ['localhost', 'example.test'],
        baseUrl: 'http://127.0.0.1:4173',
        e2e: { command: 'npx playwright test' },
        env: { NODE_ENV: 'test' },
        services: [
          {
            image: 'postgres:18',
            name: 'db',
            port: 5432,
            runAsGroup: 999,
            runAsUser: 999,
          },
        ],
        smoke: [{ name: 'Home', path: '/', waitFor: 'main' }],
      })
    ).toMatchObject({
      e2e: { resultsDir: 'test-results' },
      readyTimeoutMs: 180_000,
    });
  });

  it.each([
    { readyUrl: 'https://example.com', start: 'npm start' },
    { readyUrl: 'http://localhost/health', start: 'npm start' },
    { readyUrl: 'ftp://localhost:3000', start: 'npm start' },
    { extra: true, readyUrl: 'http://localhost:3000', start: 'npm start' },
    { ...validConfig, env: { 'lower-case': 'no' } },
    {
      ...validConfig,
      env: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`K_${i}`, 'x'])),
    },
    { ...validConfig, e2e: { command: 'test', resultsDir: '../outside' } },
    { ...validConfig, smoke: [{ path: 'relative' }] },
    {
      ...validConfig,
      services: Array.from({ length: 5 }, (_, i) => ({ image: 'x', name: `svc-${i}` })),
    },
  ])('rejects invalid recipes: %o', (config) => {
    expect(PreviewConfigSchema.safeParse(config).success).toBe(false);
  });

  it('enforces command, URL, timeout, and collection bounds', () => {
    expect(PreviewConfigSchema.safeParse({ ...validConfig, start: '' }).success).toBe(false);
    expect(
      PreviewConfigSchema.safeParse({
        ...validConfig,
        readyUrl: `http://localhost:4173/${'x'.repeat(2000)}`,
      }).success
    ).toBe(false);
    expect(PreviewConfigSchema.safeParse({ ...validConfig, readyTimeoutMs: 999 }).success).toBe(
      false
    );
    expect(
      PreviewConfigSchema.safeParse({
        ...validConfig,
        smoke: Array.from({ length: 31 }, () => ({ path: '/' })),
      }).success
    ).toBe(false);
  });

  it('validates preview service user and group identities', () => {
    expect(
      PreviewConfigSchema.parse({
        ...validConfig,
        services: [{ image: 'postgres:18', name: 'db', runAsUser: 999 }],
      }).services?.[0]
    ).toMatchObject({ runAsUser: 999 });

    for (const value of [0, 1.5, 2_147_483_648]) {
      expect(
        PreviewConfigSchema.safeParse({
          ...validConfig,
          services: [{ image: 'postgres:18', name: 'db', runAsUser: value }],
        }).success
      ).toBe(false);
      expect(
        PreviewConfigSchema.safeParse({
          ...validConfig,
          services: [{ image: 'postgres:18', name: 'db', runAsGroup: value, runAsUser: 999 }],
        }).success
      ).toBe(false);
    }

    const result = PreviewConfigSchema.safeParse({
      ...validConfig,
      services: [{ image: 'postgres:18', name: 'db', runAsGroup: 999 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          message: 'runAsGroup requires runAsUser',
          path: ['services', 0, 'runAsGroup'],
        })
      );
    }
  });
});

describe('secretLookingEnvKeys', () => {
  it('flags secret-looking names and values, and leaves ordinary ones', () => {
    expect(
      secretLookingEnvKeys({
        API_KEY: 'x',
        AWS_ID: 'AKIAABCDEFGHIJKLMNOP',
        DATABASE_URL: 'postgres://app:pw-123456@db:5432/app',
        EMPTY_TOKEN: '',
        HEADER: 'Bearer abcdefgh12345678',
        NODE_ENV: 'production',
        PORT: '3000',
        PUBLIC_URL: 'https://example.com/app',
        SESSION_SECRET: 'whatever',
      })
    ).toEqual(['API_KEY', 'AWS_ID', 'DATABASE_URL', 'HEADER', 'SESSION_SECRET']);
  });

  it('accepts a missing env', () => {
    expect(secretLookingEnvKeys(undefined)).toEqual([]);
  });

  it('flags a random-looking value under an ordinary name, unless publicEnv lists it', () => {
    const env = {
      BUILD_SHA: '2f5bf2379ed09785f417904a634a432c59dfa9fd',
      DB_URL: 'k9Xq2LmZ7pR4tW8vB3nY',
      JWT: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      REGION: 'eu-west-1',
    };
    expect(secretLookingEnvKeys(env)).toEqual(['BUILD_SHA', 'DB_URL', 'JWT']);
    expect(secretLookingEnvKeys(env, ['BUILD_SHA', 'JWT'])).toEqual(['DB_URL', 'JWT']);
  });

  it('does not let publicEnv excuse a secret-looking name or token shape', () => {
    expect(
      secretLookingEnvKeys({ API_TOKEN: 'abc', GH: 'ghp_abcdefghijklmnopqrstuvwxyz0123' }, [
        'API_TOKEN',
        'GH',
      ])
    ).toEqual(['API_TOKEN', 'GH']);
  });
});

describe('looksRandom', () => {
  it.each([
    'my_feature_flag_enabled_2024',
    'NODE_OPTIONS_max_old_space_4096',
    'production-eu-west-1-cluster',
    'node_modules/.bin/next-dev',
    'MyApplicationName2024Prod',
    'http://localhost:3000/api/v1/healthcheck',
    '--max-old-space-size=4096',
    '1700000000000',
    'ImageTag20241106build17',
    'v1.2.3-beta.4+build.5678',
  ])('leaves %s', (value) => {
    expect(looksRandom(value)).toBe(false);
  });

  it.each([
    'CVVGo9EjlpADP2zm25ygIw94',
    'oyDeq2Htnp7a4n1RYHosa+H3WtwTBORB',
    'd2269ca31e0165a8f1ec2431b8ef334b',
    'MRP9ku22bSNd3x2D2j5i',
    'r60UvA2r92Mw_BtUkIloaTEFbON0apLT',
    '550e8400-e29b-41d4-a716-446655440000',
    '3716fe76373433fade1a66e46364e3d4129446ab',
  ])('flags %s', (value) => {
    expect(looksRandom(value)).toBe(true);
  });
});

describe('publicEnv', () => {
  it('accepts env names without repeats', () => {
    const base = { readyUrl: 'http://localhost:3000', start: 'npm start' };
    expect(PreviewConfigInputSchema.safeParse({ ...base, publicEnv: ['GIT_SHA'] }).success).toBe(
      true
    );
    expect(
      PreviewConfigInputSchema.safeParse({ ...base, publicEnv: ['GIT_SHA', 'GIT_SHA'] }).success
    ).toBe(false);
    expect(PreviewConfigInputSchema.safeParse({ ...base, publicEnv: ['git-sha'] }).success).toBe(
      false
    );
  });
});
