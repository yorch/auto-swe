import type { PullRequestCockpitFile, PullRequestCockpitFinding } from '@auto-swe/shared/types/api';
import { describe, expect, it } from 'vitest';
import {
  applyViewed,
  filesUnavailableMessage,
  filterFiles,
  findingCounts,
  findingsByLine,
  restoreViewed,
  shortSha,
  unanchoredFindings,
  viewedProgress,
} from './reviewModel';

const file = (over: Partial<PullRequestCockpitFile> = {}): PullRequestCockpitFile => ({
  additions: 1,
  deletions: 0,
  flagged: false,
  patch: '@@ -1 +1 @@',
  patchDigest: 'd',
  path: 'a.ts',
  previousPath: null,
  skim: null,
  status: 'modified',
  verify: null,
  why: null,
  ...over,
});

const finding = (over: Partial<PullRequestCockpitFinding> = {}): PullRequestCockpitFinding => ({
  anchored: true,
  category: 'logic',
  description: 'off by one',
  file: 'a.ts',
  line: 3,
  reviewer: 'DOMAIN_LOGIC',
  severity: 'WARNING',
  suggestedFix: '',
  ...over,
});

describe('filterFiles', () => {
  const files = [
    file({ flagged: true, path: 'a.ts' }),
    file({ path: 'b.ts', skim: 'exact-rename' }),
    file({ path: 'c.ts' }),
  ];
  const viewed = new Set(['a.ts']);

  it.each([
    ['all', ['a.ts', 'b.ts', 'c.ts']],
    ['verify', ['a.ts']],
    ['unviewed', ['b.ts', 'c.ts']],
    ['skim', ['b.ts']],
  ] as const)('keeps the %s files, in reading order', (filter, expected) => {
    expect(filterFiles(files, viewed, filter).map((f) => f.path)).toEqual(expected);
  });

  it('returns a copy for "all", so a caller cannot change the list it was given', () => {
    const all = filterFiles(files, viewed, 'all');
    all.pop();
    expect(files).toHaveLength(3);
  });
});

describe('viewedProgress', () => {
  it('counts only the files that can be marked viewed', () => {
    const files = [
      file({ path: 'a.ts' }),
      file({ path: 'b.ts' }),
      file({ patch: null, patchDigest: null, path: 'logo.png' }),
    ];
    expect(viewedProgress(files, new Set(['a.ts', 'logo.png']))).toEqual({ done: 1, total: 2 });
  });

  it('reads no files as no progress', () => {
    expect(viewedProgress([], new Set())).toEqual({ done: 0, total: 0 });
  });
});

describe('findings', () => {
  it('places an anchored finding on its file and line, several to a line', () => {
    const byLine = findingsByLine(
      [
        finding({ description: 'one', line: 3 }),
        finding({ description: 'two', line: 3 }),
        finding({ description: 'other file', file: 'b.ts', line: 3 }),
        finding({ description: 'elsewhere', line: 9 }),
      ],
      'a.ts'
    );
    expect(byLine.get(3)?.map((f) => f.description)).toEqual(['one', 'two']);
    expect(byLine.get(9)?.map((f) => f.description)).toEqual(['elsewhere']);
    expect(byLine.size).toBe(2);
  });

  it('never places a finding the server did not anchor', () => {
    expect(findingsByLine([finding({ anchored: false })], 'a.ts').size).toBe(0);
  });

  it('never places a finding that names no line', () => {
    expect(findingsByLine([finding({ line: null })], 'a.ts').size).toBe(0);
  });

  it('lists the findings with nowhere to sit', () => {
    const rest = unanchoredFindings([
      finding({ description: 'placed' }),
      finding({ anchored: false, description: 'no hunk' }),
      finding({ description: 'no line', line: null }),
    ]);
    expect(rest.map((f) => f.description)).toEqual(['no hunk', 'no line']);
  });

  it('counts the findings per file, anchored or not', () => {
    const counts = findingCounts([
      finding(),
      finding({ anchored: false }),
      finding({ file: 'b.ts' }),
    ]);
    expect(counts.get('a.ts')).toBe(2);
    expect(counts.get('b.ts')).toBe(1);
  });
});

describe('applyViewed', () => {
  const mark = (...paths: string[]) => paths.map((path) => ({ patchDigest: 'd', path }));

  it('adds the files named, after the ones already viewed', () => {
    expect(applyViewed(['a.ts'], { files: mark('b.ts', 'c.ts'), viewed: true })).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
    ]);
  });

  it('does not list a file twice', () => {
    expect(applyViewed(['a.ts'], { files: mark('a.ts', 'a.ts', 'b.ts'), viewed: true })).toEqual([
      'a.ts',
      'b.ts',
    ]);
  });

  it('removes the files named and keeps the rest', () => {
    expect(applyViewed(['a.ts', 'b.ts'], { files: mark('a.ts', 'z.ts'), viewed: false })).toEqual([
      'b.ts',
    ]);
  });

  it('does not change the list it was given', () => {
    const before = ['a.ts'];
    applyViewed(before, { files: mark('b.ts'), viewed: true });
    applyViewed(before, { files: mark('a.ts'), viewed: false });
    expect(before).toEqual(['a.ts']);
  });
});

describe('restoreViewed', () => {
  it('puts a path that was not viewed back to not viewed', () => {
    expect(restoreViewed(['a.ts', 'b.ts'], ['b.ts'], new Set(['a.ts']))).toEqual(['a.ts']);
  });

  it('puts a path that was viewed back to viewed', () => {
    expect(restoreViewed(['a.ts'], ['b.ts'], new Set(['a.ts', 'b.ts']))).toEqual(['a.ts', 'b.ts']);
  });

  it('leaves every path it was not asked about as it is now, so a later change survives', () => {
    // x was marked and that change failed; y was marked afterwards and succeeded.
    expect(restoreViewed(['x.ts', 'y.ts'], ['x.ts'], new Set())).toEqual(['y.ts']);
  });

  it('does not list a path twice', () => {
    expect(restoreViewed(['a.ts'], ['a.ts'], new Set(['a.ts']))).toEqual(['a.ts']);
  });

  it('does not change the list it was given', () => {
    const current = ['a.ts', 'b.ts'];
    restoreViewed(current, ['a.ts'], new Set());
    expect(current).toEqual(['a.ts', 'b.ts']);
  });
});

describe('shortSha', () => {
  it('shortens to seven characters', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456');
    expect(shortSha('abc')).toBe('abc');
  });
});

describe('filesUnavailableMessage', () => {
  it.each(['host-not-approved', 'no-credential', 'not-found', 'rate-limited', 'failed'] as const)(
    'gives %s its own sentence',
    (reason) => {
      expect(filesUnavailableMessage(reason).length).toBeGreaterThan(20);
    }
  );

  it('says different things for different reasons', () => {
    expect(filesUnavailableMessage('rate-limited')).not.toBe(filesUnavailableMessage('failed'));
    expect(filesUnavailableMessage('not-found')).not.toBe(filesUnavailableMessage('no-credential'));
  });
});
