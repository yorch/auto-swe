import { describe, expect, it } from 'vitest';
import {
  BOT_APPROVED_BRIEF_SENTENCE,
  BRIEF_MARKER,
  buildBrief,
  readingOrder,
  skimProof,
  truncateBrief,
} from './brief.js';
import { classify } from './classify.js';
import { DEFAULT_THRESHOLDS, mergePolicy } from './policy.js';
import type {
  BriefEvidence,
  BriefFinding,
  BriefIntent,
  ChangedFile,
  EffectivePolicy,
  EvaluationSignals,
} from './types.js';

const { effective } = mergePolicy({ ...DEFAULT_THRESHOLDS, sensitivePaths: [] });
const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  additions: 1,
  deletions: 1,
  patch: '@@ -1 +1 @@\n+x',
  path,
  status: 'modified',
  ...over,
});
const brief = (files: ChangedFile[], policy: EffectivePolicy = effective) => {
  const signals: EvaluationSignals = {
    draft: false,
    files,
    maxReviewSeverity: 'PASS',
    policyFileChanged: false,
    scannerFindingCount: 0,
  };
  return buildBrief(files, classify(signals, policy), policy);
};
const exactRename = (over: Partial<ChangedFile> = {}): ChangedFile =>
  file('src/new.ts', {
    additions: 0,
    deletions: 0,
    previousPath: 'src/old.ts',
    similarity: 100,
    status: 'renamed',
    ...over,
  });

describe('skimProof', () => {
  it('proves only an exact rename with no content change', () => {
    expect(skimProof(exactRename(), [])).toBe('exact-rename');
    expect(skimProof(exactRename({ similarity: 99 }), [])).toBeNull();
    expect(skimProof(exactRename({ additions: 1 }), [])).toBeNull();
    expect(skimProof(exactRename({ deletions: 1 }), [])).toBeNull();
    expect(skimProof(exactRename({ similarity: undefined }), [])).toBeNull();
    expect(skimProof(exactRename({ status: 'modified' }), [])).toBeNull();
  });

  it('proves a whitespace-only patch', () => {
    // trailing whitespace and CRLF endings only; leading and interior whitespace are identical
    const patch = '@@ -1,2 +1,2 @@\n ctx\n-const a = 1;  \n+const a = 1;\n ctx2';
    expect(skimProof(file('a.ts', { patch }), [])).toBe('whitespace-only');
    const crlf = '@@ -1 +1 @@\n-  foo(1, 2)\n+  foo(1, 2)\r';
    expect(skimProof(file('a.ts', { patch: crlf }), [])).toBe('whitespace-only');
    const blank = '@@ -1,2 +1,1 @@\n-a\n-\n+a';
    expect(skimProof(file('a.ts', { additions: 1, deletions: 2, patch: blank }), [])).toBe(
      'whitespace-only'
    );
  });

  it('refuses anything that differs by more than whitespace', () => {
    const cases = [
      '@@ @@\n-const a = 1;\n+const a = 2;',
      '@@ @@\n-a\n+a\n+b',
      '@@ @@\n-a\n-b\n+b\n+a',
      '@@ @@\n-foo()\n+foo();',
      // a block moved across context is not whitespace-only
      '@@ @@\n-moved()\n ctx\n+moved()',
      // zero-width space is not whitespace
      '@@ @@\n-a\n+a\u200b',
    ];
    for (const patch of cases) {
      const added = (patch.match(/^\+/gm) ?? []).length;
      const removed = (patch.match(/^-/gm) ?? []).length;
      expect(
        skimProof(file('a.ts', { additions: added, deletions: removed, patch }), []),
        patch
      ).toBeNull();
    }
  });

  it('refuses when the patch is missing, truncated, or the file is not modified', () => {
    expect(skimProof(file('a.ts'), [])).toBeNull();
    expect(skimProof(file('a.ts', { additions: 0, deletions: 0, patch: '' }), [])).toBeNull();
    // counts disagree with the patch: it was truncated
    expect(
      skimProof(file('a.ts', { additions: 5, deletions: 5, patch: '@@ @@\n-a \n+a' }), [])
    ).toBeNull();
    expect(skimProof(file('a.ts', { patch: '@@ @@\n-a \n+a', status: 'added' }), [])).toBeNull();
  });

  it('never proves a file the repository ignores from skim', () => {
    expect(skimProof(exactRename(), ['src/**'])).toBeNull();
    expect(skimProof(exactRename(), ['src/old.ts'])).toBeNull();
  });
});

describe('buildBrief', () => {
  it('puts only proven files in skim and does not focus on them', () => {
    const result = brief([exactRename(), file('src/b.ts', { additions: 3 })]);
    expect(result.skim).toEqual([{ path: 'src/new.ts', proof: 'exact-rename' }]);
    expect(result.path.map((f) => f.path)).toEqual(['src/b.ts']);
  });

  it('never skims a sensitive rename', () => {
    const result = brief([
      exactRename({ path: 'db/migrations/2.sql', previousPath: 'db/migrations/1.sql' }),
    ]);
    expect(result.skim).toEqual([]);
    expect(result.path[0]?.path).toBe('db/migrations/2.sql');
    expect(result.path[0]?.flagged).toBe(true);
  });

  it('lists the first ten files, flags risk without moving the file, and folds the rest', () => {
    const files = [
      ...Array.from({ length: 14 }, (_, i) =>
        file(`src/f${String(i).padStart(2, '0')}.ts`, { additions: i + 1, deletions: 0 })
      ),
      file('db/migrations/1.sql', { additions: 1, deletions: 0 }),
    ];
    const result = brief(files);
    expect(result.path).toHaveLength(15);
    // the migration is a contract, so it is read first; risk is a marker, not a sort key
    expect(result.path[0]).toMatchObject({ flagged: true, path: 'db/migrations/1.sql' });
    expect(result.path[1]).toMatchObject({ flagged: false, path: 'src/f13.ts' });
    expect(result.path[9]?.path).toBe('src/f05.ts');
    expect(result.markdown).toContain('**Read in this order**');
    expect(result.markdown).toContain('- **1.** ` db/migrations/1.sql `');
    expect(result.markdown).toContain('<summary>5 more files, still in reading order</summary>');
    expect(result.markdown).toContain('- ` src/f00.ts `');
    expect(result.markdown.endsWith('</details>')).toBe(true);
  });

  it('keeps a flagged file visible at its real position when it is past the tenth', () => {
    const files = [
      ...Array.from({ length: 14 }, (_, i) =>
        file(`src/f${String(i).padStart(2, '0')}.ts`, { additions: 20, deletions: 0 })
      ),
      file('auth/login.ts', { additions: 1, deletions: 0 }),
    ];
    const result = brief(files);
    expect(result.path[14]).toMatchObject({ flagged: true, path: 'auth/login.ts' });
    expect(result.markdown).toContain('- **15.** ` auth/login.ts `');
    expect(result.markdown).toContain('**Check:** Read the change itself');
    expect(result.markdown).toContain('<summary>4 more files, still in reading order</summary>');
    expect(result.markdown).not.toContain('- ` auth/login.ts `');
  });

  it('starts the markdown with the marker and is deterministic', () => {
    const files = [file('src/a.ts', { additions: 9 }), file('src/b.ts')];
    const a = brief(files).markdown;
    expect(a.startsWith(BRIEF_MARKER)).toBe(true);
    expect(brief(files).markdown).toBe(a);
  });

  it('neutralises hostile file names', () => {
    const hostile = 'x`; </details><img src=x onerror=1> @octocat | a\n# H1 ``` .ts';
    const result = brief([file(hostile)]);
    const line = result.markdown.split('\n').find((l) => l.startsWith('- **1.**')) as string;
    expect(line).toBeDefined();
    // newline in the name is replaced, so the list item stays on one line
    expect(result.markdown).not.toContain('\n# H1');
    // the name sits in a code span whose fence is longer than any backtick run inside it
    expect(line).toMatch(/^- \*\*1\.\*\* ````+ x/);
    // the mention sits between the opening and closing fence
    expect(line.indexOf('@octocat')).toBeGreaterThan(line.indexOf('x`;'));
    expect(line.indexOf('@octocat')).toBeLessThan(line.lastIndexOf('````'));
  });

  it('escapes markup and mentions in prose', () => {
    const signals: EvaluationSignals = {
      draft: false,
      evaluationError: 'bad <script> @everyone `x` | y',
      files: [file('src/a.ts')],
      maxReviewSeverity: 'PASS',
      policyFileChanged: false,
      scannerFindingCount: 0,
    };
    const md = buildBrief(signals.files, classify(signals, effective), effective).markdown;
    expect(md).not.toContain('<script>');
    expect(md).not.toContain('@everyone');
    expect(md).toContain('&lt;script&gt;');
  });

  it('stays under 60 000 characters for a huge PR', () => {
    // Enough files that dropping any of the list caps would push the brief past the limit
    // (each folded line is about 170 characters, so about 360 files fill it; the flagged lines
    // are longer still), and no more: the caps hold at any size above that, while the work of
    // ordering the files grows with it. 3000 files took about two seconds under CI's coverage
    // run, close enough to the default five-second limit that a loaded runner failed it.
    const HUGE_PR_FILES = 700;
    const files = Array.from({ length: HUGE_PR_FILES }, (_, i) =>
      file(`src/${'d'.repeat(150)}/${i}.ts`, { additions: 5 })
    );
    // The cap belongs to the brief builder, so it is handed a classification in which every file
    // is a sensitive-path hit (the worst case for the brief's size) instead of classifying the
    // files against ~100 globs: that is the expensive part, and it made this test depend on
    // machine load under CI's coverage run without adding anything to what is asserted.
    const result = buildBrief(
      files,
      {
        autoEligible: false,
        reasons: [
          {
            code: 'sensitive-path',
            message: 'every file',
            paths: files.map((f) => f.path),
            severity: 'exclusion',
          },
        ],
        requiredApprovers: 2,
        riskClass: 'HIGH',
      },
      effective
    );
    expect(result.markdown.length).toBeLessThan(60_000);
    expect(result.path).toHaveLength(HUGE_PR_FILES);
    // the folded block is capped and still closes inside the limit
    expect(result.markdown).toContain('</details>');
    expect(result.markdown).not.toContain('(truncated)');
  });

  it('respects ignoredFromSkim in the brief', () => {
    const policy = { ...effective, ignoredFromSkim: ['src/**'] };
    const result = brief([exactRename()], policy);
    expect(result.skim).toEqual([]);
  });
});

describe('the ticket intent in the brief', () => {
  const withIntent = (intent: BriefIntent | undefined, files = [file('db/migrations/1.sql')]) => {
    const signals: EvaluationSignals = {
      draft: false,
      files,
      maxReviewSeverity: 'PASS',
      policyFileChanged: false,
      scannerFindingCount: 0,
    };
    return buildBrief(files, classify(signals, effective), effective, intent).markdown;
  };

  it('puts what was asked and the open questions between the class and the reading path', () => {
    const md = withIntent({
      criteria: ['GET /health returns 200'],
      openQuestions: ['which auth scheme applies?'],
    });
    const at = (text: string) => md.indexOf(text);
    expect(md).toContain('- GET /health returns 200');
    expect(md).toContain('- which auth scheme applies?');
    expect(at('**Why this class**')).toBeLessThan(at('**What was asked**'));
    expect(at('**What was asked**')).toBeLessThan(at('**Open questions in the ticket**'));
    expect(at('**Open questions in the ticket**')).toBeLessThan(at('**Read in this order**'));
    expect(md).toContain('not checked against the diff');
  });

  it("shows the run's own account next to the question it was about, and only that one", () => {
    const md = withIntent({
      criteria: [],
      handled: [
        { note: '', question: 'does it need auth?', resolution: 'left-unchanged' },
        { note: 'used the orders table', question: 'which table?', resolution: 'implemented' },
        {
          note: 'for no question here',
          question: 'a question nobody listed',
          resolution: 'implemented',
        },
      ],
      openQuestions: ['does it need auth?', 'which table?', 'what is the limit?'],
    });
    expect(md).toContain('- does it need auth? - the run says it **left this unchanged**');
    expect(md).toContain(
      '- which table? - the run says it **implemented** this: used the orders table'
    );
    expect(md).toContain('- what is the limit?\n');
    expect(md).not.toContain('for no question here');
    expect(md).toContain('its own account, not checked');
  });

  it('neutralises the run’s note like any model text', () => {
    const md = withIntent({
      criteria: [],
      handled: [
        {
          note: 'ping @everyone <script>alert(1)</script>\n# Heading',
          question: 'q?',
          resolution: 'implemented',
        },
      ],
      openQuestions: ['q?'],
    });
    expect(md).not.toContain('<script>');
    expect(md).not.toContain('@everyone');
    expect(md).not.toContain('\n# Heading');
  });

  it('adds nothing when there is no intent, or only empty entries', () => {
    const plain = withIntent(undefined);
    expect(withIntent({ criteria: [], openQuestions: [] })).toBe(plain);
    expect(withIntent({ criteria: ['  ', ''], openQuestions: ['\n'] })).toBe(plain);
    expect(plain).not.toContain('What was asked');
    expect(plain).not.toContain('Open questions');
  });

  it('shows at most 20 criteria and 10 questions and says how many were left out', () => {
    const md = withIntent({
      criteria: Array.from({ length: 25 }, (_, i) => `criterion ${i}`),
      openQuestions: Array.from({ length: 12 }, (_, i) => `question ${i}`),
    });
    expect(md).toContain('- criterion 19');
    expect(md).not.toContain('- criterion 20');
    expect(md).toContain('- question 9');
    expect(md).not.toContain('- question 10');
    expect(md.match(/- \+5 more/g)).toHaveLength(1);
    expect(md.match(/- \+2 more/g)).toHaveLength(1);
  });

  it('keeps an entry on one line and bounded', () => {
    const md = withIntent({
      criteria: [`first\n# Injected heading\n${'x'.repeat(5000)}`],
      openQuestions: [],
    });
    expect(md).not.toContain('\n# Injected heading');
    expect(md.length).toBeLessThan(5000);
  });

  it('neutralises markup, mentions, links and issue references in ticket text', () => {
    const md = withIntent({
      criteria: ['ping @everyone <img src=x onerror=1> `code` see #123 and https://evil.example/x'],
      openQuestions: ['is <script>alert(1)</script> ok? cc @octocat GH-9'],
    });
    expect(md).not.toContain('<img');
    expect(md).not.toContain('<script>');
    expect(md).not.toContain('@everyone');
    expect(md).not.toContain('@octocat');
    expect(md).not.toContain('see #123');
    expect(md).not.toContain('GH-9');
    expect(md).toContain('` https://evil.example/x `');
  });
});

describe('the run evidence in the brief', () => {
  const evidence = (over: Partial<BriefEvidence> = {}): BriefEvidence => ({
    ci: 'passed',
    runUrl: 'https://app.example.com/runs/abc',
    tests: { failing: 0, passing: 4, total: 4 },
    ui: null,
    ...over,
  });
  const render = (e: BriefEvidence | undefined) => {
    const files = [file('db/migrations/1.sql')];
    const signals: EvaluationSignals = {
      draft: false,
      files,
      maxReviewSeverity: 'PASS',
      policyFileChanged: false,
      scannerFindingCount: 0,
    };
    return buildBrief(files, classify(signals, effective), effective, undefined, e).markdown;
  };

  it('adds nothing without evidence', () => {
    expect(render(undefined)).not.toContain('**Evidence**');
  });

  it('writes fixed sentences between the intent and the reading path', () => {
    const md = render(evidence({ ui: { screenshots: 1, traces: 2, videos: 0 } }));
    expect(md).toContain('- Tests: 4 passing, 0 failing at this head.');
    expect(md).toContain('- Browser checks the run captured: 1 screenshot, 2 traces.');
    expect(md).toContain('- CI on this head: passed.');
    expect(md).toContain(
      "- [The run's page](https://app.example.com/runs/abc) has its full trace."
    );
    expect(md).toContain('- Not checked here: whether the tests cover what was asked.');
    expect(md.indexOf('**Evidence**')).toBeLessThan(md.indexOf('**Read in this order**'));
  });

  it('says what it does not know', () => {
    const md = render(evidence({ ci: null, runUrl: null, tests: null }));
    expect(md).toContain('- Tests: no result recorded for this head.');
    expect(md).toContain('- CI on this head: could not be read.');
    expect(md).not.toContain("The run's page");
    expect(render(evidence({ tests: { failing: 0, passing: 0, total: 0 } }))).toContain(
      '- Tests: none ran at this head.'
    );
  });

  it.each([
    ['pending', 'still running'],
    ['none', 'no checks reported'],
    ['failed', 'failed'],
  ] as const)('words a %s CI verdict as "%s"', (ci, text) => {
    expect(render(evidence({ ci }))).toContain(`- CI on this head: ${text}.`);
  });

  it('never writes a run address that could break out of a link', () => {
    for (const runUrl of [
      'https://x.example/a b',
      'https://x.example/a)(b',
      'javascript:alert(1)',
    ]) {
      expect(render(evidence({ runUrl }))).not.toContain("The run's page");
    }
  });

  it('keeps a hostile count a plain number', () => {
    const md = render(evidence({ tests: { failing: -3, passing: 2.9, total: 5 } }));
    expect(md).toContain('- Tests: 2 passing, 0 failing at this head.');
  });
});

describe('the review findings in the brief', () => {
  const finding = (over: Partial<BriefFinding> = {}): BriefFinding => ({
    category: 'logic',
    description: 'the guard is inverted',
    file: 'src/a.ts',
    line: 12,
    reviewer: 'DOMAIN_LOGIC',
    severity: 'CRITICAL',
    suggestedFix: 'flip the condition',
    ...over,
  });
  const render = (findings: BriefFinding[] | undefined) => {
    const files = [file('src/a.ts')];
    const signals: EvaluationSignals = {
      draft: false,
      files,
      maxReviewSeverity: 'PASS',
      policyFileChanged: false,
      scannerFindingCount: 0,
    };
    return buildBrief(
      files,
      classify(signals, effective),
      effective,
      undefined,
      undefined,
      findings
    ).markdown;
  };

  it('adds nothing without findings', () => {
    expect(render(undefined)).not.toContain('Review findings');
    expect(render([])).not.toContain('Review findings');
  });

  it('lists each finding on one line with its place, ahead of the reading path', () => {
    const md = render([finding(), finding({ line: null, severity: 'WARNING', suggestedFix: '' })]);
    expect(md).toContain(
      '- **CRITICAL** logic in ` src/a.ts:12 ` - the guard is inverted Suggested: flip the condition'
    );
    expect(md).toContain('- **WARNING** logic in ` src/a.ts ` - the guard is inverted\n');
    expect(md).toContain('not verified');
    expect(md.indexOf('**Review findings**')).toBeLessThan(md.indexOf('**Read in this order**'));
  });

  it('shows ten and counts the rest', () => {
    const md = render(Array.from({ length: 13 }, (_, i) => finding({ category: `cat${i}` })));
    expect(md).toContain('cat9');
    expect(md).not.toContain('cat10');
    expect(md).toContain('- +3 more not shown');
  });

  it('neutralises model text and keeps each finding on one line', () => {
    const md = render([
      finding({
        category: '<b>x</b>',
        description: 'ping @everyone see #123\n# Injected heading <script>alert(1)</script>',
        suggestedFix: '```suggestion\nrm -rf /\n```',
      }),
    ]);
    expect(md).not.toContain('<script>');
    expect(md).not.toContain('<b>');
    expect(md).not.toContain('@everyone');
    expect(md).not.toContain('\n# Injected heading');
    expect(md).not.toContain('\n```suggestion');
    expect(md).not.toContain('see #123');
  });
});

describe('readingOrder', () => {
  const order = (files: ChangedFile[]) => readingOrder(files).map((f) => f.path);

  it('reads contracts, then source with its tests, then loose tests, then the rest', () => {
    const files = [
      file('docs/guide.md'),
      file('test/zzz.test.ts'),
      file('src/app/b.test.ts'),
      file('src/app/b.ts', { additions: 2, deletions: 0 }),
      file('src/app/a.ts', { additions: 9, deletions: 1 }),
      file('package.json'),
      file('db/migrations/1.sql'),
    ];
    expect(order(files)).toEqual([
      'db/migrations/1.sql',
      'package.json',
      'src/app/a.ts',
      'src/app/b.ts',
      'src/app/b.test.ts',
      'test/zzz.test.ts',
      'docs/guide.md',
    ]);
  });

  it('puts a test straight after the source it covers, in the same or the parent directory', () => {
    const files = [
      file('src/foo.spec.ts'),
      file('src/__tests__/foo.test.ts'),
      file('src/foo.ts', { additions: 5, deletions: 0 }),
      file('src/bar.ts', { additions: 1, deletions: 0 }),
      file('src/test_baz.py'),
      file('src/baz.py', { additions: 3, deletions: 0 }),
      file('src/QuxTest.java'),
      file('src/Qux.java', { additions: 2, deletions: 0 }),
    ];
    expect(order(files)).toEqual([
      'src/foo.ts',
      'src/__tests__/foo.test.ts',
      'src/foo.spec.ts',
      'src/baz.py',
      'src/test_baz.py',
      'src/Qux.java',
      'src/QuxTest.java',
      'src/bar.ts',
    ]);
  });

  it('keeps a directory together, busiest directory first', () => {
    const files = [
      file('a/one.ts', { additions: 1, deletions: 0 }),
      file('b/one.ts', { additions: 8, deletions: 0 }),
      file('a/two.ts', { additions: 1, deletions: 0 }),
      file('b/two.ts', { additions: 8, deletions: 0 }),
    ];
    expect(order(files)).toEqual(['b/one.ts', 'b/two.ts', 'a/one.ts', 'a/two.ts']);
  });

  it('pairs a test in a mirrored test tree with the one source it can cover', () => {
    const files = [
      file('test/foo/bar.test.ts'),
      file('src/foo/bar.ts', { additions: 5, deletions: 0 }),
      file('src/foo/baz.ts', { additions: 2, deletions: 0 }),
      file('tests/solo.test.ts'),
      file('lib/solo.ts', { additions: 1, deletions: 0 }),
    ];
    expect(order(files)).toEqual([
      'src/foo/bar.ts',
      'test/foo/bar.test.ts',
      'src/foo/baz.ts',
      'lib/solo.ts',
      'tests/solo.test.ts',
    ]);
  });

  it('leaves a mirrored test loose when two sources could be its own', () => {
    const files = [
      file('test/x.test.ts'),
      file('a/x.ts', { additions: 2, deletions: 0 }),
      file('b/x.ts', { additions: 1, deletions: 0 }),
      file('test/foo/y.test.ts'),
      file('src/bar/y.ts', { additions: 1, deletions: 0 }),
    ];
    expect(order(files)).toEqual([
      'a/x.ts',
      'b/x.ts',
      'src/bar/y.ts',
      'test/foo/y.test.ts',
      'test/x.test.ts',
    ]);
  });

  it('does not pair a test with a source of another name or directory', () => {
    const files = [file('src/foo.ts'), file('src/other/foo.test.ts'), file('src/bar.test.ts')];
    expect(order(files)).toEqual(['src/foo.ts', 'src/bar.test.ts', 'src/other/foo.test.ts']);
  });

  it('gives the same order whatever order the host listed the files in', () => {
    const files = [
      file('src/a/x.ts', { additions: 3, deletions: 0 }),
      file('src/a/x.test.ts'),
      file('src/b/y.ts', { additions: 3, deletions: 0 }),
      file('yarn.lock'),
      file('README.md'),
      file('tests/loose.test.ts'),
    ];
    expect(order([...files].reverse())).toEqual(order(files));
  });
});

describe('brief hardening regressions', () => {
  const patchOf = (before: string, after: string): ChangedFile =>
    file('x', { patch: `@@ -1 +1 @@\n-${before}\n+${after}` });
  const proof = (path: string, before: string, after: string) =>
    skimProof({ ...patchOf(before, after), path }, []);

  it('does not prove changes in leading or interior whitespace (finding 1)', () => {
    expect(proof('a.ts', '        return 1', '    return 1')).toBeNull();
    expect(proof('a.ts', 'const s = "read only"', 'const s = "readonly"')).toBeNull();
    expect(proof('a.ts', 'return x', 'returnx')).toBeNull();
    expect(proof('a.ts', 'a  b', 'a b')).toBeNull();
  });

  it('never proves whitespace-only for whitespace-significant files (finding 1)', () => {
    for (const path of [
      'a.py',
      'a.pyi',
      'ci.yml',
      'ci.yaml',
      'r.mk',
      'Makefile',
      'makefile',
      'GNUmakefile',
      'a.sh',
      'a.bash',
      'a.zsh',
      'a.rb',
      'a.haml',
      'a.pug',
      'a.slim',
      'a.coffee',
      'a.nim',
      'a.fs',
      'a.fsx',
      'a.hs',
      'a.jade',
      'a.styl',
      'a.sass',
      'Dockerfile',
      'Dockerfile.prod',
      'api.Dockerfile',
      'LICENSE',
      'bin/run',
    ]) {
      expect(proof(path, 'x = 1  ', 'x = 1'), path).toBeNull();
    }
    expect(proof('a.ts', 'x = 1  ', 'x = 1')).toBe('whitespace-only');
  });

  it('proves an exact rename only inside one directory (finding 5)', () => {
    expect(
      skimProof(exactRename({ path: 'lib/b/n.ts', previousPath: 'lib/a/n.ts' }), [])
    ).toBeNull();
    expect(skimProof(exactRename(), [])).toBe('exact-rename');
  });

  it('never proves a rename that also changes mode or keeps its name (finding 17)', () => {
    expect(skimProof(exactRename({ previousPath: undefined }), [])).toBeNull();
    expect(skimProof(exactRename({ previousPath: 'src/new.ts' }), [])).toBeNull();
    expect(
      skimProof(
        file('src/new.ts', {
          additions: 0,
          deletions: 0,
          previousPath: 'src/old.ts',
          similarity: 100,
          status: 'modified',
        }),
        []
      )
    ).toBeNull();
  });

  const markdownOf = (path: string, message?: string): string => {
    const signals: EvaluationSignals = {
      draft: false,
      ...(message ? { evaluationError: message } : {}),
      files: [file(path)],
      maxReviewSeverity: 'PASS',
      policyFileChanged: false,
      scannerFindingCount: 0,
    };
    return buildBrief(signals.files, classify(signals, effective), effective).markdown;
  };

  it('strips bidi and invisible characters from paths and prose (finding 14)', () => {
    const bad =
      '\u2066\u2067\u2068\u2069\u202a\u202e\u200e\u200f\u061c\u0085\u009f\u2060\u2064\u00ad\ufeff\u180e';
    const md = markdownOf(`src/a${bad}.ts`, `failed${bad}now`);
    for (const ch of bad) {
      expect(md.includes(ch), `U+${ch.codePointAt(0)?.toString(16)}`).toBe(false);
    }
  });

  it('neutralises #123 autolinks and bare URLs (finding 15)', () => {
    const md = markdownOf('src/a.ts', 'see #123 and acme/repo#9 at https://evil.example/x?a=1 now');
    expect(md).toContain('\\#123');
    expect(md).toContain('repo\\#9');
    expect(md).toMatch(/`+ https:\/\/evil\.example\/x\?a=1 `+/);
    expect(md).not.toMatch(/(^|[^`\\])#123/);
  });

  it('truncates on a line boundary, never splitting pairs, entities or code spans (finding 16)', () => {
    const line = (n: number) => `- \u{1F600}&amp; \`code ${n}\` &lt;`;
    const text = [BRIEF_MARKER, ...Array.from({ length: 500 }, (_, i) => line(i))].join('\n');
    for (const max of [200, 201, 202, 203, 777]) {
      const out = truncateBrief(text, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out.endsWith('\n\n(truncated)')).toBe(true);
      expect(out.startsWith(BRIEF_MARKER)).toBe(true);
      const body = out.slice(0, -'\n\n(truncated)'.length);
      expect(body.endsWith('&lt;')).toBe(true);
      expect(Array.from(body).every((ch) => ch !== '\ufffd')).toBe(true);
      expect(body.split('`').length % 2).toBe(1);
      expect(/[\ud800-\udbff]$/.test(body)).toBe(false);
    }
    expect(truncateBrief('short')).toBe('short');
  });

  it('keeps a huge hostile error message bounded (finding 16)', () => {
    const md = markdownOf('src/a.ts', `${'&<'.repeat(60_000)}`);
    expect(md.length).toBeLessThan(60_000);
    expect(md).not.toMatch(/&(amp|lt|gt)?$/);
  });
});

describe('bot approval in the brief', () => {
  const classified = () => {
    const files = [file('src/a.ts')];
    const signals: EvaluationSignals = {
      draft: false,
      files,
      maxReviewSeverity: 'PASS',
      policyFileChanged: false,
      scannerFindingCount: 0,
    };
    return { classification: classify(signals, effective), files };
  };

  it.each(['bot-approval-posted', 'bot-approval-present'])(
    'says one fixed sentence when the reason %s is present',
    (code) => {
      const { classification, files } = classified();
      classification.reasons.push({ code, message: 'x', severity: 'info' });
      const { markdown } = buildBrief(files, classification, effective);
      expect(markdown).toContain(BOT_APPROVED_BRIEF_SENTENCE);
      expect(BOT_APPROVED_BRIEF_SENTENCE).toBe(
        'Approved by the evaluator; no human approval was required.'
      );
      expect(markdown.split(BOT_APPROVED_BRIEF_SENTENCE)).toHaveLength(2);
    }
  );

  it('says nothing about it for any other reason', () => {
    const { classification, files } = classified();
    classification.reasons.push({
      code: 'bot-approval-refused:risk-low',
      message: 'x',
      severity: 'info',
    });
    expect(buildBrief(files, classification, effective).markdown).not.toContain('evaluator');
  });
});
