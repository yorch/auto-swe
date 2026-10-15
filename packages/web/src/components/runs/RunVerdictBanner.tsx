'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import type { RunVerdict } from '@/lib/runVerdict';

/**
 * The run's verdict in plain language, above the detail cards. It states and points; the
 * result, failure and gate cards below keep the evidence. Its single action reuses a control
 * the page already has.
 */
export function RunVerdictBanner({
  verdict,
  onJumpToFailure,
}: {
  verdict: RunVerdict;
  onJumpToFailure?: () => void;
}) {
  const action = verdict.nextAction;
  let control: React.ReactNode;
  if (action?.kind === 'jump-to-failure' && onJumpToFailure) {
    control = (
      <Button className="h-[40px] lg:h-8" onClick={onJumpToFailure} size="sm" variant="secondary">
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
    <div className="shrink-0 border-b border-ink-600/40 bg-ink-900 px-4 py-3 md:px-6">
      <Alert action={control} title={verdict.headline} variant={verdict.tone}>
        {verdict.detail}
      </Alert>
    </div>
  );
}
