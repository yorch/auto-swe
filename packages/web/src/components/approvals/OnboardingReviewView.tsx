import { Markdown } from '@/components/docs/Markdown';
import { Alert } from '@/components/ui/Alert';
import { cn } from '@/lib/utils';
import type { OnboardingReview, TrialOutcome } from './onboardingReview';

const OUTCOME: Record<
  TrialOutcome,
  { variant: 'success' | 'warning' | 'error'; headline: string }
> = {
  blocked: { headline: 'Trial blocked', variant: 'error' },
  failed: { headline: 'Trial failed', variant: 'error' },
  not_run: { headline: 'Not trialled', variant: 'warning' },
  passed: { headline: 'Trial passed', variant: 'success' },
};

/** Compact the rendered markdown so a draft reads as part of the card, not as a page. */
const MARKDOWN_CLASS = cn(
  'text-sm leading-6',
  '[&_h2]:mt-0 [&_h2]:border-0 [&_h2]:pb-0 [&_h2]:text-base',
  '[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:font-mono [&_h3]:text-sm',
  '[&_pre]:my-3 [&_pre]:text-xs'
);

/**
 * The context of an onboarding approval: the trial summary first (what a person decides on),
 * then the draft files as readable code blocks, then the full trial report. The page scrolls;
 * nothing in here has a scroll area of its own.
 */
export function OnboardingReviewView({ review }: { review: OnboardingReview }) {
  const outcome = OUTCOME[review.outcome];
  const hasFindings = review.failedSteps.length > 0 || review.blockers.length > 0;
  return (
    <div className="space-y-4" data-testid="onboarding-review">
      <Alert announce={false} title={outcome.headline} variant={outcome.variant}>
        <p>{review.status}</p>
        {hasFindings && (
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {review.failedSteps.map((step) => (
              <li key={`step-${step.label}`}>
                <span className="font-medium">Failed:</span> {step.label}
              </li>
            ))}
            {review.blockers.map((blocker) => (
              <li key={`blocker-${blocker.label}-${blocker.detail}`}>
                <span className="font-mono text-xs">{blocker.label}</span>
                {blocker.detail ? `: ${blocker.detail}` : ''}
              </li>
            ))}
          </ul>
        )}
      </Alert>

      <Markdown className={MARKDOWN_CLASS}>{review.draftMarkdown}</Markdown>

      <details className="group rounded-lg border border-ink-500/60 bg-ink-950/40">
        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-paper-300 hover:text-paper-100">
          Full trial report
        </summary>
        <div className="border-t border-ink-600 px-3 py-2">
          <Markdown className={MARKDOWN_CLASS}>{review.trialMarkdown}</Markdown>
        </div>
      </details>
    </div>
  );
}
