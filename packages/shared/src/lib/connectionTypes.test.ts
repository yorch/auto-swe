import { describe, expect, it } from 'vitest';
import {
  CONNECTION_TYPES,
  ConnectionTypeSchema,
  GENERIC_STEP_CONNECTION_TYPES,
  genericStepRefusal,
  getConnectionTypeMetadata,
  getWorkspaceTargetTypes,
  HttpApiConnectionConfigSchema,
  isConnectionType,
  isWorkspaceTargetType,
  listConnectionTypes,
  parseHttpApiConnectionConfig,
} from './connectionTypes.js';

describe('connectionTypes', () => {
  it('exports the expected connection types', () => {
    expect(CONNECTION_TYPES).toEqual([
      'git_repo',
      'issue_tracker',
      'notion',
      'confluence',
      'zendesk',
      'hubspot',
      'slack_workspace',
      'http_api',
      'mcp',
    ]);
  });

  it('validates known types', () => {
    for (const type of CONNECTION_TYPES) {
      expect(ConnectionTypeSchema.safeParse(type).success).toBe(true);
      expect(isConnectionType(type)).toBe(true);
    }
  });

  it('rejects unknown types', () => {
    expect(ConnectionTypeSchema.safeParse('unknown').success).toBe(false);
    expect(isConnectionType('unknown')).toBe(false);
    expect(isConnectionType(123)).toBe(false);
  });

  it('returns metadata for every type', () => {
    const types = listConnectionTypes();
    expect(types).toHaveLength(CONNECTION_TYPES.length);
    for (const meta of types) {
      expect(meta.key).toBeTruthy();
      expect(meta.label).toBeTruthy();
      expect(meta.description).toBeTruthy();
      expect(getConnectionTypeMetadata(meta.key)).toBe(meta);
    }
  });

  it('classifies workspace targets', () => {
    const targets = getWorkspaceTargetTypes();
    expect(targets).toContain('git_repo');
    expect(targets).toContain('issue_tracker');
    expect(targets).toContain('notion');
    expect(targets).toContain('confluence');
    expect(targets).toContain('zendesk');
    expect(targets).toContain('hubspot');
    expect(targets).not.toContain('slack_workspace');
    expect(targets).not.toContain('http_api');
    expect(targets).not.toContain('mcp');

    expect(isWorkspaceTargetType('git_repo')).toBe(true);
    expect(isWorkspaceTargetType('mcp')).toBe(false);
  });
});

describe('generic step support', () => {
  it('refuses git_repo on every generic step', () => {
    for (const step of ['readSource', 'writeOutcome', 'runTool'] as const) {
      expect(genericStepRefusal(step, 'git_repo')).toContain(`${step} has no implementation`);
      expect(genericStepRefusal(step, 'git_repo')).toContain('engineering activities');
      expect(genericStepRefusal(step, 'not_a_type')).toContain(`${step} has no implementation`);
    }
  });

  it('accepts what has an implementation', () => {
    expect(genericStepRefusal('readSource', 'notion')).toBeNull();
    expect(genericStepRefusal('writeOutcome', 'slack_workspace')).toBeNull();
    expect(genericStepRefusal('runTool', 'zendesk')).toBeNull();
    for (const step of ['readSource', 'writeOutcome', 'runTool'] as const) {
      for (const type of ['http_api', 'hubspot', 'mcp']) {
        expect(genericStepRefusal(step, type)).toBeNull();
      }
    }
    expect(genericStepRefusal('runTool', 'notion')).toBeNull();
    // Slack has no read.
    expect(genericStepRefusal('readSource', 'slack_workspace')).not.toBeNull();
  });

  it('lists only known connection types, and never git_repo', () => {
    for (const types of Object.values(GENERIC_STEP_CONNECTION_TYPES)) {
      for (const type of types) {
        expect(CONNECTION_TYPES).toContain(type);
      }
      expect(types).not.toContain('git_repo');
    }
  });
});

describe('http_api config', () => {
  const ok = { authType: 'bearer', baseUrl: 'https://api.example.com/v1' } as const;

  it('accepts a minimal and a full config', () => {
    expect(HttpApiConnectionConfigSchema.safeParse(ok).success).toBe(true);
    expect(
      HttpApiConnectionConfigSchema.safeParse({
        authHeaderName: 'X-Api-Key',
        authType: 'header',
        baseUrl: 'https://api.example.com',
        defaultHeaders: { Accept: 'application/json', 'X-Team': 'a' },
      }).success
    ).toBe(true);
    expect(
      HttpApiConnectionConfigSchema.safeParse({
        authType: 'basic',
        baseUrl: 'https://api.example.com',
        basicUsername: 'svc',
      }).success
    ).toBe(true);
  });

  it.each([
    ['http scheme', { baseUrl: 'http://api.example.com' }],
    ['userinfo', { baseUrl: 'https://u:p@api.example.com' }],
    ['query', { baseUrl: 'https://api.example.com/?a=1' }],
    ['fragment', { baseUrl: 'https://api.example.com/#x' }],
    ['empty query marker', { baseUrl: 'https://api.example.com/?' }],
    ['backslash', { baseUrl: 'https://api.example.com/a\\b' }],
    ['encoded slash', { baseUrl: 'https://api.example.com/a%2Fb' }],
    ['not a URL', { baseUrl: 'nope' }],
    ['encoded dots that normalise away', { baseUrl: 'https://api.example.com/v1/%2e%2e/' }],
    ['encoded percent', { baseUrl: 'https://api.example.com/%252e' }],
    ['dot segment', { baseUrl: 'https://api.example.com/a/../b' }],
    ['a tab hiding a dot segment', { baseUrl: 'https://example.com/v1/.\t./x' }],
    ['a newline in the path', { baseUrl: 'https://example.com/v1/\n/x' }],
    ['port zero', { baseUrl: 'https://api.example.com:0/v1' }],
    ['too long', { baseUrl: `https://api.example.com/${'a'.repeat(2100)}` }],
    ['missing baseUrl', {}],
    ['x-original-url default', { ...ok, defaultHeaders: { 'X-Original-URL': '/admin' } }],
    ['method override default', { ...ok, defaultHeaders: { 'X-HTTP-Method-Override': 'DELETE' } }],
    ['forwarded default', { ...ok, defaultHeaders: { Forwarded: 'for=1.1.1.1' } }],
    ['x-forwarded-host default', { ...ok, defaultHeaders: { 'X-Forwarded-Host': 'evil' } }],
    ['x-real-ip default', { ...ok, defaultHeaders: { 'X-Real-IP': '1.1.1.1' } }],
    ['unknown key', { ...ok, allowPrivateNetwork: true }],
    ['header auth without a name', { ...ok, authType: 'header' }],
    ['header name on bearer', { ...ok, authHeaderName: 'X-Key' }],
    ['credential header name', { ...ok, authHeaderName: 'Cookie', authType: 'header' }],
    ['bad header name', { ...ok, authHeaderName: 'a b', authType: 'header' }],
    ['username on bearer', { ...ok, basicUsername: 'u' }],
    ['username with colon', { ...ok, authType: 'basic', basicUsername: 'a:b' }],
    ['authorization default', { ...ok, defaultHeaders: { Authorization: 'x' } }],
    ['cookie default', { ...ok, defaultHeaders: { cookie: 'x' } }],
    ['proxy default', { ...ok, defaultHeaders: { 'Proxy-Foo': 'x' } }],
    ['host default', { ...ok, defaultHeaders: { Host: 'evil' } }],
    [
      'the auth header as default',
      { ...ok, authHeaderName: 'X-Key', authType: 'header', defaultHeaders: { 'x-key': 'v' } },
    ],
    ['newline in value', { ...ok, defaultHeaders: { 'X-A': 'a\r\nB: c' } }],
    [
      'too many defaults',
      {
        ...ok,
        defaultHeaders: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-${i}`, 'v'])),
      },
    ],
  ])('refuses %s', (_name, config) => {
    expect(HttpApiConnectionConfigSchema.safeParse(config).success).toBe(false);
  });

  it('parse returns a typed refusal instead of an empty config', () => {
    expect(parseHttpApiConnectionConfig(ok)).toEqual({ config: ok, ok: true });
    const bad = parseHttpApiConnectionConfig({ baseUrl: 'http://x.example' });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.reason).toMatch(/baseUrl/);
    expect(parseHttpApiConnectionConfig(null).ok).toBe(false);
  });
});
