'use client';

import { isSystemManagedTemplate } from '@auto-swe/shared/lib/channelTask';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AgentRunForm } from '@/components/agentRuns/AgentRunForm';
import { EpicLaunchForm } from '@/components/epics/EpicLaunchForm';
import { WorkflowLaunchForm } from '@/components/requests/WorkflowLaunchForm';
import { SetupBanner } from '@/components/setup/SetupReadiness';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { useHasRole } from '@/hooks/useHasRole';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { requestHref } from '@/lib/requestDisplay';
import { useTeamStore } from '@/stores/teamStore';

type Mode = 'workflow' | 'agent' | 'epic';

export function StartWork({
  initialMode = 'workflow',
  initialTemplateId = '',
}: {
  initialMode?: Mode;
  /** A workflow to preselect, from the library's Run button. */
  initialTemplateId?: string;
}) {
  const router = useRouter();
  // POST /epics requires LEAD, so the option is shown but disabled below that.
  const canStartEpic = useHasRole('LEAD');
  const [mode, setMode] = useState<Mode>(initialMode);
  const [visited, setVisited] = useState<string[]>(initialTemplateId ? [initialTemplateId] : []);
  const [templateId, setTemplateId] = useState(initialTemplateId);
  const teamId = useTeamStore((state) => state.selectedTeamId);
  const templates = useWorkflowTemplates(teamId);
  const runnable = (templates.data ?? []).filter(
    (template) =>
      template.status === 'ACTIVE' &&
      template.activeVersion !== null &&
      !isSystemManagedTemplate(template)
  );
  const template = runnable.find((item) => item.id === templateId);
  const unrunnableTemplate =
    !!initialTemplateId && !templates.isLoading && !templates.isError && !template;
  const onLaunched = (requestId: string) => router.push(requestHref(requestId));
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        actions={
          <ButtonLink href="/workflows" variant="secondary">
            Back to requests
          </ButtonLink>
        }
        subtitle="Choose how to work, enter the details, then review before launching."
        title="Start work"
      />
      <SetupBanner items={['credentials', 'github', 'connections']} />
      {unrunnableTemplate && (
        <Alert variant="warning">
          The workflow you picked is not available to run. It may be inactive, archived or not
          visible to your team. Choose another workflow below.
        </Alert>
      )}
      <RadioGroup
        legend="How do you want to work?"
        name="work-mode"
        onChange={(value) => setMode(value as Mode)}
        options={[
          {
            description: 'Follow a reusable process with defined steps, checks, and approvals.',
            label: 'Run a workflow',
            value: 'workflow',
          },
          {
            description:
              'Give one agent a task on a repository, with explicit execution and delivery limits.',
            label: 'Run an agent',
            value: 'agent',
          },
          {
            description: canStartEpic
              ? 'Change several repositories at once. A planner splits the brief into ordered per-repository work.'
              : 'Needs a team lead or administrator.',
            disabled: !canStartEpic,
            label: 'Run a multi-repo epic',
            value: 'epic',
          },
        ]}
        value={mode}
      />
      <div className="space-y-5" hidden={mode !== 'workflow'}>
        <QueryBoundary
          error={templates.error}
          isError={templates.isError}
          isFetching={templates.isFetching}
          isLoading={templates.isLoading}
          label="workflows"
          onRetry={() => void templates.refetch()}
        >
          {!runnable.length ? (
            <EmptyState
              hint="Ask a lead or administrator to activate a workflow in the library."
              title="No active workflows available"
            />
          ) : (
            <Combobox
              hint={
                template?.description || 'Choose the process that matches the outcome you need.'
              }
              label="Workflow"
              onChange={(id) => {
                setTemplateId(id);
                setVisited((prev) => (prev.includes(id) ? prev : [...prev, id]));
              }}
              options={runnable.map((item) => ({ label: item.name, value: item.id }))}
              placeholder="Find a workflow…"
              value={templateId}
            />
          )}
          {template && (
            <div className="mt-3">
              <ButtonLink href={`/workflows/library/${template.id}`} size="sm">
                View workflow process ↗
              </ButtonLink>
            </div>
          )}
        </QueryBoundary>
        {runnable
          .filter((item) => visited.includes(item.id))
          .map((item) => (
            <div hidden={templateId !== item.id} key={item.id}>
              <WorkflowLaunchForm onLaunched={onLaunched} template={item} />
            </div>
          ))}
      </div>
      <div hidden={mode !== 'agent'}>
        <AgentRunForm onLaunched={onLaunched} reviewBeforeLaunch />
      </div>
      <div hidden={mode !== 'epic'}>
        <EpicLaunchForm onLaunched={(path) => router.push(path)} reviewBeforeLaunch />
      </div>
    </div>
  );
}
