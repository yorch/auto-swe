'use client';

import { isSystemManagedTemplate } from '@auto-swe/shared/lib/channelTask';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { AgentRunForm } from '@/components/agentRuns/AgentRunForm';
import { EpicLaunchForm } from '@/components/epics/EpicLaunchForm';
import { WorkflowLaunchForm } from '@/components/requests/WorkflowLaunchForm';
import { SetupBanner } from '@/components/setup/SetupReadiness';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon, type IconName } from '@/components/ui/Icon';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useHasRole } from '@/hooks/useHasRole';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { requestHref } from '@/lib/requestDisplay';
import { cn } from '@/lib/utils';
import { useTeamStore } from '@/stores/teamStore';

type Mode = 'workflow' | 'agent' | 'epic';

interface ModeOption {
  value: Mode;
  label: string;
  description: string;
  icon: IconName;
  disabled?: boolean;
}

/** What each mode does once launched — the side rail's "what happens next". */
const GUIDE: Record<Mode, { title: string; points: string[] }> = {
  agent: {
    points: [
      'The agent works in an isolated workspace on a copy of the repository.',
      'Step and time limits cap how long it may run.',
      'You choose whether the result stays in the workspace or becomes a branch or draft pull request.',
    ],
    title: 'Running an agent',
  },
  epic: {
    points: [
      'A planner splits your brief into one request per repository.',
      'Requests run in dependency order, each with its own checks.',
      'Each repository gets its own draft pull request to review.',
    ],
    title: 'Running an epic',
  },
  workflow: {
    points: [
      'The workflow runs its steps, checks and approvals in order.',
      'You are asked when a step needs a person.',
      'Any pull request it opens is a draft for you to review.',
    ],
    title: 'Running a workflow',
  },
};

/**
 * The three ways to start work as selectable cards. Native radios in a fieldset keep the
 * group's name, arrow-key movement and the disabled state; the card is the radio's label.
 */
function WorkModePicker({
  onChange,
  options,
  value,
}: {
  onChange: (mode: Mode) => void;
  options: ModeOption[];
  value: Mode;
}) {
  return (
    <fieldset>
      <legend className="sr-only">How do you want to work?</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <label
              className={cn(
                // Mobile: icon | text | check in one row. From sm: icon and check on top, text below.
                'relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 rounded-xl border p-4 transition-colors sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-y-3',
                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ember-400 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-ink-950',
                selected
                  ? 'border-ember-400/70 bg-ember-400/[0.07]'
                  : 'border-ink-400/60 bg-ink-800/60',
                option.disabled
                  ? 'cursor-not-allowed opacity-60'
                  : 'cursor-pointer hover:border-ink-300'
              )}
              key={option.value}
            >
              <input
                checked={selected}
                className="sr-only"
                disabled={option.disabled}
                name="work-mode"
                onChange={() => onChange(option.value)}
                type="radio"
                value={option.value}
              />
              <span
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-lg border',
                  selected
                    ? 'border-ember-400/40 bg-ember-400/15 text-ember-300'
                    : 'border-ink-400 bg-ink-700 text-paper-400'
                )}
              >
                <Icon name={option.icon} size={16} />
              </span>
              <span className="min-w-0 sm:col-span-2 sm:row-start-2">
                <span className="block text-sm font-medium text-paper-100">{option.label}</span>
                <span className="mt-1 block text-xs leading-relaxed text-paper-400">
                  {option.description}
                </span>
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border sm:mt-0 sm:justify-self-end',
                  selected ? 'border-ember-400 bg-ember-500 text-white' : 'border-ink-300'
                )}
              >
                {selected && <Icon name="check" size={10} strokeWidth={3} />}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** A numbered step of the Start work flow. */
function Step({
  children,
  hint,
  number,
  title,
}: {
  children: ReactNode;
  hint?: string;
  number: number;
  title: string;
}) {
  return (
    <section aria-labelledby={`start-step-${number}`} className="space-y-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="tabular mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-ink-400 bg-ink-700 text-xs font-medium text-paper-300"
        >
          {number}
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-paper-100" id={`start-step-${number}`}>
            <span className="sr-only">Step {number}: </span>
            {title}
          </h2>
          {hint && <p className="mt-0.5 text-[13px] text-paper-400">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

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
  const options: ModeOption[] = [
    {
      description: 'Follow a reusable process with defined steps, checks, and approvals.',
      icon: 'workflows',
      label: 'Run a workflow',
      value: 'workflow',
    },
    {
      description:
        'Give one agent a task on a repository, with explicit execution and delivery limits.',
      icon: 'agents',
      label: 'Run an agent',
      value: 'agent',
    },
    {
      description: canStartEpic
        ? 'Change several repositories at once. A planner splits the brief into ordered per-repository work.'
        : 'Needs a team lead or administrator.',
      disabled: !canStartEpic,
      icon: 'epics',
      label: 'Run a multi-repo epic',
      value: 'epic',
    },
  ];
  const guide = GUIDE[mode];
  const detailsStep = mode === 'workflow' ? 3 : 2;
  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <ButtonLink href="/workflows" variant="secondary">
            View requests
          </ButtonLink>
        }
        subtitle="Choose how to work, enter the details, then review before launching."
        title="Start work"
      />
      <div className="grid gap-8 xl:grid-cols-[minmax(0,48rem)_18rem]">
        <div className="min-w-0 space-y-8">
          <SetupBanner items={['credentials', 'github', 'connections']} />
          {unrunnableTemplate && (
            <Alert variant="warning">
              The workflow you picked is not available to run. It may be inactive, archived or not
              visible to your team. Choose another workflow below.
            </Alert>
          )}
          <Step number={1} title="How do you want to work?">
            <WorkModePicker onChange={setMode} options={options} value={mode} />
          </Step>
          <div className="space-y-8" hidden={mode !== 'workflow'}>
            <Step
              hint="Choose the process that matches the outcome you need."
              number={2}
              title="Pick a workflow"
            >
              <Card className="p-5">
                <QueryBoundary
                  error={templates.error}
                  isError={templates.isError}
                  isFetching={templates.isFetching}
                  isLoading={templates.isLoading}
                  label="workflows"
                  loadingMessage="Loading workflows…"
                  onRetry={() => void templates.refetch()}
                >
                  {!runnable.length ? (
                    <EmptyState
                      action={
                        <ButtonLink href="/workflows/library" size="sm">
                          Open the library
                        </ButtonLink>
                      }
                      hint="Ask a lead or administrator to activate a workflow in the library."
                      icon="layers"
                      title="No active workflows available"
                    />
                  ) : (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                      <Combobox
                        className="min-w-0 flex-1"
                        label="Workflow"
                        onChange={(id) => {
                          setTemplateId(id);
                          setVisited((prev) => (prev.includes(id) ? prev : [...prev, id]));
                        }}
                        options={runnable.map((item) => ({ label: item.name, value: item.id }))}
                        placeholder="Find a workflow…"
                        value={templateId}
                      />
                      {template && (
                        <ButtonLink
                          className="sm:mb-px"
                          href={`/workflows/library/${template.id}`}
                          variant="ghost"
                        >
                          View process
                          <Icon name="arrowRight" size={14} />
                        </ButtonLink>
                      )}
                    </div>
                  )}
                  {template?.description && (
                    <p className="mt-3 text-[13px] leading-relaxed text-paper-400">
                      {template.description}
                    </p>
                  )}
                </QueryBoundary>
              </Card>
            </Step>
            {/* Visited forms stay mounted (hidden) so switching workflows keeps what was typed. */}
            <div hidden={!template}>
              <Step number={detailsStep} title="Describe the task">
                {runnable
                  .filter((item) => visited.includes(item.id))
                  .map((item) => (
                    <div hidden={templateId !== item.id} key={item.id}>
                      <WorkflowLaunchForm onLaunched={onLaunched} template={item} />
                    </div>
                  ))}
              </Step>
            </div>
          </div>
          <div hidden={mode !== 'agent'}>
            <Step number={detailsStep} title="Describe the task">
              <AgentRunForm onLaunched={onLaunched} reviewBeforeLaunch />
            </Step>
          </div>
          <div hidden={mode !== 'epic'}>
            <Step number={detailsStep} title="Describe the epic">
              <EpicLaunchForm onLaunched={(path) => router.push(path)} reviewBeforeLaunch />
            </Step>
          </div>
        </div>
        <aside aria-label="What happens next" className="space-y-4 max-xl:hidden">
          <Card className="sticky top-20 p-5" variant="inset">
            <div className="kicker mb-1">What happens next</div>
            <h2 className="text-sm font-semibold text-paper-100">{guide.title}</h2>
            <ul className="mt-3 space-y-2.5">
              {guide.points.map((point) => (
                <li className="flex gap-2 text-[13px] leading-relaxed text-paper-400" key={point}>
                  <Icon className="mt-0.5 text-moss-400" name="check" size={14} />
                  {point}
                </li>
              ))}
            </ul>
            <p className="mt-4 border-t border-ink-600 pt-3 text-xs text-paper-500">
              Nothing is merged automatically. Follow progress from Requests.
            </p>
          </Card>
        </aside>
      </div>
    </div>
  );
}
