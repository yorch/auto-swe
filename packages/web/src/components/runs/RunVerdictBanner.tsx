'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { NEEDS_RESPONSE_ANCHOR, type RunVerdict } from '@/lib/runVerdict';

/**
 * The run's verdict in plain language, above the detail cards. It states and points; the
 * result, failure and gate cards below keep the evidence. Its single action reuses a control
 * the page already has.
 */
export function RunVerdictBanner({
  verdict,
  onJumpToFailure,
  onGoToGate,
}: {
  verdict: RunVerdict;
  onJumpToFailure?: () => void;
  onGoToGate?: () => void;
}) {
  const action = verdict.nextAction;
  let control: React.ReactNode;
  if (action?.kind === 'jump-to-failure' && onJumpToFailure) {
    control = (
      <Button className="h-[40px] lg:h-8" onClick={onJumpToFailure} size="sm" variant="secondary">
        {action.label}
      </Button>
    );
  } else if (action?.kind === 'link' && action.href === `#${NEEDS_RESPONSE_ANCHOR}` && onGoToGate) {
    control = (
      <Button className="h-[40px] lg:h-8" onClick={onGoToGate} size="sm" variant="secondary">
        {action.label}
      </Button>
    );
  } else if (action?.kind === 'link' && action.external) {
    control = (
      <ButtonLink
        className="h-[40px] lg:h-8"
        href={action.href}
        rel="noopener noreferrer"
        size="sm"
        target="_blank"
        variant="secondary"
      >
        {action.label}
      </ButtonLink>
    );
  } else if (action?.kind === 'link') {
    control = (
      <Link
        className="inline-flex h-[40px] items-center rounded-md border border-ink-400/60 px-3 text-sm text-paper-100 hover:bg-ink-700/50 lg:h-8"
        href={action.href}
      >
        {action.label}
      </Link>
    );
  }
  return (
    <div
      className="shrink-0 border-b border-ink-600/40 bg-ink-900 px-4 py-2 md:px-6 md:py-3"
      data-tour="run:verdict"
    >
      <Alert
        action={control}
        className="max-sm:gap-y-2 max-sm:py-2"
        stackActionOnNarrow
        title={verdict.headline}
        variant={verdict.tone}
      >
        <p className="hidden sm:block">{verdict.detail}</p>
        <details className="sm:hidden">
          <summary className="cursor-pointer">Outcome details</summary>
          <p className="mt-2 max-h-28 overflow-y-auto overscroll-contain">{verdict.detail}</p>
        </details>
      </Alert>
    </div>
  );
}
