import { describe, expect, it } from 'vitest';
import {
  parseRepoGatesYaml,
  parseRepoPreviewYaml,
  REPO_CONFIG_FILE_MAX_BYTES,
} from './repoConfigFiles.js';

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
