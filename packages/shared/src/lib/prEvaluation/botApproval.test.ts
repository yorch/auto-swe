import { describe, expect, it } from 'vitest';
import {
  BOT_APPROVAL_CONDITIONS,
  type BotApprovalCondition,
  type BotApprovalInput,
  botApprovalRefusalConditions,
  botApprovalRefusals,
  changedPathsAllowed,
  hasNetTestDeletion,
} from './botApproval.js';
import { DEFAULT_BOT_APPROVAL_PATHS, DEFAULT_SENSITIVE_PATHS, matchesAny } from './paths.js';
import type { ChangedFile } from './types.js';

const CONTEXT = 'auto-swe/risk';

const good = (): BotApprovalInput => ({
  approverAppConfigured: true,
  approverClientOk: true,
  autoEligible: true,
  autoMergeAllowed: true,
  botApprovalAllowed: true,
  botLogin: 'approver-app[bot]',
  changedFiles: 3,
  changedLines: 50,
  context: CONTEXT,
  draft: false,
  effectiveMode: 'auto',
  evidenceSatisfied: true,
  exclusionCount: 0,
  headSha: 'abc123',
  humanObjection: false,
  launcherResolved: true,
  maxFiles: 3,
  maxLines: 50,
  noNetTestDeletion: true,
  notSuppressed: true,
  pathsAllowed: true,
  prAuthorLogin: 'platform-app[bot]',
  readiness: {
    allowsAutoMerge: true,
    dismissStaleReviews: true,
    requiredStatusContexts: [CONTEXT, 'ci'],
    requiredStatusPinnedToApp: true,
  },
  repoBotApproval: true,
  requiredApprovers: 1,
  riskClass: 'LOW',
});

/** The one input change that should break exactly one condition. */
const BREAKERS: Record<BotApprovalCondition, (i: BotApprovalInput) => BotApprovalInput> = {
  'allows-auto-merge': (i) => ({
    ...i,
    readiness: { ...i.readiness, allowsAutoMerge: false },
  }),
  'approver-app-configured': (i) => ({ ...i, approverAppConfigured: false }),
  'approver-client-ok': (i) => ({ ...i, approverClientOk: false }),
  'author-differs': (i) => ({ ...i, prAuthorLogin: i.botLogin }),
  'auto-eligible': (i) => ({ ...i, autoEligible: false }),
  'auto-merge-allowed': (i) => ({ ...i, autoMergeAllowed: false }),
  'bot-approval-allowed': (i) => ({ ...i, botApprovalAllowed: false }),
  'bot-max-files': (i) => ({ ...i, changedFiles: 4 }),
  'bot-max-lines': (i) => ({ ...i, changedLines: 51 }),
  'bot-paths-allowed': (i) => ({ ...i, pathsAllowed: false }),
  'dismiss-stale-reviews': (i) => ({
    ...i,
    readiness: { ...i.readiness, dismissStaleReviews: false },
  }),
  'effective-mode-auto': (i) => ({ ...i, effectiveMode: 'enforce' }),
  'evidence-satisfied': (i) => ({ ...i, evidenceSatisfied: false }),
  'head-sha': (i) => ({ ...i, headSha: '' }),
  'launcher-resolved': (i) => ({ ...i, launcherResolved: false }),
  'no-exclusions': (i) => ({ ...i, exclusionCount: 1 }),
  'no-human-objection': (i) => ({ ...i, humanObjection: true }),
  'no-net-test-deletion': (i) => ({ ...i, noNetTestDeletion: false }),
  'no-stricter-approver-count': (i) => ({ ...i, requiredApprovers: 2 }),
  'not-draft': (i) => ({ ...i, draft: true }),
  'not-suppressed': (i) => ({ ...i, notSuppressed: false }),
  'repo-bot-approval': (i) => ({ ...i, repoBotApproval: false }),
  'risk-low': (i) => ({ ...i, riskClass: 'STANDARD' }),
  'status-pinned': (i) => ({
    ...i,
    readiness: { ...i.readiness, requiredStatusPinnedToApp: false },
  }),
  'status-required': (i) => ({
    ...i,
    readiness: { ...i.readiness, requiredStatusContexts: ['ci'] },
  }),
};

describe('botApprovalRefusals', () => {
  it('allows a head that meets every condition', () => {
    expect(botApprovalRefusals(good())).toEqual([]);
  });

  it('has a breaker for every listed condition and no duplicates', () => {
    expect(new Set(BOT_APPROVAL_CONDITIONS).size).toBe(BOT_APPROVAL_CONDITIONS.length);
    expect(Object.keys(BREAKERS).sort()).toEqual([...BOT_APPROVAL_CONDITIONS].sort());
  });

  it.each(BOT_APPROVAL_CONDITIONS)('refuses on %s alone, and on nothing else', (condition) => {
    const refusals = botApprovalRefusals(BREAKERS[condition](good()));
    expect(refusals).toHaveLength(1);
    // Every other condition, flipped on its own, gives a different single refusal.
    for (const other of BOT_APPROVAL_CONDITIONS) {
      if (other !== condition) {
        expect(botApprovalRefusals(BREAKERS[other](good()))).not.toEqual(refusals);
      }
    }
  });

  it('reports every unmet condition at once', () => {
    let input = good();
    for (const c of BOT_APPROVAL_CONDITIONS) {
      input = BREAKERS[c](input);
    }
    expect(botApprovalRefusals(input)).toHaveLength(BOT_APPROVAL_CONDITIONS.length);
  });

  it('fails closed on missing or unknown inputs', () => {
    const unknown = 'unknown' as unknown as boolean;
    const blank = {
      approverAppConfigured: undefined,
      approverClientOk: undefined,
      autoEligible: undefined,
      autoMergeAllowed: undefined,
      botApprovalAllowed: unknown,
      botLogin: undefined,
      changedFiles: undefined,
      changedLines: undefined,
      context: CONTEXT,
      draft: undefined,
      effectiveMode: undefined,
      evidenceSatisfied: undefined,
      exclusionCount: undefined,
      headSha: undefined,
      humanObjection: undefined,
      launcherResolved: undefined,
      maxFiles: undefined,
      maxLines: undefined,
      noNetTestDeletion: undefined,
      notSuppressed: undefined,
      pathsAllowed: undefined,
      prAuthorLogin: undefined,
      readiness: undefined,
      repoBotApproval: undefined,
      riskClass: undefined,
    } as unknown as BotApprovalInput;
    expect(botApprovalRefusals(blank)).toHaveLength(BOT_APPROVAL_CONDITIONS.length);
    expect(botApprovalRefusals({ ...good(), readiness: null })).toHaveLength(4);
    expect(botApprovalRefusals({ ...good(), draft: 'false' as unknown as boolean })).toHaveLength(
      1
    );
    expect(botApprovalRefusals({ ...good(), exclusionCount: Number.NaN })).toHaveLength(1);
    expect(
      botApprovalRefusals({
        ...good(),
        readiness: { ...good().readiness, requiredStatusContexts: 'unknown' },
      })
    ).toHaveLength(1);
    expect(
      botApprovalRefusals({
        ...good(),
        readiness: { ...good().readiness, requiredStatusPinnedToApp: 'unknown' },
      })
    ).toHaveLength(1);
  });

  it('has 25 conditions, and refuses anything but a strict true for dismissed stale reviews', () => {
    expect(BOT_APPROVAL_CONDITIONS).toHaveLength(25);
    for (const value of ['unknown', undefined, false, 'true']) {
      expect(
        botApprovalRefusalConditions({
          ...good(),
          readiness: { ...good().readiness, dismissStaleReviews: value as never },
        })
      ).toEqual(['dismiss-stale-reviews']);
    }
  });

  it('treats the login comparison as case-insensitive and refuses a blank author or bot', () => {
    expect(botApprovalRefusals({ ...good(), prAuthorLogin: 'APPROVER-APP[BOT]' })).toHaveLength(1);
    expect(botApprovalRefusals({ ...good(), prAuthorLogin: null })).toHaveLength(1);
    expect(botApprovalRefusals({ ...good(), prAuthorLogin: '  ' })).toHaveLength(1);
    expect(botApprovalRefusals({ ...good(), botLogin: '' })).toHaveLength(1);
  });

  it('refuses a blank status context and a whitespace head sha', () => {
    expect(botApprovalRefusals({ ...good(), context: '' })).toHaveLength(1);
    expect(botApprovalRefusals({ ...good(), headSha: '  ' })).toHaveLength(1);
  });

  it('never puts logins, ids or the context in a refusal', () => {
    const input = {
      ...good(),
      botLogin: 'zz-secret-bot',
      headSha: '',
      prAuthorLogin: 'ZZ-SECRET-BOT',
    };
    for (const c of BOT_APPROVAL_CONDITIONS) {
      for (const text of botApprovalRefusals(BREAKERS[c](input))) {
        expect(text.toLowerCase()).not.toContain('zz-secret-bot');
        expect(text).not.toContain(CONTEXT);
        expect(text.length).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('the new conditions fail closed', () => {
  it('refuses anything but a strict false for a human objection and a strict true for the rest', () => {
    for (const value of [undefined, null, 'false', 0, true]) {
      expect(botApprovalRefusalConditions({ ...good(), humanObjection: value as never })).toEqual([
        'no-human-objection',
      ]);
    }
    for (const value of [undefined, null, 'true', 1, false]) {
      expect(botApprovalRefusalConditions({ ...good(), notSuppressed: value as never })).toEqual([
        'not-suppressed',
      ]);
      expect(
        botApprovalRefusalConditions({ ...good(), noNetTestDeletion: value as never })
      ).toEqual(['no-net-test-deletion']);
    }
  });

  it('applies the caps inclusively and refuses a missing, non-finite or non-positive number', () => {
    expect(botApprovalRefusalConditions({ ...good(), changedLines: 50, maxLines: 50 })).toEqual([]);
    expect(botApprovalRefusalConditions({ ...good(), changedFiles: 3, maxFiles: 3 })).toEqual([]);
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, '5' as never, -1]) {
      expect(botApprovalRefusalConditions({ ...good(), changedLines: bad })).toEqual([
        'bot-max-lines',
      ]);
      expect(botApprovalRefusalConditions({ ...good(), changedFiles: bad })).toEqual([
        'bot-max-files',
      ]);
    }
    for (const bad of [undefined, Number.NaN, 0, Number.POSITIVE_INFINITY, '50' as never]) {
      expect(botApprovalRefusalConditions({ ...good(), maxLines: bad })).toEqual(['bot-max-lines']);
      expect(botApprovalRefusalConditions({ ...good(), maxFiles: bad })).toEqual(['bot-max-files']);
    }
  });
});

describe('hasNetTestDeletion', () => {
  const file = (over: Partial<ChangedFile>): ChangedFile => ({
    additions: 0,
    deletions: 0,
    path: 'src/a.ts',
    status: 'modified',
    ...over,
  });
  it('is false for no files, non-test files and tests that grow or break even', () => {
    expect(hasNetTestDeletion([])).toBe(false);
    expect(hasNetTestDeletion([file({ deletions: 90 })])).toBe(false);
    expect(hasNetTestDeletion([file({ additions: 3, deletions: 3, path: 'src/a.test.ts' })])).toBe(
      false
    );
    expect(hasNetTestDeletion([file({ additions: 9, deletions: 2, path: 'src/a.test.ts' })])).toBe(
      false
    );
  });
  it('is true when a test file loses more lines than it gains, even if others gain', () => {
    expect(
      hasNetTestDeletion([
        file({ additions: 100, path: 'src/b.test.ts' }),
        file({ additions: 1, deletions: 2, path: 'src/a.test.ts' }),
      ])
    ).toBe(true);
  });
  it('is true when a test file is removed, or renamed out of the test globs', () => {
    expect(hasNetTestDeletion([file({ path: 'src/a.test.ts', status: 'removed' })])).toBe(true);
    expect(
      hasNetTestDeletion([
        file({ path: 'src/a.ts', previousPath: 'src/a.test.ts', status: 'renamed' }),
      ])
    ).toBe(true);
    expect(
      hasNetTestDeletion([
        file({ path: 'src/b.test.ts', previousPath: 'src/a.test.ts', status: 'renamed' }),
      ])
    ).toBe(false);
  });
  it('treats a non-finite count on a test file as a deletion', () => {
    expect(hasNetTestDeletion([file({ additions: Number.NaN, path: 'src/a.test.ts' })])).toBe(true);
  });
});

describe('no-stricter-approver-count', () => {
  it('holds only for exactly one required approver', () => {
    expect(botApprovalRefusalConditions({ ...good(), requiredApprovers: 1 })).toEqual([]);
    for (const bad of [2, 3, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, '1']) {
      expect(
        botApprovalRefusalConditions({ ...good(), requiredApprovers: bad as unknown as number })
      ).toEqual(['no-stricter-approver-count']);
    }
  });
});

describe('botApprovalRefusalConditions', () => {
  it('names the single failing condition by its fixed code', () => {
    for (const c of BOT_APPROVAL_CONDITIONS) {
      expect(botApprovalRefusalConditions(BREAKERS[c](good()))).toEqual([c]);
    }
    expect(botApprovalRefusalConditions(good())).toEqual([]);
  });
});

describe('changedPathsAllowed', () => {
  const file = (path: string, previousPath?: string): ChangedFile =>
    ({
      additions: 1,
      deletions: 0,
      patch: '',
      path,
      status: previousPath ? 'renamed' : 'modified',
      ...(previousPath ? { previousPath } : {}),
    }) as ChangedFile;
  const allow = ['**/*.md', 'docs/**', '**/*.test.*'];

  it('allows a change whose every path matches the allowlist', () => {
    expect(
      changedPathsAllowed(
        [file('README.md'), file('docs/a/b.txt'), file('src/x.test.ts')],
        allow,
        false
      )
    ).toBe(true);
  });

  it('refuses when one path is not on the list', () => {
    expect(changedPathsAllowed([file('README.md'), file('src/x.ts')], allow, false)).toBe(false);
  });

  it('checks both paths of a rename, in either direction', () => {
    expect(changedPathsAllowed([file('docs/a.md', 'src/a.ts')], allow, false)).toBe(false);
    expect(changedPathsAllowed([file('src/a.ts', 'docs/a.md')], allow, false)).toBe(false);
    expect(changedPathsAllowed([file('docs/b.md', 'docs/a.md')], allow, false)).toBe(true);
  });

  it('refuses an empty allowlist, no files and a truncated list', () => {
    expect(changedPathsAllowed([file('README.md')], [], false)).toBe(false);
    expect(changedPathsAllowed([], allow, false)).toBe(false);
    expect(changedPathsAllowed([file('README.md')], allow, true)).toBe(false);
  });

  it('refuses a malformed allowlist or file rather than guessing', () => {
    for (const bad of [undefined, null, 'docs/**', ['{unclosed'], ['ok/**', 5], ['']]) {
      expect(changedPathsAllowed([file('docs/a.md')], bad, false), String(bad)).toBe(false);
    }
    expect(changedPathsAllowed([file('docs/a.md')], Array(51).fill('docs/**'), false)).toBe(false);
    expect(changedPathsAllowed([file('')], allow, false)).toBe(false);
    expect(changedPathsAllowed([{ ...file('docs/a.md'), previousPath: '' }], allow, false)).toBe(
      false
    );
    expect(changedPathsAllowed([{ path: 7 } as unknown as ChangedFile], allow, false)).toBe(false);
  });

  it('matches case-insensitively and anchored, like the sensitive-path logic', () => {
    expect(changedPathsAllowed([file('DOCS/A.MD')], allow, false)).toBe(true);
    expect(changedPathsAllowed([file('src/docs/a.ts')], allow, false)).toBe(false);
  });
});

describe('DEFAULT_BOT_APPROVAL_PATHS', () => {
  it('lists documentation and tests', () => {
    expect(DEFAULT_BOT_APPROVAL_PATHS).toEqual([
      '**/*.md',
      '**/*.mdx',
      'docs/**',
      '**/*.test.*',
      '**/*.spec.*',
      '**/__tests__/**',
      '**/test/**',
      '**/tests/**',
    ]);
  });

  it('overlaps the sensitive list, which is why sensitivity is checked first', () => {
    for (const path of ['docs/migrations/x.sql', 'AGENTS.md', 'docs/auth/a.md']) {
      expect(matchesAny(path, DEFAULT_BOT_APPROVAL_PATHS), path).toBe(true);
      expect(matchesAny(path, DEFAULT_SENSITIVE_PATHS), path).toBe(true);
    }
  });
});
