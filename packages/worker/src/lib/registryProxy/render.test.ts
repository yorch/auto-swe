import { describe, expect, it } from 'vitest';
import {
  registryWorkspaceEnv,
  renderNpmrc,
  renderYarnrc,
  splitRegistryWorkspaceEnv,
} from './render.js';

const BASE = 'http://proxy.internal:9999';
const TOKEN = 'f00dfacecafebeef';
const NPM = { ecosystem: 'npm' as const, id: 'npm-1', isDefault: true, scopes: [] };
const SCOPED = { ecosystem: 'npm' as const, id: 'npm-2', isDefault: false, scopes: ['@acme'] };
const GO = { ecosystem: 'go' as const, id: 'go-1', isDefault: true, scopes: [] };

describe('registryWorkspaceEnv with a go registry', () => {
  it('points GOPROXY at the proxy alone, with the token as a path segment', () => {
    const env = registryWorkspaceEnv([GO], BASE, TOKEN);
    expect(env).toContain(`GOPROXY=http://proxy.internal:9999/go/${TOKEN}/go-1`);
    // No `,direct` and no second entry: a refused module is not fetched from its VCS.
    const goproxy = env.find((p) => p.startsWith('GOPROXY=')) ?? '';
    // Go will not send userinfo credentials over http, so there is none.
    expect(goproxy).not.toContain('@');
    expect(goproxy).not.toContain(',');
    expect(goproxy).not.toContain('direct');
    expect(env).toContain('GOTOOLCHAIN=local');
  });

  it('gives a Go-only workspace no npm, Corepack or Yarn env', () => {
    const env = registryWorkspaceEnv([GO], BASE, TOKEN);
    expect(env.filter((p) => /^(NPM_|YARN_|COREPACK_)/.test(p))).toEqual([]);
  });

  it('keeps the npm env exactly as it was for an npm-only list', () => {
    const env = registryWorkspaceEnv([NPM], BASE, TOKEN);
    expect(env).toEqual([
      'NPM_CONFIG_USERCONFIG=/workspace/.auto-swe/npmrc',
      'NPM_CONFIG_REPLACE_REGISTRY_HOST=always',
      'NPM_CONFIG_AUDIT=false',
      'NPM_CONFIG_FUND=false',
      'NPM_CONFIG_UPDATE_NOTIFIER=false',
      `NPM_CONFIG_REGISTRY=${BASE}/npm/npm-1`,
      `YARN_NPM_REGISTRY_SERVER=${BASE}/npm/npm-1`,
      `COREPACK_NPM_REGISTRY=${BASE}/npm/npm-1`,
      `COREPACK_NPM_TOKEN=${TOKEN}`,
      'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
      `YARN_NPM_AUTH_TOKEN=${TOKEN}`,
      'YARN_NPM_ALWAYS_AUTH=true',
    ]);
    expect(env.some((p) => p.startsWith('GOPROXY=') || p.startsWith('GOTOOLCHAIN='))).toBe(false);
  });

  it('emits both blocks when both ecosystems are present, npm default never the go one', () => {
    const env = registryWorkspaceEnv([GO, NPM], BASE, TOKEN);
    expect(env).toContain(`NPM_CONFIG_REGISTRY=${BASE}/npm/npm-1`);
    expect(env).toContain(`GOPROXY=http://proxy.internal:9999/go/${TOKEN}/go-1`);
    expect(env.join('\n')).not.toContain('/npm/go-1');
  });

  it('does not take a go registry for the npm default even if it is first and default', () => {
    const env = registryWorkspaceEnv([GO, SCOPED], BASE, TOKEN);
    // The only npm registry is scoped, so there is no npm default to point NPM_CONFIG_REGISTRY at.
    expect(env.some((p) => p.startsWith('NPM_CONFIG_REGISTRY='))).toBe(false);
    expect(env.join('\n')).not.toContain('go-1/');
  });
});

describe('splitRegistryWorkspaceEnv with a go registry', () => {
  const split = (regs: Parameters<typeof registryWorkspaceEnv>[0]) =>
    splitRegistryWorkspaceEnv(registryWorkspaceEnv(regs, BASE, TOKEN));

  it('puts the token in secretEnv only, for npm-only, go-only and both', () => {
    const npm = split([NPM]);
    expect(Object.keys(npm.secretEnv).sort()).toEqual([
      'COREPACK_NPM_TOKEN',
      'YARN_NPM_AUTH_TOKEN',
    ]);

    const go = split([GO]);
    expect(Object.keys(go.secretEnv)).toEqual(['GOPROXY']);
    expect(go.secretEnv.GOPROXY).toContain(TOKEN);

    const both = split([NPM, GO]);
    expect(Object.keys(both.secretEnv).sort()).toEqual([
      'COREPACK_NPM_TOKEN',
      'GOPROXY',
      'YARN_NPM_AUTH_TOKEN',
    ]);
    for (const { env } of [npm, go, both]) {
      expect(env.join('\n')).not.toContain(TOKEN);
    }
  });

  it('leaves GOTOOLCHAIN in plain env', () => {
    expect(split([GO]).env).toContain('GOTOOLCHAIN=local');
  });
});

describe('npm renderers skip go registries', () => {
  it('renderNpmrc never names a go registry id', () => {
    const rc = renderNpmrc([NPM, GO, SCOPED], BASE, TOKEN);
    expect(rc).toContain(`/npm/npm-1/:_authToken=${TOKEN}`);
    expect(rc).toContain(`/npm/npm-2/:_authToken=${TOKEN}`);
    expect(rc).not.toContain('go-1');
  });

  it('renderYarnrc never names a go registry id', () => {
    const rc = renderYarnrc([GO, SCOPED], BASE) ?? '';
    expect(rc).toContain('/npm/npm-2');
    expect(rc).not.toContain('go-1');
  });

  it('renderYarnrc is null for a list of only go registries', () => {
    expect(renderYarnrc([GO], BASE)).toBeNull();
  });
});
