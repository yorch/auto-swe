import { describe, expect, it } from 'vitest';
import {
  parseRepoGatesYaml,
  parseRepoPreviewYaml,
  REPO_CONFIG_FILE_MAX_BYTES,
  repoGatesToYaml,
  repoPreviewToYaml,
} from './repoConfigFiles.js';

describe('repository configuration serializers', () => {
  it('renders empty gates and preserves nullable and blank values', () => {
    expect(parseRepoGatesYaml(repoGatesToYaml({}))).toEqual({ ok: true, value: {} });
    const commands = { runBuild: '', runLint: null, runTests: 'make test' };
    expect(parseRepoGatesYaml(repoGatesToYaml(commands))).toEqual({ ok: true, value: commands });
    expect(repoGatesToYaml(commands)).toBe(
      repoGatesToYaml({ runBuild: '', runLint: null, runTests: 'make test' })
    );
  });

  it('normalizes preview defaults and sorts nested map entries', () => {
    const config = {
      env: { A: 'first', Z: 'last' },
      readyUrl: 'http://localhost:3000/',
      start: 'npm start',
    };
    expect(parseRepoPreviewYaml(repoPreviewToYaml(config))).toEqual({
      ok: true,
      value: { ...config, baseUrl: 'http://localhost:3000', readyTimeoutMs: 180000 },
    });
    expect(repoPreviewToYaml(config)).toBe(
      repoPreviewToYaml({ ...config, env: { A: 'first', Z: 'last' } })
    );
  });

  it('rejects invalid configuration before serialization', () => {
    expect(() => repoGatesToYaml({ runTests: 42 } as never)).toThrow();
    expect(() => repoPreviewToYaml({} as never)).toThrow();
  });
});

describe('parseRepoGatesYaml', () => {
  it('accepts the connection command schema, including nullable and blank entries', () => {
    expect(parseRepoGatesYaml('runTests: make test\nrunLint: null\nrunBuild: ""')).toEqual({
      ok: true,
      value: { runBuild: '', runLint: null, runTests: 'make test' },
    });
  });
  it('accepts an empty map', () => {
    expect(parseRepoGatesYaml('')).toEqual({ ok: true, value: {} });
  });
  it.each([
    ['unknown key', 'unknown: echo nope'],
    ['number', 'runTests: 12'],
    ['array', 'runTests: [one, two]'],
    ['non-map', '- runTests'],
    ['syntax', '['],
    ['long command', `runTests: ${'a'.repeat(4001)}`],
    ['large file', 'a'.repeat(REPO_CONFIG_FILE_MAX_BYTES + 1)],
  ])('rejects %s', (_name, text) => {
    expect(parseRepoGatesYaml(text).ok).toBe(false);
  });
});

describe('parseRepoPreviewYaml', () => {
  it('uses the preview schema and its defaults', () => {
    expect(
      parseRepoPreviewYaml('start: npm start\nreadyUrl: http://localhost:3000/')
    ).toMatchObject({
      ok: true,
      value: { readyUrl: 'http://localhost:3000/', start: 'npm start' },
    });
  });
  it.each([
    ['empty file', ''],
    ['syntax', '['],
    ['remote URL', 'start: npm start\nreadyUrl: https://example.com'],
    ['large file', 'a'.repeat(REPO_CONFIG_FILE_MAX_BYTES + 1)],
  ])('rejects %s', (_name, text) => {
    expect(parseRepoPreviewYaml(text).ok).toBe(false);
  });
});
