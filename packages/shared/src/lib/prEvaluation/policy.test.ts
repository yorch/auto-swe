import { describe, expect, it } from 'vitest';
import { classify } from './classify.js';
import {
  DEFAULT_THRESHOLDS,
  MAX_POLICY_FILE_BYTES,
  mergePolicy,
  parsePolicyFile,
} from './policy.js';

const floor = { ...DEFAULT_THRESHOLDS, sensitivePaths: ['internal/**'] };

describe('parsePolicyFile', () => {
  it('parses a valid file', () => {
    const { policy, errors } = parsePolicyFile(
      'version: 1\nsensitivePaths: ["billing/**"]\nmaxLowLines: 100\n'
    );
    expect(errors).toEqual([]);
    expect(policy?.maxLowLines).toBe(100);
  });

  it('never throws on garbage and reports an error', () => {
    for (const text of ['', ':::', '[1,2', '- a\n- b', '42', 'null', '\u0000\u0001', '{{{{']) {
      const result = parsePolicyFile(text);
      expect(result.policy, JSON.stringify(text)).toBeUndefined();
      expect(result.errors.length).toBeGreaterThan(0);
    }
    expect(parsePolicyFile(undefined as unknown as string).errors.length).toBeGreaterThan(0);
  });

  it('refuses a file over 64 KiB', () => {
    const big = `version: 1\n# ${'x'.repeat(MAX_POLICY_FILE_BYTES)}\n`;
    const result = parsePolicyFile(big);
    expect(result.policy).toBeUndefined();
    expect(result.errors[0]).toMatch(/larger than 64 KiB/);
  });

  it('refuses aliases, including an expansion bomb', () => {
    const bomb = [
      'version: 1',
      'a: &a [x, x, x, x, x, x, x, x, x]',
      'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]',
      'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]',
      'd: [*c, *c, *c, *c, *c, *c, *c, *c, *c]',
    ].join('\n');
    const start = Date.now();
    const result = parsePolicyFile(bomb);
    expect(result.policy).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    // An expansion bomb does not finish at all, so this only has to separate "refused" from
    // "hung"; it is loose so instrumented CI runs (v8 coverage) do not flake it.
    expect(Date.now() - start).toBeLessThan(30_000);
  }, 60_000);

  it('refuses prototype-pollution keys without polluting', () => {
    for (const text of [
      'version: 1\n__proto__:\n  polluted: true\n',
      'version: 1\nconstructor:\n  prototype:\n    polluted: true\n',
      '{"version": 1, "__proto__": {"polluted": true}}',
    ]) {
      const result = parsePolicyFile(text);
      expect(result.policy).toBeUndefined();
      expect(result.errors.length).toBeGreaterThan(0);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects unknown keys, bad versions, bad types and bad globs', () => {
    expect(parsePolicyFile('version: 1\nfoo: 1\n').policy).toBeUndefined();
    expect(parsePolicyFile('version: 2\n').policy).toBeUndefined();
    expect(parsePolicyFile('version: 1\nmaxLowLines: "many"\n').policy).toBeUndefined();
    expect(parsePolicyFile('version: 1\nlowApprovers: 0\n').policy).toBeUndefined();
    expect(parsePolicyFile('version: 1\nsensitivePaths: ["{a,b"]\n').policy).toBeUndefined();
  });

  it('refuses the unsupported requiredReviewers key as an unknown key (fails closed)', () => {
    const result = parsePolicyFile('version: 1\nrequiredReviewers: [alice]\n');
    expect(result.policy).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(' ')).toMatch(/requiredReviewers/);
  });

  it('records relaxation keys instead of applying them', () => {
    const { policy, errors } = parsePolicyFile('version: 1\nmode: auto\ndisableExclusions: true\n');
    expect(errors).toEqual([]);
    expect(policy?.relaxations).toEqual(['mode', 'disableExclusions']);
  });
});

describe('mergePolicy', () => {
  it('returns the floor when there is no file', () => {
    const { effective, warnings } = mergePolicy(floor);
    expect(warnings).toEqual([]);
    expect(effective.maxLowLines).toBe(400);
    expect(effective.sensitivePaths).toEqual(['internal/**']);
  });

  it('applies stricter values', () => {
    const { effective, warnings } = mergePolicy(floor, {
      highApprovers: 3,
      highLines: 500,
      highRiskPaths: ['core/**'],
      ignoredFromSkim: ['gen/**'],
      lowApprovers: 2,
      maxLowDirs: 1,
      maxLowFiles: 3,
      maxLowLines: 100,
      sensitivePaths: ['billing/**', 'internal/**'],
      standardApprovers: 2,
      version: 1,
    });
    expect(warnings).toEqual([]);
    expect(effective).toMatchObject({
      highApprovers: 3,
      highLines: 500,
      highRiskPaths: ['core/**'],
      ignoredFromSkim: ['gen/**'],
      lowApprovers: 2,
      maxLowDirs: 1,
      maxLowFiles: 3,
      maxLowLines: 100,
      sensitivePaths: ['internal/**', 'billing/**'],
      standardApprovers: 2,
    });
  });

  it('ignores and reports every relaxation', () => {
    const { effective, warnings } = mergePolicy(floor, {
      highApprovers: 1,
      highLines: 99999,
      lowApprovers: 1,
      maxLowDirs: 99,
      maxLowFiles: 99,
      maxLowLines: 9000,
      relaxations: ['mode', 'disableExclusions'],
      standardApprovers: 1,
      version: 1,
    });
    expect(effective).toMatchObject({ ...DEFAULT_THRESHOLDS });
    expect(warnings.some((w) => w.startsWith('maxLowLines'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('maxLowFiles'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('maxLowDirs'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('highLines'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('highApprovers'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('mode'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('disableExclusions'))).toBe(true);
  });

  it('never lets a file remove a floor path', () => {
    const { effective } = mergePolicy(floor, { sensitivePaths: [], version: 1 });
    expect(effective.sensitivePaths).toContain('internal/**');
  });
});

describe('policy hardening regressions', () => {
  const braces = (n: number) => `{${Array.from({ length: n }, (_, i) => `a${i}`).join(',')}}`;
  const yamlList = (key: string, items: string[]) =>
    `${key}:\n${items.map((i) => `  - "${i}"`).join('\n')}\n`;

  it('rejects the old pathological policy file quickly (finding 6)', () => {
    const globs = Array.from({ length: 170 }, (_, i) => `**/*x${i}*${braces(30)}*y*z*w*v*`);
    const text = `version: 1\n${yamlList('sensitivePaths', globs)}`;
    expect(text.length).toBeLessThan(64 * 1024);
    parsePolicyFile('version: 1\n'); // warm the schema so the timing is the work, not the first load
    const start = Date.now();
    const result = parsePolicyFile(text);
    // The pathological file took ~58 s before it was rejected at parse time; the bound only has to
    // stay well below that, so it is loose enough not to flake under coverage on a CI runner.
    expect(Date.now() - start).toBeLessThan(20_000);
    expect(result.policy).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  }, 60_000);

  it('rejects a file whose globs cost too much per path to evaluate (finding 6)', () => {
    const globs = Array.from({ length: 60 }, (_, i) => `**/*a*a*${braces(2)}*s${i}*`);
    const result = parsePolicyFile(`version: 1\n${yamlList('sensitivePaths', globs)}`);
    expect(result.policy).toBeUndefined();
    expect(result.errors[0]).toMatch(/too expensive/);
  });

  it('rejects too many globs in total, long globs, many stars and wide braces (finding 6)', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `d${i}/**`);
    expect(
      parsePolicyFile(`version: 1\n${yamlList('sensitivePaths', many(201))}`).policy
    ).toBeUndefined();
    const split = `version: 1\n${yamlList('sensitivePaths', many(100))}${yamlList('highRiskPaths', many(101))}`;
    expect(parsePolicyFile(split).errors[0]).toMatch(/201 globs/);
    expect(
      parsePolicyFile(`version: 1\n${yamlList('sensitivePaths', [`${'a'.repeat(201)}`])}`).policy
    ).toBeUndefined();
    expect(
      parsePolicyFile(`version: 1\n${yamlList('sensitivePaths', ['*a*a*a*a*a*a*a*a*a'])}`).policy
    ).toBeUndefined();
    expect(
      parsePolicyFile(`version: 1\n${yamlList('sensitivePaths', [`x/${braces(17)}`])}`).policy
    ).toBeUndefined();
    expect(
      parsePolicyFile(`version: 1\n${yamlList('sensitivePaths', ['*a*a*a*a*a*a*a*a'])}`).policy
    ).toBeDefined();
    expect(
      parsePolicyFile(`version: 1\n${yamlList('sensitivePaths', [`x/${braces(16)}`])}`).policy
    ).toBeDefined();
  });

  // The claim is that cost grows linearly with the file count, so it is a ratio: an absolute
  // bound flaked under v8 coverage (CI runs `--coverage`, ~10x slower here, more on a runner) and
  // would also pass a quadratic regression on a fast machine.
  it('classifies in linear time under a maximal accepted policy (finding 6)', () => {
    // star-leading globs (so nothing is rejected on its first token) with brace alternatives,
    // filling the per-file cost budget; the rest are cheap prefixes
    const hard = (i: number) => `**/*a*a*${braces(2)}*s${i}*`;
    const globs = [
      ...Array.from({ length: 20 }, (_, i) => hard(i)),
      ...Array.from({ length: 90 }, (_, i) => `d${i}/**`),
    ];
    const text = `version: 1\n${yamlList('sensitivePaths', globs.slice(0, 40))}${yamlList('highRiskPaths', globs.slice(40, 80))}${yamlList('ignoredFromSkim', globs.slice(80))}`;
    const { policy, errors } = parsePolicyFile(text);
    expect(errors.slice(0, 2)).toEqual([]);
    const { effective, fileRejected } = mergePolicy(
      { ...DEFAULT_THRESHOLDS, sensitivePaths: [] },
      policy
    );
    expect(fileRejected).toBe(false);
    const timeClassify = (count: number): number => {
      const files = Array.from({ length: count }, (_, i) => ({
        additions: 3,
        deletions: 1,
        patch: '@@ -1 +1 @@\n+x',
        path: `services/${'aaaaaaaa/'.repeat(5)}module${i}/handler${'a'.repeat(30)}.ts`,
        status: 'modified' as const,
      }));
      // CPU time of this process, not wall time: a busy machine (CI runs ~1000 test files at once,
      // under coverage) stretches wall time by scheduling delays that have nothing to do with the
      // work, and one stretched sample breaks a ratio.
      const before = process.cpuUsage();
      classify(
        {
          draft: false,
          files,
          maxReviewSeverity: 'PASS',
          policyFileChanged: false,
          scannerFindingCount: 0,
        },
        effective
      );
      const used = process.cpuUsage(before);
      return (used.user + used.system) / 1000;
    };
    // The best of three on each side discards the samples that a GC pause or a noisy neighbour
    // inflated, which is what a ratio of two single samples cannot do.
    const best = (count: number): number =>
      Math.min(timeClassify(count), timeClassify(count), timeClassify(count));
    timeClassify(200); // warm the glob cache so the first measurement is the work, not the compile
    const small = best(600);
    const large = best(2400);
    // 4x the files: linear is ~4x, quadratic ~16x. 10x leaves room for what is left of the noise.
    expect(large / small).toBeLessThan(10);
  }, 300_000);

  it('rejects a file whose union with the defaults is over 400 globs, and says so (finding 6)', () => {
    const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}/**`);
    const { effective, warnings, fileRejected } = mergePolicy(
      { ...DEFAULT_THRESHOLDS, sensitivePaths: many(150, 'op') },
      {
        highRiskPaths: many(100, 'hr'),
        ignoredFromSkim: many(100, 'ig'),
        maxLowLines: 10,
        sensitivePaths: many(100, 'fs'),
        version: 1,
      }
    );
    expect(fileRejected).toBe(true);
    expect(warnings.some((w) => w.startsWith('policy-file-too-large'))).toBe(true);
    expect(effective.sensitivePaths).toEqual(many(150, 'op'));
    expect(effective.maxLowLines).toBe(DEFAULT_THRESHOLDS.maxLowLines);
    expect(effective.highRiskPaths).toEqual([]);
  });

  it('keeps approver counts monotonic and at least one (finding 9)', () => {
    const { effective, warnings } = mergePolicy(
      {
        ...DEFAULT_THRESHOLDS,
        highApprovers: 1,
        lowApprovers: 1,
        sensitivePaths: [],
        standardApprovers: 1,
      },
      { lowApprovers: 3, version: 1 }
    );
    expect(effective).toMatchObject({ highApprovers: 3, lowApprovers: 3, standardApprovers: 3 });
    expect(warnings.some((w) => w.includes('approver counts raised'))).toBe(true);
    const zero = mergePolicy({
      ...DEFAULT_THRESHOLDS,
      highApprovers: 0,
      lowApprovers: 0,
      sensitivePaths: [],
      standardApprovers: Number.NaN,
    });
    expect(zero.effective).toMatchObject({
      highApprovers: 1,
      lowApprovers: 1,
      standardApprovers: 1,
    });
    expect(mergePolicy(floor).warnings).toEqual([]);
  });
});
