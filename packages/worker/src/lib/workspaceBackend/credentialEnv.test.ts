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
      'SSH_PRIVATE_KEY',
      'PRIVATEKEY',
      'AWS_ACCESS_KEY',
      'ACCESSKEY',
      'DEPLOY_SSH_KEY',
      'SSHKEY',
      'AUTH_BEARER',
      'BEARER',
      'SESSION_COOKIE',
      'COOKIE',
      'SESSION_ID',
      'SESSIONID',
      'GITHUB_PAT',
      'DB_PASS',
      'DB_PWD',
      'PAT',
    ]) {
      expect(isCredentialEnvName(name), name).toBe(true);
    }
  });

  it('matches PAT, PASS and PWD only as whole words', () => {
    for (const name of ['PASSIVE_MODE', 'PATH', 'COMPASS_DIR', 'SPATH', 'PATHS', 'KEYBOARD']) {
      expect(isCredentialEnvName(name), name).toBe(false);
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

  it('accepts every platform env name the workspace passes', () => {
    expect(() =>
      assertNoCredentialEnvPairs(
        [
          'NPM_CONFIG_USERCONFIG=/workspace/.auto-swe/npmrc',
          'NPM_CONFIG_REPLACE_REGISTRY_HOST=always',
          'NPM_CONFIG_AUDIT=false',
          'NPM_CONFIG_FUND=false',
          'NPM_CONFIG_UPDATE_NOTIFIER=false',
          'NPM_CONFIG_REGISTRY=http://proxy/npm/r',
          'YARN_NPM_REGISTRY_SERVER=http://proxy/npm/r',
          'COREPACK_NPM_REGISTRY=http://proxy/npm/r',
          'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
          'YARN_NPM_ALWAYS_AUTH=true',
          'AUTO_SWE_EXEC_ID=exec-1',
          'ANTHROPIC_BASE_URL=https://api.example.com',
          'CLAUDE_CODE_MAX_RETRIES=3',
          'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
          'CLAUDE_CODE_ENTRYPOINT=sdk-ts',
          'CLAUDE_CODE_MAX_OUTPUT_TOKENS=8000',
          'HOME=/home/agent',
          'SHELL=/bin/sh',
          'DISABLE_AUTOUPDATER=1',
          'DISABLE_TELEMETRY=1',
          'GIT_AUTHOR_NAME=Ada',
          'GIT_AUTHOR_EMAIL=ada@example.com',
          'CONTAINER_STEP_INPUT=/workspace/input.json',
          'PATH=/usr/bin:/bin',
          'LANG=C.UTF-8',
          'TERM=dumb',
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

  it('refuses a value that carries URL userinfo, naming the variable and call site', () => {
    const password = 'p4ss-wd-xyz';
    const value = `http://deploy:${password}@proxy.internal:3128`;
    let message = '';
    try {
      assertNoCredentialEnvPairs(['HOME=/h', `HTTPS_PROXY=${value}`], 'docker run env');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('HTTPS_PROXY');
    expect(message).toContain('docker run env');
    expect(message).toContain('value carries URL credentials; pass it as secretEnv');
    expect(message).not.toContain(password);
    expect(message).not.toContain('deploy:');
    expect(message).not.toContain('proxy.internal');
    expect(message).not.toContain(value);
  });

  it('refuses URL userinfo in any scheme, not only http', () => {
    for (const value of [
      'postgresql://app:s3cr%40t@db:5432/x',
      'https://u:p@host/path',
      'socks5://u:p@host:1080',
    ]) {
      const pair = `ANY_URL=${value}`;
      expect(() => assertNoCredentialEnvPairs([pair], 'test'), value).toThrow(
        'value carries URL credentials'
      );
    }
  });

  it('accepts values that are URLs without userinfo, or are not URLs', () => {
    for (const pair of [
      'NPM_CONFIG_REGISTRY=https://host/path',
      'NPM_CONFIG_REGISTRY=http://host:8080/x',
      'NOTE=https://host/a@b',
      'REPO=git@github.com:org/repo',
      'ORIGIN=https://host',
      'CMD=curl https://host/x?a=b',
    ]) {
      expect(() => assertNoCredentialEnvPairs([pair], 'test'), pair).not.toThrow();
    }
  });

  it('judges a long value without a scheme in linear time', () => {
    const started = Date.now();
    const long = `NOTE=${'a.'.repeat(50_000)}`;
    expect(() => assertNoCredentialEnvPairs([long], 'test')).not.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
