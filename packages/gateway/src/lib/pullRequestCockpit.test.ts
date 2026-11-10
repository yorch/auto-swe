import { describe, expect, it } from 'vitest';
import type { PullFilesResult, ReviewFile } from './githubPullFiles.js';
import {
  assembleCockpit,
  draftIsCurrent,
  draftsFor,
  type EvaluationRow,
  MAX_TOTAL_PATCH_CHARS,
  viewedPaths,
} from './pullRequestCockpit.js';

const HEAD = 'abc123';
const PATCH = ['@@ -1,2 +1,3 @@', ' keep', '+added', ' tail'].join('\n');

const file = (over: Partial<ReviewFile> = {}): ReviewFile => ({
  additions: 1,
  deletions: 0,
  patch: PATCH,
  patchDigest: 'digest-of-patch',
  path: 'src/a.ts',
  status: 'modified',
  ...over,
});

const ok = (files: ReviewFile[], over: Partial<{ headSha: string }> = {}): PullFilesResult => ({
  files,
  headSha: over.headSha ?? HEAD,
  state: 'open',
  truncated: false,
  type: 'ok',
});

const finding = (over: Record<string, unknown> = {}) => ({
  category: 'logic',
  description: 'off by one',
  file: 'src/a.ts',
  line: 2,
  reviewer: 'DOMAIN_LOGIC',
  severity: 'WARNING',
  suggestedFix: 'use <=',
  ...over,
});

function evaluation(over: Partial<EvaluationRow> = {}, brief: unknown = {}): EvaluationRow {
  return {
    brief,
    createdAt: new Date('2026-11-03T10:00:00.000Z'),
    headSha: HEAD,
    id: 'eval-1',
    mode: 'advisory',
    reasons: [
      { code: 'sensitive-path', message: 'touches auth', paths: ['src/a.ts'], severity: 'raise' },
    ],
    requiredApprovers: 1,
    riskClass: 'STANDARD',
    statusState: 'pending',
    ...over,
  };
}

const run = (e: EvaluationRow | null, files: PullFilesResult, stored = HEAD) =>
  assembleCockpit({ evaluation: e, files, storedHeadSha: stored });

describe('assembleCockpit', () => {
  it('shows the files with no evaluation when none exists', () => {
    const { evaluation: ev, files } = run(null, ok([file()]));
    expect(ev).toBeNull();
    expect(files).toMatchObject({ headSha: HEAD, state: 'open', truncated: false, type: 'ok' });
    if (files.type !== 'ok') {
      throw new Error('unreachable');
    }
    expect(files.items[0]).toMatchObject({
      flagged: false,
      patchDigest: 'digest-of-patch',
      path: 'src/a.ts',
      previousPath: null,
      skim: null,
      verify: null,
      why: null,
    });
  });

  it('orders the files for reading, not as the host listed them', () => {
    const { files } = run(
      null,
      ok([
        file({ path: 'README.md' }),
        file({ path: 'src/a.test.ts' }),
        file({ path: 'src/a.ts' }),
        file({ path: 'package.json' }),
      ])
    );
    if (files.type !== 'ok') {
      throw new Error('unreachable');
    }
    const order = files.items.map((f) => f.path);
    expect(order.indexOf('package.json')).toBeLessThan(order.indexOf('src/a.ts'));
    expect(order.indexOf('src/a.ts') + 1).toBe(order.indexOf('src/a.test.ts'));
    expect(order.at(-1)).toBe('README.md');
  });

  it('carries the evaluation marks onto the matching files', () => {
    const { files } = run(
      evaluation(
        {},
        {
          path: [{ flagged: true, path: 'src/a.ts', verify: 'check the guard', why: 'auth path' }],
          skim: [{ path: 'src/moved.ts', proof: 'exact-rename' }],
        }
      ),
      ok([file(), file({ path: 'src/moved.ts', previousPath: 'src/old.ts', status: 'renamed' })])
    );
    if (files.type !== 'ok') {
      throw new Error('unreachable');
    }
    const byPath = new Map(files.items.map((f) => [f.path, f]));
    expect(byPath.get('src/a.ts')).toMatchObject({
      flagged: true,
      verify: 'check the guard',
      why: 'auth path',
    });
    expect(byPath.get('src/moved.ts')).toMatchObject({
      previousPath: 'src/old.ts',
      skim: 'exact-rename',
    });
  });

  describe('the cap on patch text', () => {
    const big = (name: string, chars: number) =>
      file({ patch: 'x'.repeat(chars), patchDigest: `d-${name}`, path: `src/${name}.ts` });

    it('keeps every patch while they fit', () => {
      const { files } = run(null, ok([big('a', 1_000), big('b', 1_000)]));
      if (files.type !== 'ok') {
        throw new Error('unreachable');
      }
      expect(files.items.every((f) => f.patch !== null && f.patchDigest !== null)).toBe(true);
    });

    it('names a file past the cap but gives it no patch and no digest', () => {
      const chunk = MAX_TOTAL_PATCH_CHARS / 3;
      const { files } = run(
        null,
        ok([big('a', chunk), big('b', chunk), big('c', chunk), big('d', 1_000)])
      );
      if (files.type !== 'ok') {
        throw new Error('unreachable');
      }
      expect(files.items).toHaveLength(4);
      const without = files.items.filter((f) => f.patch === null);
      expect(without).toHaveLength(1);
      expect(without[0]?.patchDigest).toBeNull();
      const total = files.items.reduce((sum, f) => sum + (f.patch?.length ?? 0), 0);
      expect(total).toBeLessThanOrEqual(MAX_TOTAL_PATCH_CHARS);
    });

    it('never lists a file without a patch as viewed, and never anchors a finding on one', () => {
      const chunk = MAX_TOTAL_PATCH_CHARS / 2;
      const result = run(
        evaluation({}, { findings: [finding({ file: 'src/b.ts', line: 1 })] }),
        ok([big('a', chunk), big('b', chunk + 1)])
      );
      if (result.files.type !== 'ok') {
        throw new Error('unreachable');
      }
      const omitted = result.files.items.find((f) => f.patch === null);
      expect(omitted?.path).toBe('src/b.ts');
      expect(viewedPaths(result.files, [{ patchDigest: 'd-b', path: 'src/b.ts' }])).toEqual([]);
      expect(result.evaluation?.findings[0]?.anchored).toBe(false);
    });
  });

  it('gives a file with no patch a null patch and digest', () => {
    const { files } = run(
      null,
      ok([{ additions: 0, deletions: 0, path: 'logo.png', status: 'modified' }])
    );
    if (files.type !== 'ok') {
      throw new Error('unreachable');
    }
    expect(files.items[0]).toMatchObject({ patch: null, patchDigest: null });
  });

  describe('the head', () => {
    it('is not stale when the evaluation covers the head the host reports, whatever the case', () => {
      const { evaluation: ev } = run(evaluation({ headSha: 'ABC123' }), ok([file()]));
      expect(ev?.stale).toBe(false);
    });

    it('is stale when the host reports a newer head', () => {
      const { evaluation: ev } = run(evaluation(), ok([file()], { headSha: 'def456' }));
      expect(ev?.stale).toBe(true);
    });

    it('compares with the stored head while the host cannot be read', () => {
      const unavailable: PullFilesResult = { reason: 'rate-limited', type: 'unavailable' };
      expect(run(evaluation(), unavailable, 'def456').evaluation?.stale).toBe(true);
      expect(run(evaluation(), unavailable, HEAD).evaluation?.stale).toBe(false);
    });
  });

  describe('the findings', () => {
    const withFindings = (findings: unknown[]) => evaluation({}, { findings });

    it('anchors a finding whose line is in the patch at the head the page shows', () => {
      const { evaluation: ev } = run(
        withFindings([finding({ line: 2 }), finding({ description: 'gone', line: 99 })]),
        ok([file()])
      );
      expect(ev?.findings.map((f) => [f.description, f.anchored])).toEqual([
        ['off by one', true],
        ['gone', false],
      ]);
    });

    it('anchors nothing when the finding names no line', () => {
      const { evaluation: ev } = run(withFindings([finding({ line: null })]), ok([file()]));
      expect(ev?.findings[0]?.anchored).toBe(false);
    });

    it('anchors nothing when the review covers an earlier commit', () => {
      const { evaluation: ev } = run(
        withFindings([finding()]),
        ok([file()], { headSha: 'def456' })
      );
      expect(ev?.stale).toBe(true);
      expect(ev?.findings[0]?.anchored).toBe(false);
    });

    it('anchors nothing when the files could not be read, but still lists the findings', () => {
      const { evaluation: ev } = run(withFindings([finding()]), {
        reason: 'failed',
        type: 'unavailable',
      });
      expect(ev?.findings).toHaveLength(1);
      expect(ev?.findings[0]?.anchored).toBe(false);
    });

    it('anchors nothing when the file has no patch', () => {
      const { evaluation: ev } = run(
        withFindings([finding()]),
        ok([file({ patch: undefined, patchDigest: undefined })])
      );
      expect(ev?.findings[0]?.anchored).toBe(false);
    });
  });

  describe('a stored brief that is old or damaged', () => {
    it('reads an evaluation from before the structure was stored as having none of it', () => {
      const { evaluation: ev } = run(
        evaluation({}, { claimsToVerify: ['a claim'], markdown: 'text', path: [], skim: [] }),
        ok([file()])
      );
      expect(ev).toMatchObject({
        claimsToVerify: ['a claim'],
        evidence: null,
        findings: [],
        intent: null,
      });
    });

    it.each([null, 'text', 42, [], undefined])('reads a brief of %j as empty', (brief) => {
      const { evaluation: ev } = run(evaluation({}, brief), ok([file()]));
      expect(ev).toMatchObject({ claimsToVerify: [], evidence: null, findings: [], intent: null });
    });

    it('drops the entries that do not parse and keeps the ones that do', () => {
      const { evaluation: ev } = run(
        evaluation(
          {},
          {
            claimsToVerify: ['ok', 7, null],
            findings: [finding(), { description: 'no file' }, finding({ severity: 'LOW' })],
          }
        ),
        ok([file()])
      );
      expect(ev?.claimsToVerify).toEqual(['ok']);
      expect(ev?.findings).toHaveLength(1);
    });

    it('leaves out an intent or evidence that is not the expected shape', () => {
      const { evaluation: ev } = run(
        evaluation({}, { evidence: { ci: 'maybe' }, intent: { criteria: 'one' } }),
        ok([file()])
      );
      expect(ev?.intent).toBeNull();
      expect(ev?.evidence).toBeNull();
    });

    it('reads the settled questions of a stored intent, and none when absent', () => {
      const stored = (intent: unknown) =>
        run(evaluation({}, { intent }), ok([file()])).evaluation?.intent;
      expect(stored({ criteria: ['a'], openQuestions: ['q'] })).toEqual({
        criteria: ['a'],
        handled: [],
        openQuestions: ['q'],
      });
      expect(
        stored({
          criteria: [],
          handled: [{ note: 'n', question: 'q', resolution: 'implemented' }],
          openQuestions: ['q'],
        })?.handled
      ).toHaveLength(1);
    });
  });

  it('reads a risk class it does not know as HIGH', () => {
    expect(run(evaluation({ riskClass: 'LOW-ISH' }), ok([file()])).evaluation?.riskClass).toBe(
      'HIGH'
    );
    expect(run(evaluation({ riskClass: 'LOW' }), ok([file()])).evaluation?.riskClass).toBe('LOW');
  });

  it('passes the reasons through with their paths defaulted', () => {
    const { evaluation: ev } = run(
      evaluation({
        reasons: [
          { code: 'a', message: 'm', severity: 'info' },
          { nonsense: true },
          { code: 'b', message: 'm2', paths: ['x'], severity: 'raise' },
        ],
      }),
      ok([file()])
    );
    expect(ev?.reasons).toEqual([
      { code: 'a', message: 'm', paths: [], severity: 'info' },
      { code: 'b', message: 'm2', paths: ['x'], severity: 'raise' },
    ]);
  });

  it('reports why the files are missing and still returns the evaluation', () => {
    const { evaluation: ev, files } = run(evaluation(), {
      reason: 'host-not-approved',
      type: 'unavailable',
    });
    expect(files).toEqual({ reason: 'host-not-approved', type: 'unavailable' });
    expect(ev?.id).toBe('eval-1');
    expect(ev?.createdAt).toBe('2026-11-03T10:00:00.000Z');
  });
});

describe('viewedPaths', () => {
  const files = (...items: { path: string; digest: string | null }[]) =>
    run(
      null,
      ok(
        items.map((i) =>
          i.digest === null
            ? file({ patch: undefined, patchDigest: undefined, path: i.path })
            : file({ patchDigest: i.digest, path: i.path })
        )
      )
    ).files;

  it('counts a mark only while the patch is the one that was viewed', () => {
    const shown = files({ digest: 'new', path: 'src/a.ts' }, { digest: 'same', path: 'src/b.ts' });
    expect(
      viewedPaths(shown, [
        { patchDigest: 'old', path: 'src/a.ts' },
        { patchDigest: 'same', path: 'src/b.ts' },
      ])
    ).toEqual(['src/b.ts']);
  });

  it('ignores a mark for a file the page does not show', () => {
    expect(
      viewedPaths(files({ digest: 'd', path: 'src/a.ts' }), [{ patchDigest: 'd', path: 'gone.ts' }])
    ).toEqual([]);
  });

  it('never counts a file that has no patch to match', () => {
    expect(
      viewedPaths(files({ digest: null, path: 'logo.png' }), [
        { patchDigest: '', path: 'logo.png' },
      ])
    ).toEqual([]);
  });

  it('counts nothing while the files could not be read', () => {
    expect(
      viewedPaths({ reason: 'failed', type: 'unavailable' }, [{ patchDigest: 'd', path: 'a' }])
    ).toEqual([]);
  });
});

describe('draft anchors', () => {
  const PATCH_TWO = [
    '@@ -1,3 +1,3 @@',
    ' keep',
    '-gone',
    '+added',
    ' tail',
    '@@ -20,2 +20,2 @@',
    ' x',
    ' y',
  ].join('\n');
  const files = new Map([['a.ts', { patch: PATCH_TWO, patchDigest: 'd' }]]);
  const row = (over: Partial<Parameters<typeof draftIsCurrent>[0]> = {}) => ({
    line: 2,
    patchDigest: 'd',
    path: 'a.ts',
    side: 'RIGHT',
    startLine: null,
    ...over,
  });

  it('is current on a deleted line only on the old side', () => {
    expect(draftIsCurrent(row({ side: 'LEFT' }), files)).toBe(true);
    expect(draftIsCurrent(row({ line: 3, side: 'LEFT' }), files)).toBe(true);
    expect(draftIsCurrent(row({ line: 4, side: 'LEFT' }), files)).toBe(false);
  });

  it('is current for a range inside a hunk and outdated across hunks', () => {
    expect(draftIsCurrent(row({ line: 3, startLine: 1 }), files)).toBe(true);
    expect(draftIsCurrent(row({ line: 20, startLine: 1 }), files)).toBe(false);
  });

  it('carries side and startLine to the page, with outdated set from the anchor', () => {
    const out = draftsFor(ok([file({ patch: PATCH_TWO, patchDigest: 'd', path: 'a.ts' })]), [
      {
        body: 'b',
        createdAt: new Date('2026-11-04T10:00:00.000Z'),
        headSha: HEAD,
        id: 'd1',
        ...row({ line: 20, startLine: 1 }),
      },
    ]);
    expect(out[0]).toMatchObject({ outdated: true, side: 'RIGHT', startLine: 1 });
  });
});
