import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE,
  DEFAULT_MODEL,
  DEFAULT_REPO,
  estimateCostUsd,
  formatReport,
  parseSmokeArgs,
  runSmoke,
  type SmokeReport,
} from './smoke.js';

describe('parseSmokeArgs', () => {
  it('requires the key from the environment unless the model is mocked', () => {
    expect(() => parseSmokeArgs([], {})).toThrow(/PI_SMOKE_API_KEY/);
    expect(() => parseSmokeArgs(['--api-key', 'x'], { PI_SMOKE_API_KEY: 'k' })).toThrow();
    expect(parseSmokeArgs(['--mock'], {})).toMatchObject({ apiKey: undefined, mock: true });
  });

  it('defaults, reads PI_SMOKE_* and lets a flag win', () => {
    const env = {
      PI_SMOKE_API_KEY: 'k',
      PI_SMOKE_IMAGE: 'img:1',
      PI_SMOKE_MODEL: 'openai/gpt-6-luna',
    };

    expect(parseSmokeArgs([], { PI_SMOKE_API_KEY: 'k' })).toMatchObject({
      apiKey: 'k',
      deadlineSeconds: 300,
      image: DEFAULT_IMAGE,
      maxSteps: 12,
      model: DEFAULT_MODEL,
      noDbScanners: false,
      repoUrl: DEFAULT_REPO,
    });
    expect(parseSmokeArgs([], env)).toMatchObject({ image: 'img:1', model: 'openai/gpt-6-luna' });
    expect(parseSmokeArgs(['--model', 'google/x', '--no-db-scanners'], env)).toMatchObject({
      model: 'google/x',
      noDbScanners: true,
    });
  });

  it('copies a local directory instead of cloning, and refuses both', () => {
    expect(parseSmokeArgs(['--mock', '--dir', '/tmp/r'], {})).toMatchObject({
      dir: '/tmp/r',
      repoUrl: undefined,
    });
    expect(() => parseSmokeArgs(['--mock', '--dir', '/tmp/r', '--repo', 'u'], {})).toThrow(
      /not both/
    );
  });

  it('rejects a non-positive cap', () => {
    expect(() => parseSmokeArgs(['--mock', '--max-steps', '0'], {})).toThrow(/positive integer/);
  });
});

describe('estimateCostUsd', () => {
  it('prices a known model from the built-in table, cache at its multipliers', () => {
    const plain = estimateCostUsd('anthropic/claude-sonnet-5-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(plain).toBeGreaterThan(0);
    const cached = estimateCostUsd('anthropic/claude-sonnet-5-5', {
      cachedInputTokens: 1_000_000,
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cached).toBeCloseTo((plain as number) * 0.1, 6);
  });

  it('is null for a model the table does not price', () => {
    expect(estimateCostUsd('acme/unknown', { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});

describe('formatReport', () => {
  const report: SmokeReport = {
    costNote: 'note',
    costUsd: 0.0123,
    diffStat: ' SMOKE.md | 1 +\n',
    image: 'img',
    mock: false,
    model: 'anthropic/claude-sonnet-5-5',
    modelCalls: [
      {
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.01,
        index: 1,
        inputTokens: 100,
        outputTokens: 20,
      },
    ],
    scannerSource: 'database',
    text: 'done',
    toolCallCount: 2,
    toolCalls: [
      { decision: 'ok', input: '{"path":"a"}', name: 'write' },
      { decision: 'blocked', error: 'blocked by shell command scanner', input: '{}', name: 'bash' },
    ],
    wallMs: 4200,
  };

  it('lists each call, the diff, the time and the cost', () => {
    const text = formatReport(report);
    expect(text).toContain('Tool calls (2)');
    expect(text).toContain('blocked');
    expect(text).toContain('error: blocked by shell command scanner');
    expect(text).toContain('SMOKE.md | 1 +');
    expect(text).toContain('Wall time 4.2s');
    expect(text).toContain('~$0.0123');
  });

  it('says a failed turn failed and an unpriced model is unpriced', () => {
    const text = formatReport({ ...report, costUsd: null, error: 'Error: 401' });
    expect(text).toContain('TURN FAILED: Error: 401');
    expect(text).toContain('Cost unknown');
  });
});

describe('runSmoke', () => {
  it('refuses to run unscanned: no database and no explicit built-in mode', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(
        runSmoke({
          deadlineSeconds: 1,
          image: 'img',
          maxSteps: 1,
          mock: true,
          model: DEFAULT_MODEL,
          noDbScanners: false,
          prompt: 'p',
        })
      ).rejects.toThrow(/--no-db-scanners/);
    } finally {
      if (saved !== undefined) {
        process.env.DATABASE_URL = saved;
      }
    }
  });
});
