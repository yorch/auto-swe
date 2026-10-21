import { describe, expect, it } from 'vitest';
import { PR_FEEDBACK_INPUT_SCHEMA, PrFeedbackPayloadSchema } from '../../lib/prFeedback.js';
import { buildAutomationPayload } from '../inputs.js';
import {
  PR_FEEDBACK,
  PrFeedbackFactsSchema,
  PrFeedbackFiltersSchema,
  parseFeedbackCommand,
  prFeedbackSource as src,
} from './prFeedback.js';

const filters = PrFeedbackFiltersSchema.parse(src.defaultFilters);

function facts(over: Record<string, unknown> = {}) {
  return PrFeedbackFactsSchema.parse({
    eventId: '777',
    eventKind: 'review',
    headRef: 'auto/prfb-1-777',
    htmlUrl: 'https://github.com/acme/api/pull/1#pullrequestreview-777',
    notes: 'please handle the null case',
    origin: 'workflow',
    prNumber: 1,
    senderId: '42',
    senderLogin: 'octocat',
    submittedAt: '2026-10-01T00:00:00Z',
    trigger: 'changes_requested',
    ...over,
  });
}

describe('prFeedbackSource', () => {
  it('is the feedback source, targeting repositories under its kill switch', () => {
    expect(src.key).toBe(PR_FEEDBACK);
    expect(src.key).toBe('github.pull_request.feedback');
    expect(src.target).toBe('repository');
    expect(src.killSwitch).toBe('github.prFeedbackAutomationsEnabled');
    expect(src.defaultTemplate?.name).toBe('address-pr-feedback');
    expect(src.actor?.(facts())).toEqual({ id: '42', login: 'octocat' });
  });

  it('refuses empty filter lists', () => {
    expect(
      PrFeedbackFiltersSchema.safeParse({ pullRequests: [], triggers: ['command'] }).success
    ).toBe(false);
    expect(
      PrFeedbackFiltersSchema.safeParse({ pullRequests: ['platform'], triggers: [] }).success
    ).toBe(false);
    expect(
      PrFeedbackFiltersSchema.safeParse({ pullRequests: ['anybody'], triggers: ['command'] })
        .success
    ).toBe(false);
  });

  it('gates the "others" pull-request value on its admin setting', () => {
    expect(src.gatedFilters).toEqual([
      expect.objectContaining({
        key: 'pullRequests',
        setting: 'github.prFeedbackOtherPullRequestsEnabled',
        values: ['others'],
      }),
    ]);
  });

  describe('mismatch', () => {
    const every = PrFeedbackFiltersSchema.parse({
      pullRequests: ['platform', 'others'],
      triggers: ['changes_requested', 'command'],
    });

    it('rejects a trigger the filters do not select', () => {
      const onlyCommand = { ...filters, triggers: ['command' as const] };
      expect(src.mismatch(onlyCommand, facts())).toMatch(/does not react/);
      expect(src.mismatch(onlyCommand, facts({ trigger: 'command' }))).toBeNull();
    });

    it('rejects a platform pull request when only "others" is selected', () => {
      const others = { ...filters, pullRequests: ['others' as const] };
      expect(src.mismatch(others, facts({ trigger: 'command' }))).toMatch(/platform opened/);
      expect(src.mismatch(others, facts({ origin: 'agent_run', trigger: 'command' }))).toMatch(
        /platform opened/
      );
    });

    it('rejects a pull request the platform did not open unless "others" is selected', () => {
      expect(src.mismatch(filters, facts({ origin: 'other', trigger: 'command' }))).toMatch(
        /not one the platform opened/
      );
      expect(src.mismatch(every, facts({ origin: 'other', trigger: 'command' }))).toBeNull();
    });

    it('rejects a review requesting changes on a pull request the platform did not open', () => {
      expect(src.mismatch(every, facts({ origin: 'other' }))).toMatch(/only the command/);
    });

    it.each([
      ['workflow', 'changes_requested'],
      ['agent_run', 'changes_requested'],
      ['agent_run', 'command'],
      ['other', 'command'],
    ] as const)('selects origin %s via %s', (origin, trigger) => {
      expect(src.mismatch(every, facts({ origin, trigger }))).toBeNull();
    });
  });

  it('keys one delivery as its own subject, scoped to the pull request', () => {
    const x = facts();
    expect(src.keys(x)).toEqual({
      scope: 'pr-1',
      subject: 'pr-1@review-777',
    });
    expect(src.keys(facts({ eventKind: 'issue_comment' })).subject).toBe('pr-1@issue_comment-777');
    expect(src.dedupeKey('GitHub.com/Acme/API', x)).toBe('github.com/acme/api#pr-1/review-777');
    expect(src.workflowId).toEqual({ part: expect.any(Function), prefix: 'prfb' });
    expect(src.workflowId.part(x)).toBe('1-777');
  });

  it('runs on the feedback under a synthetic ticket, carrying its event fields', () => {
    const run = src.run(facts());
    expect(run).toMatchObject({ ticketId: 'prfb-1-777', ticketIsSynthetic: true });
    expect(run.fields).toEqual({
      baseBranch: 'auto/prfb-1-777',
      feedbackEventId: '777',
      feedbackEventKind: 'review',
      feedbackOrigin: 'workflow',
      feedbackTrigger: 'changes_requested',
      pullRequestNumber: 1,
    });
    expect(run.description).toContain('#1');
    expect(run.description).toContain('octocat');
  });

  it('omits baseBranch from the run when the enrichment could not name the head', () => {
    expect(src.run(facts({ headRef: undefined })).fields).not.toHaveProperty('baseBranch');
  });

  it('parses the payload its run fields produce through its contract', () => {
    const built = buildAutomationPayload(
      src,
      PR_FEEDBACK_INPUT_SCHEMA,
      {},
      '00000000-0000-4000-8000-000000000001',
      facts()
    );
    expect(built).toMatchObject({ ok: true });
    const parsed = PrFeedbackPayloadSchema.safeParse(built.ok ? built.payload : {});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        baseBranch: 'auto/prfb-1-777',
        feedbackEventId: '777',
        feedbackTrigger: 'changes_requested',
        maxCiFixAttempts: 1,
        maxRounds: 5,
        pullRequestNumber: 1,
      });
    }
  });

  it('samples every origin and trigger the filters can select', () => {
    const every = PrFeedbackFiltersSchema.parse({
      pullRequests: ['platform', 'others'],
      triggers: ['changes_requested', 'command'],
    });
    const samples = src.samples(every);
    for (const sample of samples) {
      expect(PrFeedbackFactsSchema.safeParse(sample).success).toBe(true);
      expect(src.mismatch(every, sample)).toBeNull();
    }
    const pairs = new Set(samples.map((s) => `${s.origin}:${s.trigger}`));
    expect(pairs).toEqual(
      new Set([
        'workflow:changes_requested',
        'agent_run:changes_requested',
        'workflow:command',
        'agent_run:command',
        'other:command',
      ])
    );
    // The defaults never produce a sample "others" could match.
    expect(src.samples(filters).every((s) => s.origin !== 'other')).toBe(true);
  });

  it('accepts the address-pr-feedback input schema, not one that takes no feedback event', () => {
    expect(src.templateCompatible(PR_FEEDBACK_INPUT_SCHEMA)).toBe(true);
    const { feedbackEventId: _f, ...rest } = PR_FEEDBACK_INPUT_SCHEMA.properties;
    expect(src.templateCompatible({ ...PR_FEEDBACK_INPUT_SCHEMA, properties: rest })).toBe(false);
  });

  it('keeps the feedback-run fields out of an automation’s own inputs', () => {
    for (const key of [
      'baseBranch',
      'connectionId',
      'description',
      'feedbackEventId',
      'feedbackEventKind',
      'feedbackOrigin',
      'feedbackTrigger',
      'pullRequestNumber',
      'ticketId',
    ]) {
      expect(src.eventInputKeys).toContain(key);
    }
  });
});

describe('parseFeedbackCommand', () => {
  it('finds the command and keeps the rest of the line and what follows', () => {
    expect(parseFeedbackCommand('please look\n/auto-swe fix the flaky test\nthanks')).toEqual({
      notes: 'the flaky test\nthanks',
    });
    expect(parseFeedbackCommand('/auto-swe fix')).toEqual({ notes: '' });
    expect(parseFeedbackCommand('  /AUTO-SWE FIX  now please  ')).toEqual({ notes: 'now please' });
  });

  it('needs the command at the start of a trimmed line', () => {
    expect(parseFeedbackCommand('looks like /auto-swe fix to me')).toBeNull();
    expect(parseFeedbackCommand('see the docs at /auto-swe fix')).toBeNull();
  });

  it('is not matched by a longer word', () => {
    expect(parseFeedbackCommand('/auto-swe fixes everything')).toBeNull();
    expect(parseFeedbackCommand('/auto-swe fixer')).toBeNull();
  });

  it('does not see a command hidden in an HTML comment', () => {
    expect(parseFeedbackCommand('<!-- /auto-swe fix -->hello')).toBeNull();
    expect(parseFeedbackCommand('<!--\n/auto-swe fix\n-->hi')).toBeNull();
  });

  it('bounds the notes', () => {
    const out = parseFeedbackCommand(`/auto-swe fix\n${'x'.repeat(10_000)}`);
    expect(out?.notes.length).toBe(4_000);
  });
});
