'use client';

import {
  type CampaignProposalPayload,
  CampaignProposalPayloadSchema,
  type OrchestrationDetailDto,
  type OrchestrationMessageDto,
} from '@auto-swe/shared/lib/orchestrationApi';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  type CampaignStartInitialValues,
  CampaignStartModal,
} from '@/components/campaigns/CampaignStartModal';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

const ROW = 'rounded-lg border border-ink-400 bg-ink-800/70 p-3 text-sm sm:p-4';

/** The Start form's initial values for a proposal. Model text goes in as a value, never as markup. */
export function proposalInitialValues(p: CampaignProposalPayload): CampaignStartInitialValues {
  return {
    description: p.brief,
    name: p.name,
    plan: p.plan,
    ...(p.ownerTeamId ? { ownerTeamId: p.ownerTeamId } : {}),
    ...(p.recipe
      ? {
          packageName: p.recipe.params.packageName,
          recipeRef: p.recipe.ref,
          targetVersion: p.recipe.params.targetVersion,
        }
      : {}),
    repoIds: p.repoIds,
  };
}

/**
 * A campaign the orchestrator proposed. Everything in it is model output, so it is rendered as
 * plain text only (React text nodes, no HTML). Nothing has started: **Review and start** opens the
 * campaign Start form filled from the proposal, and the person launches it (or not) exactly as
 * they would any campaign. Only the launcher is offered the action; the launch route decides.
 */
export function CampaignProposalRow({
  detail,
  message,
}: {
  detail: OrchestrationDetailDto;
  message: OrchestrationMessageDto;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const parsed = CampaignProposalPayloadSchema.safeParse(message.payload);
  if (!parsed.success) {
    // Withheld from a viewer who cannot reach the repository, or a payload this build cannot read.
    return (
      <section aria-label="Campaign proposal" className={ROW}>
        <span className="font-medium text-paper-200">Campaign proposal</span>
        <p className="mt-1 whitespace-pre-wrap break-words text-paper-400">{message.body}</p>
      </section>
    );
  }
  const p = parsed.data;
  return (
    <section aria-label="Campaign proposal" className={ROW}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-paper-100">Campaign proposal</h3>
        <Badge tone="neutral">Not started</Badge>
        <Badge tone="neutral">{p.plan === 'PLANNED' ? 'Planned' : 'Uniform'}</Badge>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words font-medium text-paper-100">{p.name}</p>
      <p className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-paper-300">
        {p.brief}
      </p>
      {p.recipe && (
        <p className="mt-2 break-words text-paper-300">
          Recipe:{' '}
          <span className="break-all font-mono text-paper-100">
            {p.recipe.ref} {p.recipe.params.packageName} {p.recipe.params.targetVersion}
          </span>
        </p>
      )}
      <p className="mt-2 text-paper-300">
        {p.repoIds.length === 0
          ? 'No repositories named. You choose them in the form.'
          : `${p.repoIds.length} ${p.repoIds.length === 1 ? 'repository' : 'repositories'} named.`}
        {p.droppedRepoCount > 0 &&
          ` ${p.droppedRepoCount} more could not be included because they are not available to you.`}
      </p>
      <p className="mt-2 text-xs text-paper-500">
        This is a proposal. Nothing starts until a person reviews it and starts the campaign.
      </p>
      {detail.canControl && (
        <div className="mt-3">
          <Button onClick={() => setOpen(true)} size="sm" type="button">
            Review and start
          </Button>
          <CampaignStartModal
            initialValues={proposalInitialValues(p)}
            onClose={() => setOpen(false)}
            onStarted={(path) => router.push(path)}
            open={open}
          />
        </div>
      )}
    </section>
  );
}
