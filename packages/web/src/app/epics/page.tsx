'use client';

import { EpicList } from '@/components/epics/EpicList';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useEpics } from '@/hooks/useEpics';
import { useHasRole } from '@/hooks/useHasRole';

export default function EpicsPage() {
  // Launching an epic requires LEAD.
  const canCreate = useHasRole('LEAD');
  const epicsQuery = useEpics();
  const epics = epicsQuery.data?.data ?? [];

  return (
    <div className="space-y-6">
      <ButtonLink className="-ml-3" href="/workflows" size="sm" variant="ghost">
        <Icon name="arrowLeft" size={14} />
        Requests
      </ButtonLink>
      <PageHeader
        actions={
          canCreate &&
          epics.length > 0 && (
            <ButtonLink href="/start?mode=epic" variant="primary">
              <Icon name="plus" size={14} />
              Start an epic
            </ButtonLink>
          )
        }
        help={
          <p>
            An epic <HelpTip term="epic" /> is a change that spans several repositories, split by
            the planner into ordered per-repository work.
          </p>
        }
        subtitle="Changes that span several repositories, split into per-repository work."
        title="Epics"
      />

      <QueryBoundary
        error={epicsQuery.error}
        isError={epicsQuery.isError}
        isFetching={epicsQuery.isFetching}
        isLoading={epicsQuery.isLoading}
        label="epics"
        loading={
          <Card className="px-5 py-3">
            <SkeletonRows rows={5} />
          </Card>
        }
        onRetry={() => void epicsQuery.refetch()}
      >
        {epics.length === 0 ? (
          <EmptyState
            action={
              canCreate ? (
                <ButtonLink href="/start?mode=epic" variant="primary">
                  Start an epic
                </ButtonLink>
              ) : undefined
            }
            bordered
            hint={
              canCreate
                ? 'Describe one change once and the planner fans it out across your repositories. For example: “Migrate auth /v1 to /v2 across 5 services” becomes one run per service, in dependency order, each ending in its own pull request for you to review.'
                : 'A team lead or administrator can start one to fan work out across repositories.'
            }
            icon="epics"
            title="No epics yet"
          />
        ) : (
          <EpicList epics={epics} />
        )}
      </QueryBoundary>
    </div>
  );
}
