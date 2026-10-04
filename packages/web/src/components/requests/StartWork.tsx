'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AgentRunForm } from '@/components/agentRuns/AgentRunForm';
import { WorkflowLaunchForm } from '@/components/requests/WorkflowLaunchForm';
import { ButtonLink } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { requestHref } from '@/lib/requestDisplay';
import { useTeamStore } from '@/stores/teamStore';

export function StartWork({ initialMode = 'workflow' }: { initialMode?: 'workflow' | 'agent' }) {
  const router = useRouter();
  const [mode, setMode] = useState<'workflow' | 'agent'>(initialMode);
  const [visited, setVisited] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState('');
  const teamId = useTeamStore((state) => state.selectedTeamId);
  const templates = useWorkflowTemplates(teamId);
  const runnable = (templates.data ?? []).filter(
    (template) => template.status === 'ACTIVE' && template.activeVersion !== null
  );
  const template = runnable.find((item) => item.id === templateId);
  const onLaunched = (requestId: string) => router.push(requestHref(requestId));
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        actions={
          <ButtonLink href="/workflows" variant="ghost">
            Back to requests
          </ButtonLink>
        }
        subtitle="Choose how to work, enter the details, then review before launching."
        title="Start work"
      />
      <RadioGroup
        legend="How do you want to work?"
        name="work-mode"
        onChange={(value) => setMode(value as 'workflow' | 'agent')}
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
        ]}
        value={mode}
      />
      <div className="space-y-5" hidden={mode !== 'workflow'}>
        <QueryBoundary
          error={templates.error}
          isError={templates.isError}
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
    </div>
  );
}
