import { describe, expect, it } from 'vitest';
import { draftToSetup, EMPTY_STEP, setupDraft } from './repoSetupDraft';

const full = {
  cache: { keyFiles: ['yarn.lock'], paths: ['node_modules', '~/.cache/x'] },
  env: { CI: '1' },
  lfs: true,
  steps: [
    { name: 'install', run: 'yarn install --immutable', timeoutSeconds: 900 },
    { run: './scripts/codegen.sh', workdir: 'packages/api' },
  ],
  submodules: 'recursive' as const,
};

describe('repoSetupDraft', () => {
  it('round-trips a full definition', () => {
    expect(draftToSetup(setupDraft(full))).toEqual({ ok: true, setup: full });
  });

  it('stores nothing when the section is off, so the repo file applies', () => {
    expect(setupDraft(null).enabled).toBe(false);
    expect(draftToSetup({ ...setupDraft(full), enabled: false })).toEqual({
      ok: true,
      setup: null,
    });
  });

  it('drops blank rows and maps submodules on to true', () => {
    const draft = {
      ...setupDraft({}),
      env: [{ key: '', value: '' }],
      steps: [EMPTY_STEP, { ...EMPTY_STEP, run: 'make' }],
      submodules: 'on' as const,
    };
    expect(draftToSetup(draft)).toEqual({
      ok: true,
      setup: { steps: [{ run: 'make' }], submodules: true },
    });
  });

  it('refuses what the schema refuses, and a non-numeric timeout', () => {
    const base = setupDraft({});
    expect(draftToSetup({ ...base, steps: [{ ...EMPTY_STEP, run: 'x', timeout: '1m' }] }).ok).toBe(
      false
    );
    expect(
      draftToSetup({ ...base, steps: [{ ...EMPTY_STEP, run: 'x', workdir: '../up' }] }).ok
    ).toBe(false);
    expect(draftToSetup({ ...base, env: [{ key: 'lower', value: '1' }] }).ok).toBe(false);
    expect(draftToSetup({ ...base, cacheKeyFiles: 'yarn.lock' }).ok).toBe(false);
  });
});

describe('setup secret names', () => {
  it('round-trips the names, one per line or comma-separated', () => {
    const draft = {
      ...setupDraft(null),
      enabled: true,
      secrets: 'NPM_TOKEN, PIP_TOKEN\nGH_PACKAGES',
    };
    const result = draftToSetup(draft);
    expect(result).toMatchObject({
      ok: true,
      setup: { secrets: ['NPM_TOKEN', 'PIP_TOKEN', 'GH_PACKAGES'] },
    });
    expect(setupDraft({ secrets: ['NPM_TOKEN'] }).secrets).toBe('NPM_TOKEN');
  });
});
