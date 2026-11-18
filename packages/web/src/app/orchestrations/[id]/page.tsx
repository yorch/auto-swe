'use client';

import { use, useState } from 'react';
import { AgentsColumn } from '@/components/orchestrations/AgentsColumn';
import { ConversationColumn } from '@/components/orchestrations/ConversationColumn';
import { OrchestrationHeader } from '@/components/orchestrations/OrchestrationHeader';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonDetail } from '@/components/ui/LoadingState';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { useEntityTitle } from '@/hooks/useEntityTitle';
import { useIsNarrow } from '@/hooks/useMediaQuery';
import { useOrchestrationStream } from '@/hooks/useOrchestrationStream';
import { useOrchestration, useOrchestrationMessages } from '@/hooks/useOrchestrations';
import { ApiError } from '@/lib/api';
import { errMsg } from '@/lib/errors';
import { isOrchestrationLive } from '@/lib/orchestration';
import { validateRouteParam } from '@/lib/routeParams';
import { cn } from '@/lib/utils';

type Tab = 'conversation' | 'agents';

function BackLink() {
  return (
    <ButtonLink className="-ml-3" href="/orchestrations" size="sm" variant="ghost">
      <Icon name="arrowLeft" size={14} />
      Orchestrations
    </ButtonLink>
  );
}

function NotFound() {
  return (
    <div className="space-y-6">
      <BackLink />
      <EmptyState
        action={<ButtonLink href="/orchestrations">Back to orchestrations</ButtonLink>}
        bordered
        hint="It may not exist, you may not have access to it, or the link may be wrong."
        icon="agents"
        title="Orchestration not found"
      />
    </div>
  );
}

export default function OrchestrationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const detail = useOrchestration(id ?? '');
  const live = isOrchestrationLive(detail.data?.status);
  const messages = useOrchestrationMessages(id ?? '', live);
  const stream = useOrchestrationStream(id ?? '', !!id && live);
  const narrow = useIsNarrow();
  const [tab, setTab] = useState<Tab>('conversation');
  useEntityTitle(detail.data?.title);

  if (!id) {
    return <NotFound />;
  }
  if (detail.isLoading) {
    return <SkeletonDetail label="orchestration" />;
  }
  const data = detail.data;
  if (!data) {
    if (
      detail.error instanceof ApiError &&
      (detail.error.status === 404 || detail.error.status === 403)
    ) {
      return <NotFound />;
    }
    return (
      <div className="space-y-6">
        <BackLink />
        <Alert
          action={
            <Button onClick={() => void detail.refetch()} size="sm">
              Try again
            </Button>
          }
          title="Could not load this orchestration"
        >
          {errMsg(detail.error, `Could not load orchestration ${id}`)}
        </Alert>
      </div>
    );
  }

  const conversation = (
    <>
      {messages.isError && !messages.data && (
        <Alert
          action={
            <Button onClick={() => void messages.refetch()} size="sm">
              Try again
            </Button>
          }
          title="Could not load the conversation"
        >
          {errMsg(messages.error)}
        </Alert>
      )}
      {messages.isLoading ? (
        <p className="text-sm text-paper-500" role="status">
          Loading the conversation…
        </p>
      ) : (
        <ConversationColumn detail={data} messages={messages.data?.messages ?? []} />
      )}
    </>
  );
  const agents = <AgentsColumn detail={data} />;

  // One tree at every width, so a draft in either column survives a tab switch or a resize:
  // the inactive panel on a narrow screen is hidden, never unmounted.
  return (
    <div className="space-y-6">
      <BackLink />
      <OrchestrationHeader detail={data} stream={stream} />
      {detail.isError && (
        <Alert variant="warning">
          Showing the last data received. Could not refresh: {errMsg(detail.error)}
        </Alert>
      )}
      <div className="space-y-4">
        {narrow && (
          <TabBar
            active={tab}
            ariaLabel="Orchestration sections"
            idPrefix="orch"
            onChange={setTab}
            tabs={[
              { id: 'conversation', label: 'Conversation' },
              { id: 'agents', label: `Agents (${data.children.length})` },
            ]}
          />
        )}
        <div
          className={cn(
            narrow
              ? 'space-y-4'
              : 'grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'
          )}
        >
          <div
            className="min-w-0 space-y-3"
            hidden={narrow && tab !== 'conversation'}
            {...(narrow ? tabPanelProps('orch', 'conversation') : {})}
          >
            {!narrow && <h2 className="text-base font-semibold text-paper-100">Conversation</h2>}
            {conversation}
          </div>
          <div
            className="min-w-0 space-y-3"
            hidden={narrow && tab !== 'agents'}
            {...(narrow ? tabPanelProps('orch', 'agents') : {})}
          >
            {!narrow && <h2 className="text-base font-semibold text-paper-100">Agents</h2>}
            {agents}
          </div>
        </div>
      </div>
    </div>
  );
}
