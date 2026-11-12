'use client';

import type { WorkflowRunDetail } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useWorkflowSetupBlocker } from '@/hooks/useRepositories';
import { findFailedStep } from '@/lib/runFailure';
import { NEEDS_RESPONSE_ANCHOR, type RunVerdict } from '@/lib/runVerdict';
import { runRepositoryId, setupBlockerLabel } from '@/lib/setupBlockers';

interface RunVerdictBannerProps {
  verdict: RunVerdict;
  run?: Pick<WorkflowRunDetail, 'contextSnapshot' | 'status' | 'steps' | 'workflowId'>;
  onJumpToFailure?: () => void;
  onGoToGate?: () => void;
}

function SetupVerdictBanner({
  repositoryId,
  workflowId,
  ...props
}: RunVerdictBannerProps & { repositoryId: string; workflowId: string }) {
  const blocker = useWorkflowSetupBlocker(repositoryId, workflowId);
  return (
    <VerdictBannerContent
      {...props}
      verdict={
        blocker
          ? { ...props.verdict, detail: blocker.remedy, headline: setupBlockerLabel(blocker.kind) }
          : props.verdict
      }
    />
  );
}

/**
 * The run's verdict in plain language, above the detail cards. It states and points; the
 * result, failure and gate cards below keep the evidence. Its single action reuses a control
 * the page already has.
 */
export function RunVerdictBanner(props: RunVerdictBannerProps) {
  const run = props.run;
  const failedStep = run ? findFailedStep(run.status, run.steps) : null;
  const repositoryId = runRepositoryId(run?.contextSnapshot);
  return failedStep?.error?.startsWith('WORKSPACE_SETUP_FAILED') &&
    repositoryId &&
    run?.workflowId ? (
    <SetupVerdictBanner {...props} repositoryId={repositoryId} workflowId={run.workflowId} />
  ) : (
    <VerdictBannerContent {...props} />
  );
}

function VerdictBannerContent({ verdict, onJumpToFailure, onGoToGate }: RunVerdictBannerProps) {
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const outcomeTrigger = useRef<HTMLButtonElement>(null);
  const outcomeContent = useRef<HTMLElement>(null);
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
        <Button
          aria-haspopup="dialog"
          className="-my-2 -ml-2 h-[40px] sm:hidden"
          onClick={(event) => {
            outcomeTrigger.current = event.currentTarget;
            setOutcomeOpen(true);
          }}
          size="sm"
          variant="ghost"
        >
          Outcome details
        </Button>
      </Alert>
      {outcomeOpen && (
        <Modal
          initialFocusRef={outcomeContent}
          onClose={() => {
            setOutcomeOpen(false);
            outcomeTrigger.current?.focus();
          }}
          open
          subtitle={verdict.headline}
          title="Outcome details"
        >
          <section
            aria-label="Outcome explanation"
            className="max-h-[50dvh] overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-sm text-paper-300"
            ref={outcomeContent}
            tabIndex={-1}
          >
            {verdict.detail}
          </section>
        </Modal>
      )}
    </div>
  );
}
