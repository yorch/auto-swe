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
      'GITHUB_PAT',
      'DB_PASS',
      'DB_PWD',
      'PAT',
      'PASS',
      'PWD',
      'GPG_PASSPHRASE',
      'DEPLOY_KEY',
      'DEPLOYKEY',
      'SIGNING_KEY',
      'SIGNINGKEY',
    ]) {
      expect(isCredentialEnvName(name), name).toBe(true);
    }
  });

  it('matches PAT, PASS and PWD only as whole words', () => {
    for (const name of [
      'PASSIVE_MODE',
      'PATH',
      'COMPASS_DIR',
      'SPATH',
      'PATHS',
      'KEYBOARD',
      'OLDPWD',
      'BYPASS',
      'PATCH',
    ]) {
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

  it('accepts the JSON a container step carries as its input', () => {
    for (const value of [
      '{"url":"http://host:8080","email":"a@b.com"}',
      '{"api":"http://svc:9000","tags":["@a"]}',
      '{"s":"http://localhost:3000?x=1@2"}',
    ]) {
      const pair = `CONTAINER_STEP_INPUT=${value}`;
      expect(() => assertNoCredentialEnvPairs([pair], 'test'), value).not.toThrow();
    }
  });

  it('accepts a URL whose query or fragment carries an at sign', () => {
    for (const pair of [
      'X=http://host:8080?a@b',
      'X=http://host:8080#a@b',
      'X=http://[::1]:8080/',
    ]) {
      expect(() => assertNoCredentialEnvPairs([pair], 'test'), pair).not.toThrow();
    }
  });

  it('refuses unencoded passwords that curl and WHATWG URL parsing accept', () => {
    for (const value of [
      'http://user:Pa^ss@proxy:3128',
      'http://user:p{w}d@proxy:3128',
      'http://user:p|w@proxy',
      'http://user:pä@proxy',
      'http://user:p`w@proxy',
      'http://user:p<w>@proxy',
      'http://u:p:w@h',
      'http://user:pa:ss@proxy:3128',
      'http://u:::@h',
    ]) {
      const pair = `X=${value}`;
      expect(() => assertNoCredentialEnvPairs([pair], 'test'), pair).toThrow(
        'value carries URL credentials'
      );
    }
  });

  it('refuses userinfo with an empty user or password, or a percent-encoded one', () => {
    for (const pair of [
      'X=postgres://u:p@h/db',
      'X=http://u:@h',
      'X=http://:p@h',
      'X=https://u:p%40q@h',
    ]) {
      expect(() => assertNoCredentialEnvPairs([pair], 'test'), pair).toThrow(
        'value carries URL credentials'
      );
    }
  });

  it('judges adversarial values in linear time', () => {
    const size = 200_000;
    for (const body of [
      'a://'.repeat(size / 4),
      'a:'.repeat(size / 2),
      '@'.repeat(size),
      '"a://b:c'.repeat(size / 8),
      'a'.repeat(size),
    ]) {
      const started = Date.now();
      expect(() => assertNoCredentialEnvPairs([`X=${body}`], 'test')).not.toThrow();
      expect(Date.now() - started).toBeLessThan(500);
    }
  });

  it('judges a long value without a scheme in linear time', () => {
    const started = Date.now();
    const long = `NOTE=${'a.'.repeat(50_000)}`;
    expect(() => assertNoCredentialEnvPairs([long], 'test')).not.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

/** Token-like text is built from parts so no secret scanner sees a literal. */
const rep = (ch: string, n: number): string => ch.repeat(n);
const join = (...parts: string[]): string => parts.join('');

const GH_TOKEN = join('gh', 'p', '_', rep('a1B2', 9));
const GH_PAT = join('github', '_pat_', rep('Ab1_', 8));
const ANTHROPIC_KEY = join('sk', '-ant-', 'api03-', rep('x9', 20));
const PROXY_TOKEN = join('sk', '-ant-', 'proxy-', rep('a0', 16));
const SLACK_TOKEN = join('xo', 'xb-', '1234567890-', 'abcdefghij');
const AWS_KEY = join('AK', 'IA', 'IOSFODNN7EXAMPLE');
const JWT = join('ey', 'JhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.', 'abcdefghij_-KLMNOP');
const PEM_RSA = join('-----BEGIN ', 'RSA PRIVATE', ' KEY-----');
const PEM_OPENSSH = join('-----BEGIN ', 'OPENSSH PRIVATE', ' KEY-----');

describe('assertNoCredentialEnvPairs value shapes', () => {
  const mustThrow: readonly (readonly [string, string])[] = [
    ['GitHub token', GH_TOKEN],
    ['GitHub token', GH_PAT],
    ['API key', ANTHROPIC_KEY],
    ['API key', PROXY_TOKEN],
    ['Slack token', SLACK_TOKEN],
    ['AWS access key', AWS_KEY],
    ['JWT', JWT],
    ['private key', PEM_RSA],
    ['private key', PEM_OPENSSH],
    ['HTTP authorization', 'Authorization: Bearer abcdef0123456789abcdef'],
    ['HTTP authorization', 'Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng=='],
    ['git auth header', Buffer.from('x-access-token:ghs_x').toString('base64')],
  ];

  it('refuses a well-known credential shape, naming its kind only', () => {
    for (const [kind, value] of mustThrow) {
      expect(() => assertNoCredentialEnvPairs([`X=${value}`], 'docker run env'), kind).toThrow(
        `value looks like a credential (${kind}); pass it as secretEnv`
      );
    }
  });

  it('refuses username-only userinfo on http, https and ftp', () => {
    for (const value of [
      `https://${GH_TOKEN}@github.com/org/repo`,
      'https://tok@host/x',
      'ftp://u@h',
      'HTTP://tok@host',
    ]) {
      expect(() => assertNoCredentialEnvPairs([`X=${value}`], 'test'), value).toThrow(
        'value carries URL credentials'
      );
    }
  });

  it('accepts values that only resemble a credential', () => {
    const bytes = Array.from({ length: 40 }, (_, i) => (i * 37 + 11) % 256);
    const accepted = [
      `http://host.docker.internal:8787/npm/${rep('ab12', 8)}`,
      'http://[::1]:8787/npm/abc',
      'https://openrouter.ai/api',
      'https://api.anthropic.com',
      '/home/node',
      'https://host/a@b',
      'git+ssh://git@github.com:org/repo.git',
      'ssh://git@github.com/org/repo',
      'git@github.com:org/repo',
      '{"url":"http://host:8080","email":"a@b.com"}',
      rep('0123456789abcdef', 3).slice(0, 40),
      '123e4567-e89b-12d3-a456-426614174000',
      rep('0123456789abcdef', 4),
      Buffer.from(bytes).toString('base64'),
      'Basic setup',
      'Bearer token auth',
      'sk-learn',
      'task-queue-name',
      'disk-usage-report-2026',
      'eyJ',
      '-----BEGIN PUBLIC KEY-----',
    ];
    for (const value of accepted) {
      expect(() => assertNoCredentialEnvPairs([`X=${value}`], 'test'), value).not.toThrow();
    }
  });

  it('never echoes any part of a refused value', () => {
    for (const [, value] of mustThrow) {
      let message = '';
      try {
        assertNoCredentialEnvPairs([`LOG_LINE=${value}`], 'docker run env');
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('LOG_LINE');
      expect(message).toContain('docker run env');
      expect(message).not.toContain(value.slice(0, 8));
      expect(message).not.toContain(value.slice(-8));
    }
  });

  it('judges adversarial values in linear time', () => {
    const size = 200_000;
    for (const body of [
      rep('gh', size / 2),
      rep('sk-', size / 3),
      rep('eyJ.', size / 4),
      rep('eyJaaaaaaaaaa.', size / 14),
      rep('Bearer ', size / 7),
      rep('Bearer', size / 6),
      rep('https://', size / 8),
      rep('-----BEGIN ', size / 11),
      rep('xox', size / 3),
      rep('AKIA', size / 4),
      rep('a', size),
      rep('A', size),
      rep('-', size),
      rep('_', size),
    ]) {
      const started = Date.now();
      try {
        // a run of `sk-` is a legitimate match; only the time taken is judged here
        assertNoCredentialEnvPairs([`X=${body}`], 'test');
      } catch {
        // refused or accepted, either is fine
      }
      expect(Date.now() - started).toBeLessThan(500);
    }
  });
});
