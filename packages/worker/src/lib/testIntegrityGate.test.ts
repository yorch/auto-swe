import { resolveSetting } from '@auto-swe/shared/config';
import { TEST_INTEGRITY_GUARD_EVENT as TEST_INTEGRITY_EVENT } from '@auto-swe/shared/lib/testIntegrity';
import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTracer } from './agentTracer.js';
import { resolveTestIntegrityMode, runTestIntegrityGate } from './testIntegrityGate.js';

vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/config')>()),
  resolveSetting: vi.fn(),
}));

function tracer() {
  const addActivityEvent = vi.fn();
  return { addActivityEvent, tracer: { addActivityEvent } as unknown as AgentTracer };
}

const DELETES_A_TEST = [
  'diff --git a/src/a.test.ts b/src/a.test.ts',
  'deleted file mode 100644',
  '--- a/src/a.test.ts',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  "-it('adds', () => {",
  '-  expect(add(1, 2)).toBe(3);',
  '-});',
  '',
].join('\n');

const FIXES_SOURCE = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-export const add = (a, b) => a - b;',
  '+export const add = (a, b) => a + b;',
  '',
].join('\n');

async function failureOf(p: Promise<unknown>): Promise<ApplicationFailure> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApplicationFailure) {
      return err;
    }
    throw err;
  }
  throw new Error('expected the gate to fail');
}

describe('runTestIntegrityGate', () => {
  it('does not read the diff when off', async () => {
    const t = tracer();
    const readDiff = vi.fn(async () => DELETES_A_TEST);
    await expect(
      runTestIntegrityGate({ mode: 'off', readDiff, tracer: t.tracer })
    ).resolves.toEqual([]);
    expect(readDiff).not.toHaveBeenCalled();
    expect(t.addActivityEvent).not.toHaveBeenCalled();
  });

  it.each(['warn', 'block'] as const)(
    'passes a source fix in %s mode and records nothing',
    async (mode) => {
      const t = tracer();
      await expect(
        runTestIntegrityGate({ mode, readDiff: async () => FIXES_SOURCE, tracer: t.tracer })
      ).resolves.toEqual([]);
      expect(t.addActivityEvent).not.toHaveBeenCalled();
    }
  );

  it('blocks a deleted test with a non-retryable TEST_INTEGRITY_GUARD and records the trip', async () => {
    const t = tracer();
    const failure = await failureOf(
      runTestIntegrityGate({
        mode: 'block',
        readDiff: async () => DELETES_A_TEST,
        tracer: t.tracer,
      })
    );
    expect(failure.type).toBe('TEST_INTEGRITY_GUARD');
    expect(failure.nonRetryable).toBe(true);
    expect(failure.message).toContain('test_file_deleted src/a.test.ts');
    expect(failure.details?.[0]).toMatchObject({
      findings: [{ file: 'src/a.test.ts', kind: 'test_file_deleted' }],
    });
    expect(t.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: TEST_INTEGRITY_EVENT,
        outputJson: expect.objectContaining({ blocked: true, count: 1, mode: 'block' }),
      })
    );
  });

  it('lets the change through in warn mode but records the trip as not blocked', async () => {
    const t = tracer();
    const findings = await runTestIntegrityGate({
      mode: 'warn',
      readDiff: async () => DELETES_A_TEST,
      tracer: t.tracer,
    });
    expect(findings).toHaveLength(1);
    expect(t.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: TEST_INTEGRITY_EVENT,
        outputJson: expect.objectContaining({ blocked: false, mode: 'warn' }),
      })
    );
  });

  it('fails closed in block mode when the diff cannot be read', async () => {
    const t = tracer();
    const failure = await failureOf(
      runTestIntegrityGate({
        mode: 'block',
        readDiff: async () => {
          throw new Error('git exploded');
        },
        tracer: t.tracer,
      })
    );
    expect(failure.type).toBe('TEST_INTEGRITY_GUARD_UNAVAILABLE');
    expect(failure.nonRetryable).toBe(true);
    expect(t.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'git exploded', name: TEST_INTEGRITY_EVENT })
    );
  });

  it('degrades in warn mode when the diff cannot be read', async () => {
    const t = tracer();
    await expect(
      runTestIntegrityGate({
        mode: 'warn',
        readDiff: async () => {
          throw new Error('git exploded');
        },
        tracer: t.tracer,
      })
    ).resolves.toEqual([]);
  });

  it('fails closed in block mode on a diff too large to read in full', async () => {
    const t = tracer();
    const huge = `${FIXES_SOURCE}${'+x\n'.repeat(1_400_000)}`;
    const failure = await failureOf(
      runTestIntegrityGate({ mode: 'block', readDiff: async () => huge, tracer: t.tracer })
    );
    expect(failure.type).toBe('TEST_INTEGRITY_GUARD_UNAVAILABLE');
    // The report can see how often the guard read less than the whole change.
    expect(t.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: TEST_INTEGRITY_EVENT,
        outputJson: expect.objectContaining({ degraded: true, truncatedDiff: true }),
      })
    );
  });

  it('records the degraded read in warn mode too, and lets the change through', async () => {
    const t = tracer();
    const huge = `${FIXES_SOURCE}${'+x\n'.repeat(1_400_000)}`;
    await expect(
      runTestIntegrityGate({ mode: 'warn', readDiff: async () => huge, tracer: t.tracer })
    ).resolves.toEqual([]);
    expect(t.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outputJson: expect.objectContaining({ degraded: true, truncatedDiff: true }),
      })
    );
  });

  it('sees a deleted test file in an oversized diff through the name-status list', async () => {
    const t = tracer();
    const huge = `${FIXES_SOURCE}${'+x\n'.repeat(1_400_000)}`;
    const failure = await failureOf(
      runTestIntegrityGate({
        mode: 'block',
        readDiff: async () => huge,
        readNameStatus: async () => 'D\tsrc/a.test.ts\n',
        tracer: t.tracer,
      })
    );
    expect(failure.type).toBe('TEST_INTEGRITY_GUARD');
    expect(failure.message).toContain('test_file_deleted src/a.test.ts');
  });

  it('records but does not block on low-severity findings', async () => {
    const t = tracer();
    const fixture = [
      'diff --git a/test/fixtures/a.json b/test/fixtures/a.json',
      'deleted file mode 100644',
      '--- a/test/fixtures/a.json',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-{}',
      '',
    ].join('\n');
    const findings = await runTestIntegrityGate({
      mode: 'block',
      readDiff: async () => fixture,
      tracer: t.tracer,
    });
    expect(findings).toHaveLength(1);
    expect(t.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outputJson: expect.objectContaining({ blocked: false, highCount: 0, mode: 'block' }),
      })
    );
  });
});

describe('resolveTestIntegrityMode floor', () => {
  const ctx = {} as Parameters<typeof resolveTestIntegrityMode>[0];
  const setting = (value: unknown) => vi.mocked(resolveSetting).mockResolvedValue(value as never);

  it.each([
    ['off', undefined, 'off'],
    ['warn', undefined, 'warn'],
    ['block', undefined, 'block'],
    ['banana', undefined, 'warn'],
    ['off', 'warn', 'warn'],
    ['warn', 'warn', 'warn'],
    ['block', 'warn', 'block'],
    ['off', 'block', 'block'],
    ['warn', 'block', 'block'],
    ['block', 'block', 'block'],
  ] as const)('setting %s with floor %s is %s', async (configured, floor, expected) => {
    setting(configured);
    expect(await resolveTestIntegrityMode(ctx, floor)).toBe(expected);
  });

  it('answers a block floor without reading the setting, so a lookup failure cannot loosen it', async () => {
    vi.mocked(resolveSetting).mockReset();
    vi.mocked(resolveSetting).mockRejectedValue(new Error('down'));
    expect(await resolveTestIntegrityMode(ctx, 'block')).toBe('block');
    expect(resolveSetting).not.toHaveBeenCalled();
    await expect(resolveTestIntegrityMode(ctx)).rejects.toThrow('down');
  });
});
