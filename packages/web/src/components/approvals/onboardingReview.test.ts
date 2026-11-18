import { describe, expect, it } from 'vitest';
import { parseOnboardingReview, trialDidNotPass } from './onboardingReview';

const base = {
  draftMarkdown:
    '## Repository onboarding draft\n\n### .auto-swe/setup.yml\n\n```yaml\nsteps: []\n```',
  status: 'Draft verified: the trial passed. Review the draft before approving.',
  trialMarkdown: '## Repository onboarding trial\n\nTrial passed.\n\n- **passed** — setup: install',
};

describe('parseOnboardingReview', () => {
  it('reads the recorded outcome of an object context', () => {
    const review = parseOnboardingReview({ ...base, trialOutcome: 'passed' });
    expect(review).toMatchObject({ outcome: 'passed', status: base.status });
    expect(trialDidNotPass(review)).toBe(false);
  });

  it('reads a JSON string context, and takes the outcome from the report of an older approval', () => {
    const trialMarkdown = [
      '## Repository onboarding trial',
      '',
      'Trial blocked; operator action is required.',
      '',
      '- **failed** — setup: Verify required local tooling (exit 1)',
      '    /bin/sh: docker: not found',
      '',
      '- **egress_denied**: Allow the host in the egress policy (registry.example.test)',
    ].join('\n');
    const review = parseOnboardingReview(JSON.stringify({ ...base, trialMarkdown }));
    expect(review?.outcome).toBe('blocked');
    expect(review?.failedSteps).toEqual([
      { detail: null, label: 'setup: Verify required local tooling (exit 1)' },
    ]);
    expect(review?.blockers).toEqual([
      {
        detail: 'Allow the host in the egress policy (registry.example.test)',
        label: 'egress_denied',
      },
    ]);
    expect(trialDidNotPass(review)).toBe(true);
  });

  it('treats a trial of an earlier draft, or no trial, as not run', () => {
    expect(
      parseOnboardingReview({ ...base, trialAppliesToCurrentDraft: false, trialOutcome: 'passed' })
        ?.outcome
    ).toBe('not_run');
    expect(parseOnboardingReview({ ...base, trialMarkdown: 'No trial has run.' })?.outcome).toBe(
      'not_run'
    );
    expect(trialDidNotPass(parseOnboardingReview({ ...base, trialOutcome: 'not_run' }))).toBe(true);
  });

  it('returns null for contexts that are not an onboarding review', () => {
    expect(parseOnboardingReview(null)).toBeNull();
    expect(parseOnboardingReview('not json')).toBeNull();
    expect(parseOnboardingReview('plain diff text')).toBeNull();
    expect(parseOnboardingReview([base])).toBeNull();
    expect(parseOnboardingReview({ draftMarkdown: 'y', status: 'x' })).toBeNull();
    expect(parseOnboardingReview({ ...base, draftMarkdown: 3 })).toBeNull();
    expect(trialDidNotPass(null)).toBe(false);
  });
});
