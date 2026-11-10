import { describe, expect, it } from 'vitest';
import { matchesAny } from './paths.js';
import {
  buildRoutingFacts,
  createRoutingMatchBudget,
  decideNeedsHuman,
  MAX_ROUTING_PATHS,
  mergeReviewRouting,
  parseReviewRoutingOverride,
  parseRoutingFacts,
  type ReviewRouting,
  type RoutingEvaluation,
  type RoutingInput,
  reviewRoutingLoosenings,
  reviewRoutingPathsSchema,
  riskRank,
  toRiskClass,
} from './reviewRouting.js';

const POLICY: ReviewRouting = {
  humanAboveLines: 0,
  humanMinRisk: 'LOW',
  humanPaths: [],
  quickReviewMaxLines: 100,
  skipWhenBotApproved: true,
};

const facts = (
  paths: string[],
  over: Partial<NonNullable<RoutingEvaluation['routing']>> = {}
): NonNullable<RoutingEvaluation['routing']> => ({
  paths,
  previousPaths: [],
  truncated: false,
  ...over,
});

const evaluation = (over: Partial<RoutingEvaluation> = {}): RoutingEvaluation => ({
  autoMergeEnabled: false,
  botApproved: false,
  changedLines: 20,
  humanObjection: false,
  requiredApprovers: 1,
  riskClass: 'LOW',
  routing: facts(['src/a.ts']),
  trustedApprovers: 0,
  ...over,
});

const input = (over: Partial<RoutingInput> = {}): RoutingInput => ({
  evaluation: evaluation(),
  isDraft: false,
  status: 'OPEN',
  ...over,
});

describe('decideNeedsHuman', () => {
  it('asks for a person on a ready, evaluated pull request by default', () => {
    expect(decideNeedsHuman(input(), POLICY)).toMatchObject({ needsHuman: true, reason: 'risk' });
  });

  it('needs nobody for a closed pull request or a draft', () => {
    expect(decideNeedsHuman(input({ status: 'MERGED' }), POLICY).reason).toBe('not_open');
    expect(decideNeedsHuman(input({ isDraft: true }), POLICY)).toMatchObject({
      needsHuman: false,
      reason: 'draft',
    });
  });

  it('fails closed without an evaluation at the current head', () => {
    expect(decideNeedsHuman(input({ evaluation: null }), POLICY)).toMatchObject({
      needsHuman: true,
      reason: 'not_evaluated',
    });
  });

  it('needs nobody once the required trusted approvals stand, even for a HIGH change', () => {
    const decision = decideNeedsHuman(
      input({
        evaluation: evaluation({ requiredApprovers: 2, riskClass: 'HIGH', trustedApprovers: 2 }),
      }),
      POLICY
    );
    expect(decision).toMatchObject({ needsHuman: false, reason: 'approvals_met' });
  });

  it('leaves a LOW change off the queue when the minimum risk is STANDARD', () => {
    const policy = { ...POLICY, humanMinRisk: 'STANDARD' as const };
    expect(decideNeedsHuman(input(), policy)).toMatchObject({
      needsHuman: false,
      reason: 'below_threshold',
    });
    expect(
      decideNeedsHuman(input({ evaluation: evaluation({ riskClass: 'STANDARD' }) }), policy)
        .needsHuman
    ).toBe(true);
  });

  it('skips a bot-approved, armed change only when the policy says so', () => {
    const botApproved = input({
      evaluation: evaluation({ autoMergeEnabled: true, botApproved: true }),
    });
    const lenient = { ...POLICY, humanMinRisk: 'STANDARD' as const };
    expect(decideNeedsHuman(botApproved, lenient).reason).toBe('bot_approved');
    const strict = { ...lenient, skipWhenBotApproved: false };
    // Skip off: a person still looks, even though the thresholds alone would let it go.
    expect(decideNeedsHuman(botApproved, strict)).toMatchObject({
      needsHuman: true,
      reason: 'bot_approved_review',
    });
    expect(
      decideNeedsHuman(botApproved, { ...lenient, skipWhenBotApproved: true }).needsHuman
    ).toBe(false);
    // With the default minimum risk of LOW the change asks for a person whatever the bot did.
    expect(decideNeedsHuman(botApproved, POLICY).needsHuman).toBe(true);
    // Approved but not armed: the bot skip does not apply.
    expect(
      decideNeedsHuman(input({ evaluation: evaluation({ botApproved: true }) }), lenient).reason
    ).toBe('below_threshold');
  });

  it('a path rule or a size rule outranks a bot approval and names every reason', () => {
    const policy: ReviewRouting = {
      ...POLICY,
      humanAboveLines: 10,
      humanMinRisk: 'HIGH',
      humanPaths: ['src/payments/**'],
    };
    const decision = decideNeedsHuman(
      input({
        evaluation: evaluation({
          autoMergeEnabled: true,
          botApproved: true,
          changedLines: 50,
          routing: facts(['docs/x.md', 'src/payments/charge.ts']),
        }),
      }),
      policy
    );
    expect(decision).toEqual({
      matchedPath: 'src/payments/charge.ts',
      needsHuman: true,
      reason: 'path',
      reasons: ['path', 'size'],
    });
  });

  it('asks when the size rule is on and the row recorded no line count', () => {
    const policy = { ...POLICY, humanAboveLines: 10, humanMinRisk: 'HIGH' as const };
    expect(
      decideNeedsHuman(input({ evaluation: evaluation({ changedLines: null }) }), policy)
    ).toMatchObject({ needsHuman: true, reason: 'size' });
    expect(
      decideNeedsHuman(input({ evaluation: evaluation({ changedLines: null }) }), {
        ...policy,
        humanAboveLines: 0,
      }).needsHuman
    ).toBe(false);
  });
});

describe('always-human paths', () => {
  const policy: ReviewRouting = {
    ...POLICY,
    humanMinRisk: 'HIGH',
    humanPaths: ['infra/**', '.github/**'],
  };
  const withPaths = (
    routing: RoutingEvaluation['routing'],
    over: Partial<RoutingEvaluation> = {}
  ) => input({ evaluation: evaluation({ routing, ...over }) });

  it('matches a protected file wherever it falls in a long change', () => {
    const many = Array.from({ length: 200 }, (_, i) => `src/file${i}.ts`);
    // Past the 50 files a brief keeps: the protected file is last.
    const decision = decideNeedsHuman(withPaths(facts([...many, 'infra/main.tf'])), policy);
    expect(decision).toMatchObject({
      matchedPath: 'infra/main.tf',
      needsHuman: true,
      reason: 'path',
    });
  });

  it('matches the previous path of a rename', () => {
    const decision = decideNeedsHuman(
      withPaths(facts(['src/moved.tf'], { previousPaths: ['infra/main.tf'] })),
      policy
    );
    expect(decision).toMatchObject({
      matchedPath: 'infra/main.tf',
      needsHuman: true,
      reason: 'path',
    });
  });

  it('counts a path too long to match as a match', () => {
    const long = `src/${'a'.repeat(1100)}.ts`;
    const decision = decideNeedsHuman(withPaths(facts([long])), policy);
    expect(decision).toMatchObject({ needsHuman: true, reason: 'path' });
    expect(decision.matchedPath?.length).toBeLessThan(300);
  });

  it('asks when the path list was cut or never recorded', () => {
    expect(
      decideNeedsHuman(withPaths(facts(['src/a.ts'], { truncated: true })), policy)
    ).toMatchObject({ matchedPath: null, needsHuman: true, reason: 'path' });
    expect(decideNeedsHuman(withPaths(null), policy)).toMatchObject({
      needsHuman: true,
      reason: 'path',
    });
    // With no always-human glob an unrecorded list is no reason to ask.
    expect(decideNeedsHuman(withPaths(null), { ...policy, humanPaths: [] }).needsHuman).toBe(false);
  });

  it('outranks the approvals that stand', () => {
    const decision = decideNeedsHuman(
      withPaths(facts(['infra/main.tf']), {
        requiredApprovers: 2,
        riskClass: 'HIGH',
        trustedApprovers: 2,
      }),
      policy
    );
    expect(decision).toMatchObject({ needsHuman: true, reason: 'path' });
  });

  it('shows a matched path without invisible or bidirectional characters', () => {
    const decision = decideNeedsHuman(withPaths(facts(['infra/\u202Eexe.tf\u200B'])), policy);
    expect(decision.matchedPath).toBe('infra/?exe.tf?');
  });

  it('asks once the request has spent its match budget', () => {
    const budget = createRoutingMatchBudget(10);
    const decision = decideNeedsHuman(withPaths(facts(['src/a.ts'])), policy, budget);
    expect(decision).toMatchObject({ matchedPath: null, needsHuman: true, reason: 'path' });
  });
});

describe('the path match work bound', () => {
  // The reviewer's worst case: question-mark-heavy globs against long paths with no slash. Left
  // unbounded, 1000 such pull requests took over a minute on the event loop.
  const heavy = [
    `*?*?*?*?*?*?*?*?${'?'.repeat(180)}q`,
    `${'?'.repeat(199)}r`,
    `${'?'.repeat(199)}s`,
    `${'?'.repeat(199)}t`,
    `${'?'.repeat(190)}u`,
  ];
  const paths = Array.from({ length: 50 }, (_, i) => `${'a'.repeat(997)}${i}`.slice(0, 1000));

  it('stops matching when the request budget is spent and asks for a person instead', () => {
    const policy: ReviewRouting = { ...POLICY, humanMinRisk: 'HIGH', humanPaths: heavy };
    const budget = createRoutingMatchBudget(5_000_000);
    const started = performance.now();
    const decisions = Array.from({ length: 200 }, () =>
      decideNeedsHuman(input({ evaluation: evaluation({ routing: facts(paths) }) }), policy, budget)
    );
    expect(performance.now() - started).toBeLessThan(3000);
    // None of the paths matches, so a decision that asked for a person did so because the budget
    // ran out before it could check.
    const unchecked = decisions.filter((d) => d.reason === 'path' && d.matchedPath === null);
    expect(unchecked.length).toBeGreaterThan(150);
    expect(decisions.every((d) => d.needsHuman === (d.reason === 'path'))).toBe(true);
  }, 20_000);
});

describe('approvals and a standing request for changes', () => {
  it('does not clear a pull request whose approvals stand beside a request for changes', () => {
    const decision = decideNeedsHuman(
      input({
        evaluation: evaluation({
          humanObjection: true,
          requiredApprovers: 1,
          trustedApprovers: 1,
        }),
      }),
      { ...POLICY, humanMinRisk: 'HIGH' }
    );
    expect(decision).toMatchObject({ needsHuman: true, reason: 'changes_requested' });
  });
});

describe('routing facts', () => {
  it('keeps every path and every rename source', () => {
    expect(
      buildRoutingFacts(
        [
          { path: 'a.ts' },
          { path: 'b.ts', previousPath: 'old/b.ts' },
          { path: 'a.ts' },
          { path: 'same.ts', previousPath: 'same.ts' },
        ],
        { listTruncated: false }
      )
    ).toEqual({
      paths: ['a.ts', 'b.ts', 'same.ts'],
      previousPaths: ['old/b.ts'],
      truncated: false,
    });
  });

  it('marks the list cut past the path count, past a path nothing can match, or when the host cut it', () => {
    const many = Array.from({ length: MAX_ROUTING_PATHS + 5 }, (_, i) => ({ path: `f${i}` }));
    const cut = buildRoutingFacts(many, { listTruncated: false });
    expect(cut.paths).toHaveLength(MAX_ROUTING_PATHS);
    expect(cut.truncated).toBe(true);
    expect(
      buildRoutingFacts([{ path: 'x'.repeat(2000) }], { listTruncated: false }).truncated
    ).toBe(true);
    expect(buildRoutingFacts([{ path: 'a' }], { listTruncated: true }).truncated).toBe(true);
  });

  it('reads a stored value that does not parse as unknown', () => {
    expect(parseRoutingFacts({ paths: ['a'], previousPaths: [], truncated: false })).toEqual({
      paths: ['a'],
      previousPaths: [],
      truncated: false,
    });
    expect(parseRoutingFacts(null)).toBeNull();
    expect(parseRoutingFacts({ paths: 'a' })).toBeNull();
  });
});

describe('what a team lead may loosen', () => {
  const inherited: ReviewRouting = {
    humanAboveLines: 500,
    humanMinRisk: 'STANDARD',
    humanPaths: ['infra/**'],
    quickReviewMaxLines: 100,
    skipWhenBotApproved: false,
  };

  it('allows only stricter values', () => {
    expect(
      reviewRoutingLoosenings(inherited, {
        humanAboveLines: 300,
        humanMinRisk: 'LOW',
        humanPaths: ['infra/**', 'billing/**'],
        quickReviewMaxLines: 50,
        skipWhenBotApproved: false,
      })
    ).toEqual([]);
  });

  it('reports every looser key', () => {
    expect(
      reviewRoutingLoosenings(inherited, {
        humanAboveLines: 0,
        humanMinRisk: 'HIGH',
        humanPaths: [],
        quickReviewMaxLines: 200,
        skipWhenBotApproved: true,
      }).sort()
    ).toEqual(
      [
        'humanAboveLines',
        'humanMinRisk',
        'humanPaths',
        'quickReviewMaxLines',
        'skipWhenBotApproved',
      ].sort()
    );
    expect(reviewRoutingLoosenings(inherited, { humanAboveLines: 600 })).toEqual([
      'humanAboveLines',
    ]);
    expect(reviewRoutingLoosenings(inherited, { humanPaths: ['other/**'] })).toEqual([
      'humanPaths',
    ]);
  });

  it('treats turning the size rule on as stricter, and leaving it off as unchanged', () => {
    const off = { ...inherited, humanAboveLines: 0 };
    expect(reviewRoutingLoosenings(off, { humanAboveLines: 900 })).toEqual([]);
    expect(reviewRoutingLoosenings(off, { humanAboveLines: 0 })).toEqual([]);
  });

  it('does not report a value the stored override already holds', () => {
    expect(
      reviewRoutingLoosenings(inherited, { humanMinRisk: 'HIGH' }, { humanMinRisk: 'HIGH' })
    ).toEqual([]);
  });
});

describe('review routing override', () => {
  it('merges only the keys a repository sets', () => {
    expect(mergeReviewRouting(POLICY, { humanMinRisk: 'HIGH', humanPaths: ['a/**'] })).toEqual({
      ...POLICY,
      humanMinRisk: 'LOW',
      humanPaths: ['a/**'],
    });
    expect(mergeReviewRouting(POLICY, {})).toEqual(POLICY);
  });

  it('takes the stricter of the setting and the override on every key', () => {
    const base: ReviewRouting = {
      humanAboveLines: 300,
      humanMinRisk: 'STANDARD',
      humanPaths: ['secrets/**', 'Infra/**'],
      quickReviewMaxLines: 80,
      skipWhenBotApproved: true,
    };
    expect(
      mergeReviewRouting(base, {
        humanAboveLines: 200,
        humanMinRisk: 'LOW',
        humanPaths: ['infra/**', 'billing/**'],
        quickReviewMaxLines: 10,
        skipWhenBotApproved: false,
      })
    ).toEqual({
      humanAboveLines: 200,
      humanMinRisk: 'LOW',
      humanPaths: ['secrets/**', 'Infra/**', 'billing/**'],
      quickReviewMaxLines: 10,
      skipWhenBotApproved: false,
    });
    // A looser value is inert: it can neither drop a glob nor raise a limit.
    expect(
      mergeReviewRouting(base, {
        humanAboveLines: 0,
        humanMinRisk: 'HIGH',
        humanPaths: [],
        quickReviewMaxLines: 500,
        skipWhenBotApproved: true,
      })
    ).toEqual(base);
    // 0 is "no size rule" on either side.
    expect(
      mergeReviewRouting({ ...base, humanAboveLines: 0 }, { humanAboveLines: 50 })
    ).toMatchObject({ humanAboveLines: 50 });
  });

  it('keeps a team lead override from hiding a path an ADMIN added to the settings later', () => {
    const later: ReviewRouting = {
      humanAboveLines: 0,
      humanMinRisk: 'LOW',
      humanPaths: ['secrets/**'],
      quickReviewMaxLines: 50,
      skipWhenBotApproved: true,
    };
    const stale = { humanMinRisk: 'STANDARD' as const, humanPaths: ['infra/**'] };
    const merged = mergeReviewRouting(later, stale);
    expect(merged.humanPaths).toEqual(['secrets/**', 'infra/**']);
    expect(merged.humanMinRisk).toBe('LOW');
  });

  it('reads a stored value that does not parse as no override', () => {
    expect(parseReviewRoutingOverride(null)).toEqual({});
    expect(parseReviewRoutingOverride({ humanMinRisk: 'EXTREME' })).toEqual({});
    expect(parseReviewRoutingOverride({ extra: 1 })).toEqual({});
    expect(parseReviewRoutingOverride({ humanMinRisk: 'HIGH' })).toEqual({ humanMinRisk: 'HIGH' });
  });

  it('drops only the key that fails and keeps the others', () => {
    expect(
      parseReviewRoutingOverride({
        humanAboveLines: -3,
        humanMinRisk: 'HIGH',
        humanPaths: ['ok/**', '{broken'],
        skipWhenBotApproved: false,
      })
    ).toEqual({ humanMinRisk: 'HIGH', skipWhenBotApproved: false });
  });
});

describe('the role floor against what is in force now', () => {
  const inherited: ReviewRouting = {
    humanAboveLines: 0,
    humanMinRisk: 'HIGH',
    humanPaths: [],
    quickReviewMaxLines: 50,
    skipWhenBotApproved: true,
  };
  // What an ADMIN stored on the repository.
  const adminStored = {
    humanAboveLines: 100,
    humanMinRisk: 'LOW' as const,
    humanPaths: ['payments/**'],
    skipWhenBotApproved: false,
  };

  it('refuses an override that leaves out a key the stored override tightens', () => {
    expect(
      reviewRoutingLoosenings(inherited, { quickReviewMaxLines: 10 }, adminStored, {
        removal: true,
      }).sort()
    ).toEqual(['humanAboveLines', 'humanMinRisk', 'humanPaths', 'skipWhenBotApproved']);
    // Clearing the override is leaving every key out.
    expect(reviewRoutingLoosenings(inherited, {}, adminStored, { removal: true })).toHaveLength(4);
    // A platform ADMIN may remove strictness.
    expect(reviewRoutingLoosenings(inherited, { quickReviewMaxLines: 10 }, adminStored)).toEqual(
      []
    );
  });

  it('refuses a value looser than the one in force, not only than the setting', () => {
    const cases: [Partial<ReviewRouting>, keyof ReviewRouting][] = [
      [{ humanAboveLines: 0 }, 'humanAboveLines'],
      [{ humanAboveLines: 400 }, 'humanAboveLines'],
      [{ humanPaths: [] }, 'humanPaths'],
      [{ humanPaths: ['other/**'] }, 'humanPaths'],
      [{ humanMinRisk: 'HIGH' }, 'humanMinRisk'],
      [{ humanMinRisk: 'STANDARD' }, 'humanMinRisk'],
    ];
    for (const [proposed, key] of cases) {
      const keep = {
        humanAboveLines: 100,
        humanMinRisk: 'LOW' as const,
        humanPaths: ['payments/**'],
        skipWhenBotApproved: false,
      };
      expect(
        reviewRoutingLoosenings(inherited, { ...keep, ...proposed }, adminStored, { removal: true })
      ).toEqual([key]);
    }
  });

  it('lets a lead tighten further and add globs beside the stored ones', () => {
    expect(
      reviewRoutingLoosenings(
        inherited,
        {
          humanAboveLines: 50,
          humanMinRisk: 'LOW',
          humanPaths: ['payments/**', 'infra/**'],
          quickReviewMaxLines: 10,
          skipWhenBotApproved: false,
        },
        adminStored,
        { removal: true }
      )
    ).toEqual([]);
  });

  it('lets a lead re-save a stale override unchanged', () => {
    const later: ReviewRouting = { ...inherited, humanMinRisk: 'LOW', humanPaths: ['secrets/**'] };
    const stale = { humanMinRisk: 'STANDARD' as const, humanPaths: ['infra/**'] };
    expect(reviewRoutingLoosenings(later, stale, stale, { removal: true })).toEqual([]);
  });
});

describe('always-human globs that can never match', () => {
  const accepts = (glob: string) => reviewRoutingPathsSchema.safeParse([glob]).success;

  it('refuses a spelling the matcher cannot satisfy', () => {
    for (const glob of ['./infra/**', '/infra/**', 'infra/', 'infra\\**', '!src/**', 'a/b/']) {
      expect(accepts(glob), glob).toBe(false);
    }
  });

  it('names the reason', () => {
    const result = reviewRoutingPathsSchema.safeParse(['infra/']);
    expect(JSON.stringify(result.error?.issues)).toContain('dir/**');
  });

  it('accepts the spellings that match, and they do', () => {
    const cases: [string, string][] = [
      ['infra/**', 'infra/main.tf'],
      ['INFRA/**', 'infra/main.tf'],
      ['infra/**', 'Infra/Deep/Main.TF'],
      ['**/secrets/**', 'secrets/a'],
      ['**/secrets/**', 'app/secrets/a'],
      ['**/*.tf', 'infra/main.tf'],
      ['infra/*', 'infra/main.tf'],
      ['Makefile', 'Makefile'],
    ];
    for (const [glob, path] of cases) {
      expect(accepts(glob), glob).toBe(true);
      expect(matchesAny(path, [glob]), `${glob} ~ ${path}`).toBe(true);
    }
  });

  it('states what does not match, so the documentation is exact', () => {
    // Anchored at the repository root: `*` does not cross a directory, a bare name is that path.
    expect(matchesAny('infra/main.tf', ['*.tf'])).toBe(false);
    expect(matchesAny('infra/main.tf', ['infra'])).toBe(false);
    expect(matchesAny('infra/a/b.tf', ['infra/*'])).toBe(false);
  });

  it('matches a glob and a path however they are Unicode-normalised', () => {
    const nfc = 'config/caf\u00e9/**';
    const nfd = 'config/cafe\u0301/**';
    expect(matchesAny('config/cafe\u0301/x', [nfc])).toBe(true);
    expect(matchesAny('config/caf\u00e9/x', [nfd])).toBe(true);
    expect(matchesAny('config/caf\u00e9/x', [nfc])).toBe(true);
  });
});

describe('an unrecognised risk class', () => {
  it('reads as the highest', () => {
    for (const risk of ['high', 'CRITICAL', '', null, undefined, 3, '__proto__']) {
      expect(riskRank(risk)).toBe(2);
      expect(toRiskClass(risk)).toBe('HIGH');
    }
    expect(toRiskClass('LOW')).toBe('LOW');
  });

  it('asks for a person where only HIGH would', () => {
    const policy: ReviewRouting = { ...POLICY, humanMinRisk: 'HIGH' };
    for (const risk of ['high', 'CRITICAL', '']) {
      const decision = decideNeedsHuman(
        input({ evaluation: evaluation({ riskClass: risk as never }) }),
        policy
      );
      expect(decision).toMatchObject({ needsHuman: true, reason: 'risk' });
    }
  });
});

describe('the path match budget is charged for the work a path costs', () => {
  it('rejects a path shorter than every glob for almost nothing', () => {
    const budget = createRoutingMatchBudget(1000);
    const policy: ReviewRouting = {
      ...POLICY,
      humanMinRisk: 'HIGH',
      humanPaths: [`${'?'.repeat(150)}q`],
    };
    const decision = decideNeedsHuman(
      input({
        evaluation: evaluation({
          routing: facts(Array.from({ length: 100 }, (_, i) => `src/${i}.ts`)),
        }),
      }),
      policy,
      budget
    );
    expect(decision).toMatchObject({ needsHuman: false, reason: 'below_threshold' });
    expect(budget.remaining).toBeGreaterThan(0);
  });

  it('charges every budget it is given', () => {
    const request = createRoutingMatchBudget(1_000_000);
    const repository = createRoutingMatchBudget(50);
    const policy: ReviewRouting = { ...POLICY, humanMinRisk: 'HIGH', humanPaths: ['infra/**'] };
    const decision = decideNeedsHuman(
      input({ evaluation: evaluation({ routing: facts(['src/a.ts', 'src/b.ts']) }) }),
      policy,
      [request, repository]
    );
    // The repository's share is spent, so the path cannot be shown clear; the request is charged too.
    expect(decision).toMatchObject({ matchedPath: null, needsHuman: true, reason: 'path' });
    expect(request.remaining).toBeLessThan(1_000_000);
  });
});
