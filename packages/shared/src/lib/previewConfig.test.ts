import { describe, expect, it } from 'vitest';
import { PreviewConfigSchema } from './previewConfig.js';

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
        services: [{ image: 'postgres:18', name: 'db', port: 5432 }],
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
});
