import { describe, expect, it } from 'vitest';
import { assertNoCredentialEnvPairs, isCredentialEnvName } from './credentialEnv.js';

describe('isCredentialEnvName', () => {
  it('flags names carrying a credential word, whatever the case', () => {
    for (const name of [
      'GITHUB_TOKEN',
      'AUTHORIZATION',
      'API_KEY',
      'apiKey',
      'ANTHROPIC_APIKEY',
      'DB_PASSWORD',
      'DB_PASSWD',
      'CLIENT_SECRET',
      'AWS_CREDENTIALS',
      'Npmrc',
      'YARNRC_CONTENT',
      'YARN_NPM_AUTH_TOKEN',
    ]) {
      expect(isCredentialEnvName(name), name).toBe(true);
    }
  });

  it('allows names that only look like a credential word', () => {
    for (const name of [
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      'HOME',
      'AUTO_SWE_EXEC_ID',
      'ANTHROPIC_BASE_URL',
    ]) {
      expect(isCredentialEnvName(name), name).toBe(false);
    }
  });

  it('allows the Yarn boolean YARN_NPM_ALWAYS_AUTH by exact name only', () => {
    expect(isCredentialEnvName('YARN_NPM_ALWAYS_AUTH')).toBe(false);
    expect(isCredentialEnvName('YARN_NPM_AUTH_TOKEN')).toBe(true);
    expect(isCredentialEnvName('COREPACK_NPM_TOKEN')).toBe(true);
    expect(isCredentialEnvName('yarn_npm_always_auth')).toBe(true);
    expect(isCredentialEnvName('YARN_NPM_ALWAYS_AUTH_X')).toBe(true);
    expect(isCredentialEnvName('X_YARN_NPM_ALWAYS_AUTH')).toBe(true);
  });

  it('accepts the plain registry env the workspace carries', () => {
    expect(() =>
      assertNoCredentialEnvPairs(
        [
          'NPM_CONFIG_USERCONFIG=/workspace/.auto-swe/npmrc',
          'NPM_CONFIG_REPLACE_REGISTRY_HOST=always',
          'NPM_CONFIG_REGISTRY=http://proxy/npm/r',
          'YARN_NPM_REGISTRY_SERVER=http://proxy/npm/r',
          'COREPACK_NPM_REGISTRY=http://proxy/npm/r',
          'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
          'YARN_NPM_ALWAYS_AUTH=true',
        ],
        'test'
      )
    ).not.toThrow();
  });

  it('still flags an author-like name that is really an authorization', () => {
    expect(isCredentialEnvName('AUTHORIZATION_HEADER')).toBe(true);
  });
});

describe('assertNoCredentialEnvPairs', () => {
  it('accepts undefined, an empty list and non-credential pairs', () => {
    expect(() => assertNoCredentialEnvPairs(undefined, 'test')).not.toThrow();
    expect(() => assertNoCredentialEnvPairs([], 'test')).not.toThrow();
    expect(() =>
      assertNoCredentialEnvPairs(['HOME=/home/x', 'GIT_AUTHOR_NAME=Ada'], 'test')
    ).not.toThrow();
  });

  it('judges the name only, never the value', () => {
    expect(() => assertNoCredentialEnvPairs(['NOTE=the token is rotated'], 'test')).not.toThrow();
  });

  it('names the variable and the call site, and never the value', () => {
    const value = 'hunter2-value-xyz';
    let message = '';
    try {
      assertNoCredentialEnvPairs(['HOME=/h', `DEPLOY_PASSWORD=${value}`], 'docker run env');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('DEPLOY_PASSWORD');
    expect(message).toContain('docker run env');
    expect(message).toContain('secretEnv');
    expect(message).not.toContain(value);
    expect(message).not.toContain('DEPLOY_PASSWORD=');
  });

  it('checks a pair with no equals sign by its whole text', () => {
    expect(() => assertNoCredentialEnvPairs(['SOME_TOKEN'], 'test')).toThrow(/SOME_TOKEN/);
  });
});
