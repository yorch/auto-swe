/**
 * The context of a "Review repository onboarding" approval, read back from the generic context
 * the workflow stores (`context.onboardingReview` in the repo-onboarding template).
 */

export type TrialOutcome = 'passed' | 'failed' | 'blocked' | 'not_run';

export interface TrialFinding {
  /** A failed trial step ("setup: Install dependencies") or a blocker kind ("missing_secret"). */
  label: string;
  /** What to do about it, when the report says. */
  detail: string | null;
}

export interface OnboardingReview {
  status: string;
  draftMarkdown: string;
  trialMarkdown: string;
  outcome: TrialOutcome;
  /** Steps of the trial that failed, from its report. */
  failedSteps: TrialFinding[];
  /** Blockers named in the trial report. */
  blockers: TrialFinding[];
}

const OUTCOMES: readonly TrialOutcome[] = ['passed', 'failed', 'blocked', 'not_run'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Approvals created before the workflow recorded `trialOutcome` only have the report, whose
 * first sentence states the outcome.
 */
function outcomeFromReport(trialMarkdown: string): TrialOutcome {
  if (/^Trial passed\./m.test(trialMarkdown)) {
    return 'passed';
  }
  if (/^Trial failed\b/m.test(trialMarkdown)) {
    return 'failed';
  }
  if (/^Trial blocked\b/m.test(trialMarkdown)) {
    return 'blocked';
  }
  return 'not_run';
}

/** Failed steps and blockers, from the bullet lines the trial report is written with. */
function findingsFromReport(trialMarkdown: string): {
  failedSteps: TrialFinding[];
  blockers: TrialFinding[];
} {
  const failedSteps: TrialFinding[] = [];
  const blockers: TrialFinding[] = [];
  for (const line of trialMarkdown.split('\n')) {
    const step = /^- \*\*failed\*\* — (\w+): (.+)$/.exec(line);
    if (step) {
      failedSteps.push({ detail: null, label: `${step[1]}: ${step[2]}` });
      continue;
    }
    const blocker = /^- \*\*(\w+)\*\*: (.+)$/.exec(line);
    if (blocker && !['passed', 'failed', 'skipped'].includes(blocker[1] ?? '')) {
      blockers.push({ detail: blocker[2] ?? null, label: blocker[1] ?? '' });
    }
  }
  return { blockers, failedSteps };
}

/**
 * Read an approval's context as an onboarding review, or null when it is not one (another kind of
 * approval, or a payload that does not parse), so the caller falls back to the generic view.
 */
export function parseOnboardingReview(context: unknown): OnboardingReview | null {
  let value = context;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (
    !isRecord(value) ||
    typeof value.status !== 'string' ||
    typeof value.draftMarkdown !== 'string' ||
    typeof value.trialMarkdown !== 'string'
  ) {
    return null;
  }
  const recorded = OUTCOMES.find((outcome) => outcome === value.trialOutcome);
  // Reason: a trial of an earlier draft says nothing about the one on screen.
  const outcome =
    value.trialAppliesToCurrentDraft === false
      ? 'not_run'
      : (recorded ?? outcomeFromReport(value.trialMarkdown));
  return {
    draftMarkdown: value.draftMarkdown,
    outcome,
    status: value.status,
    trialMarkdown: value.trialMarkdown,
    ...findingsFromReport(value.trialMarkdown),
  };
}

/** True when approving would propose configuration whose trial did not pass. */
export function trialDidNotPass(review: OnboardingReview | null): boolean {
  return review !== null && review.outcome !== 'passed';
}
