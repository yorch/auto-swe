import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  composeArgs,
  missingProviders,
  namespaceReady,
  nextSteps,
  nodeMajor,
  parseComposeState,
  parseQuickstartArgs,
  preflightProblems,
  resolveKeys,
  serviceHealthy,
  waitUntil,
  workerLogVerdict,
} from './quickstart.mjs';

const defaults = parseQuickstartArgs([]).options;

describe('parseQuickstartArgs', () => {
  it('defaults to up with the conventional key variables', () => {
    expect(defaults).toMatchObject({
      anthropicKeyEnv: 'ANTHROPIC_API_KEY',
      check: false,
      command: 'up',
      openaiKeyEnv: 'OPENAI_API_KEY',
    });
  });

  it('reads flags and the down command', () => {
    const { options } = parseQuickstartArgs(['down', '--check', '--no-start', '--skip-install']);
    expect(options).toMatchObject({
      check: true,
      command: 'down',
      noStart: true,
      skipInstall: true,
    });
  });

  it('takes a variable NAME for the key flags and refuses something shaped like a key', () => {
    expect(parseQuickstartArgs(['--anthropic-key-env', 'MY_KEY']).options.anthropicKeyEnv).toBe(
      'MY_KEY'
    );
    const refused = parseQuickstartArgs(['--openai-key-env', 'sk-proj-abc.def']);
    expect(refused.error).toMatch(/NAME of an environment variable/);
    expect(refused.error).not.toContain('sk-proj');
  });

  it('refuses unknown commands and flags', () => {
    expect(parseQuickstartArgs(['sideways']).error).toMatch(/unknown command/);
    expect(parseQuickstartArgs(['--api-key', 'x']).error).toBeDefined();
  });
});

describe('preflightProblems', () => {
  const ok = { dockerOk: true, nodeVersion: 'v26.0.0', yarnOk: true };

  it('is empty when the host is ready', () => {
    expect(preflightProblems(ok)).toEqual([]);
  });

  it('names each missing prerequisite', () => {
    const problems = preflightProblems({ dockerOk: false, nodeVersion: 'v22.1.0', yarnOk: false });
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/Node\.js 26/);
    expect(problems.join('\n')).toMatch(/yarn/);
    expect(problems.join('\n')).toMatch(/Docker/);
  });

  it('reads the Node major from a version string', () => {
    expect(nodeMajor('v26.1.2')).toBe(26);
    expect(nodeMajor('garbage')).toBeNaN();
    expect(preflightProblems({ ...ok, nodeVersion: 'garbage' })).toHaveLength(1);
  });
});

describe('keys', () => {
  it('reads keys from the named variables and treats blanks as absent', () => {
    const keys = resolveKeys(
      { ANTHROPIC_API_KEY: ' a ', CUSTOM: 'o', OPENAI_API_KEY: '  ' },
      { ...defaults, openaiKeyEnv: 'CUSTOM' }
    );
    expect(keys).toEqual({ anthropic: 'a', openai: 'o' });
    expect(missingProviders(resolveKeys({}, defaults))).toEqual(['anthropic', 'openai']);
    expect(missingProviders(keys)).toEqual([]);
  });
});

describe('composeArgs', () => {
  it('uses the infrastructure file only, through compose.mjs', () => {
    const base = composeArgs();
    expect(base).toEqual([
      'scripts/compose.mjs',
      '--add-profile',
      'temporal-ui',
      '-f',
      'docker-compose.infra.yml',
    ]);
    expect(base).not.toContain('--profile');
  });
});

describe('buildPlan', () => {
  const state = { depsInstalled: false, envExists: false, missing: [] };
  const ids = (plan) => plan.filter((s) => !s.skip).map((s) => s.id);

  it('orders the whole bring-up', () => {
    expect(ids(buildPlan(defaults, state))).toEqual([
      'env',
      'install',
      'infra',
      'wait-infra',
      'db-deploy',
      'db-generate',
      'db-seed',
      'model-config',
      'start-gateway',
      'start-web',
      'start-worker',
    ]);
  });

  it('checks an existing .env instead of creating one', () => {
    const [env] = buildPlan(defaults, { ...state, envExists: true });
    expect(env.run[1]).toEqual(['scripts/env-setup.mjs', 'check', '--yes']);
    expect(buildPlan(defaults, state)[0].run[1]).toEqual([
      'scripts/env-setup.mjs',
      'init',
      '--yes',
    ]);
  });

  it('skips install when dependencies exist or --skip-install is given', () => {
    expect(ids(buildPlan(defaults, { ...state, depsInstalled: true }))).not.toContain('install');
    expect(ids(buildPlan({ ...defaults, skipInstall: true }, state))).not.toContain('install');
  });

  it('does not start the worker, and skips credentials, when no key was supplied', () => {
    const plan = buildPlan(defaults, { ...state, missing: ['anthropic', 'openai'] });
    expect(ids(plan)).not.toContain('model-config');
    expect(ids(plan)).not.toContain('start-worker');
    expect(ids(plan)).toContain('start-gateway');
  });

  it('does not start the worker when only one key is missing, but still stores the other', () => {
    const plan = buildPlan(defaults, { ...state, missing: ['openai'] });
    expect(ids(plan)).toContain('model-config');
    expect(ids(plan)).not.toContain('start-worker');
  });

  it('stops after the database with --no-start', () => {
    expect(ids(buildPlan({ ...defaults, noStart: true }, state))).toEqual([
      'env',
      'install',
      'infra',
      'wait-infra',
      'db-deploy',
      'db-generate',
      'db-seed',
      'model-config',
    ]);
  });

  it('puts no key value in any command line', () => {
    const plan = buildPlan(defaults, state);
    for (const step of plan.filter((s) => s.run)) {
      expect(step.run[1].join(' ')).not.toMatch(/sk-|API_KEY/);
    }
  });
});

describe('compose state', () => {
  const rows = [
    { ExitCode: 0, Service: 'temporal-setup-namespace', State: 'exited' },
    { Health: 'healthy', Service: 'postgres', State: 'running' },
    { Health: 'starting', Service: 'temporal', State: 'running' },
  ];

  it('parses both the NDJSON and the array output shapes', () => {
    expect(parseComposeState(rows.map((r) => JSON.stringify(r)).join('\n'))).toEqual(rows);
    expect(parseComposeState(JSON.stringify(rows))).toEqual(rows);
    expect(parseComposeState('  ')).toEqual([]);
  });

  it('judges readiness from state, exit code and health', () => {
    expect(namespaceReady(rows)).toBe(true);
    expect(namespaceReady([{ ...rows[0], ExitCode: 1 }])).toBe(false);
    expect(namespaceReady([])).toBe(false);
    expect(serviceHealthy(rows, 'postgres')).toBe(true);
    expect(serviceHealthy(rows, 'temporal')).toBe(false);
    expect(serviceHealthy(rows, 'absent')).toBe(false);
    expect(serviceHealthy([{ Service: 'x', State: 'running' }], 'x')).toBe(true);
  });
});

describe('waitUntil', () => {
  it('returns once the probe succeeds', async () => {
    let calls = 0;
    const ok = await waitUntil(async () => ++calls === 3, {
      intervalMs: 1,
      sleep: async () => {},
      timeoutMs: 1000,
    });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('gives up at the deadline', async () => {
    let t = 0;
    const ok = await waitUntil(async () => false, {
      intervalMs: 10,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 35,
    });
    expect(ok).toBe(false);
    expect(t).toBeLessThanOrEqual(40);
  });
});

describe('workerLogVerdict', () => {
  it('distinguishes ready, incomplete configuration and still starting', () => {
    expect(workerLogVerdict('Worker started, polling task queue: engineering-workflow')).toBe(
      'ready'
    );
    expect(workerLogVerdict('Error: LLM configuration incomplete. The worker cannot')).toBe(
      'config-incomplete'
    );
    expect(workerLogVerdict('compiling')).toBe('pending');
  });
});

describe('nextSteps', () => {
  it('points at the dashboard and never prints a secret value', () => {
    const text = nextSteps({ missing: [], started: ['gateway', 'web', 'worker'] });
    expect(text).toContain('http://localhost:3000');
    expect(text).toContain('SEED_ADMIN_PASSWORD');
    expect(text).toContain('ticket-to-merge');
    expect(text).not.toContain('NOT running');
  });

  it('says why the worker is down when a key is missing', () => {
    const text = nextSteps({ missing: ['anthropic'], started: ['gateway', 'web'] });
    expect(text).toContain('The worker is NOT running');
    expect(text).toContain('/models');
  });
});
