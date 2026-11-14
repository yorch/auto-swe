'use client';

import { handLaunchBlock } from '@auto-swe/shared/lib/channelTask';
import { workflowPresentation } from '@auto-swe/shared/lib/workflowCatalog';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { AgentRunForm } from '@/components/agentRuns/AgentRunForm';
import { EpicLaunchForm } from '@/components/epics/EpicLaunchForm';
import { HowItWorks } from '@/components/help/HowItWorks';
import { PrdRunLaunchForm } from '@/components/prdRuns/PrdRunLaunchForm';
import { ModeChooser } from '@/components/requests/ModeChooser';
import { StartScopeProvider, type StartScopeValue } from '@/components/requests/StartScope';
import { WorkflowLaunchForm } from '@/components/requests/WorkflowLaunchForm';
import { WorkflowLaunchSummary } from '@/components/requests/WorkflowLaunchSummary';
import {
  defaultWorkflow,
  runnableWorkflows,
  workflowPickerSections,
} from '@/components/requests/workflowPicker';
import { workflowGuide } from '@/components/requests/workflowProcess';
import { SetupBanner } from '@/components/setup/SetupReadiness';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon, type IconName } from '@/components/ui/Icon';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useTeams } from '@/hooks/useTeams';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { useWorkflowProcess } from '@/hooks/useWorkflowProcess';
import { HELP_LINKS } from '@/lib/helpLinks';
import { requestHref } from '@/lib/requestDisplay';
import { hasRole } from '@/lib/roles';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

type Mode = 'workflow' | 'agent' | 'epic' | 'prd';

interface ModeOption {
  value: Mode;
  label: string;
  description: string;
  icon: IconName;
  disabled?: boolean;
}

/** What each mode does once launched — the side rail's "what happens next". */
const GUIDE: Record<Exclude<Mode, 'workflow'>, { title: string; points: string[] }> = {
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
      'A planner splits your brief into one run per repository.',
      'Requests run in dependency order, each with its own checks.',
      'Each repository gets its own pull request to review.',
    ],
    title: 'Running an epic',
  },
  prd: {
    points: [
      'An agent analyses the PRD and you review the analysis.',
      'It is decomposed into epics and stories, and you approve the breakdown.',
      'Tickets are created and each story becomes a work request on its repository.',
    ],
    title: 'Running a PRD',
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
      <div className="grid gap-2 sm:grid-cols-2 sm:gap-3 xl:grid-cols-4">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <label
              className={cn(
                // Mobile: icon | text | check in one row. From sm: icon and check on top, text below.
                'relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 rounded-xl border p-3 transition-colors sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-y-3 sm:p-4',
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400',
                selected
                  ? 'border-accent-400/70 bg-accent-400/[0.07]'
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
                    ? 'border-accent-400/40 bg-accent-400/15 text-accent-300'
                    : 'border-ink-400 bg-ink-700 text-paper-400'
                )}
              >
                <Icon name={option.icon} size={16} />
              </span>
              <span className="min-w-0 sm:col-span-2 sm:row-start-2">
                <span className="block text-sm font-medium text-paper-100">{option.label}</span>
                <span className="mt-0.5 block truncate text-xs leading-relaxed text-paper-400 sm:mt-1 sm:whitespace-normal">
                  {option.description}
                </span>
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border sm:mt-0 sm:justify-self-end',
                  selected ? 'border-accent-400 bg-accent-500 text-white' : 'border-ink-300'
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
          {hint && <p className="mt-0.5 text-sm text-paper-400">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

const BASE_EPIC_REASON = 'Requires team lead or administrator.';

/**
 * Whether the caller may start an epic, and why not. POST /epics needs a platform LEAD, and on
 * top of that the caller must lead the team that owns each repository the epic spans (their
 * `myRole`). Under a team scope that is that team; without one, any team they lead — the form
 * then lists only repositories of the teams they lead.
 */
function epicAccess(
  platformRole: string | null | undefined,
  memberTeams: { id: string; name: string; myRole: string | null }[] | undefined,
  scopeTeam: { id: string; name: string } | null
): { allowed: boolean; reason: string; epicTeamIds: StartScopeValue['epicTeamIds'] } {
  const base = BASE_EPIC_REASON;
  if (hasRole(platformRole, 'ADMIN')) {
    return { allowed: true, epicTeamIds: 'all', reason: '' };
  }
  if (!hasRole(platformRole, 'LEAD')) {
    return { allowed: false, epicTeamIds: new Set(), reason: base };
  }
  if (!memberTeams) {
    return { allowed: false, epicTeamIds: null, reason: base };
  }
  const led = new Set(memberTeams.filter((t) => hasRole(t.myRole, 'LEAD')).map((t) => t.id));
  if (scopeTeam) {
    return led.has(scopeTeam.id)
      ? { allowed: true, epicTeamIds: led, reason: '' }
      : {
          allowed: false,
          epicTeamIds: led,
          reason: `Requires lead of ${scopeTeam.name}, the team this work is for. You are not its lead.`,
        };
  }
  return led.size > 0
    ? { allowed: true, epicTeamIds: led, reason: '' }
    : {
        allowed: false,
        epicTeamIds: led,
        reason: 'Requires lead of the team that owns the repositories. You do not lead a team.',
      };
}

export function StartWork({
  initialMode = 'workflow',
  initialTemplateId = '',
  initialTeamSlug = '',
}: {
  initialMode?: Mode;
  /** A workflow to preselect, from the library's Run button. */
  initialTemplateId?: string;
  /** The team the work is for (`?team=`); resolved through the caller's own teams. */
  initialTeamSlug?: string;
}) {
  const router = useRouter();
  const platformRole = useAuthStore((state) => state.user?.role);
  const memberTeams = useTeams({ memberOnly: true });
  const scopeTeam =
    (initialTeamSlug && memberTeams.data?.find((t) => t.slug === initialTeamSlug)) || null;
  const epic = epicAccess(platformRole, memberTeams.data, scopeTeam);
  const canStartEpic = epic.allowed;
  const scope: StartScopeValue = {
    epicTeamIds: epic.epicTeamIds,
    team: scopeTeam ? { id: scopeTeam.id, name: scopeTeam.name } : null,
  };
  const [mode, setMode] = useState<Mode>(initialMode);
  const [visited, setVisited] = useState<string[]>(initialTemplateId ? [initialTemplateId] : []);
  const [chosenTemplateId, setTemplateId] = useState(initialTemplateId);
  // With a `?team=` slug the templates wait for the team list, and stay unloaded when it failed,
  // so neither a flash of "no workflows" nor the all-teams list stands in for the team's.
  const teamsPending = !!initialTeamSlug && memberTeams.isLoading;
  const teamsFailed = !!initialTeamSlug && memberTeams.isError;
  const templates = useWorkflowTemplates(null, {
    enabled: !teamsPending && !teamsFailed,
  });
  const runnable = runnableWorkflows(
    teamsPending || teamsFailed ? [] : (templates.data ?? []),
    scopeTeam?.id ?? null
  );
  const templateId = chosenTemplateId || defaultWorkflow(runnable, scopeTeam?.id ?? null)?.id || '';
  const sections = workflowPickerSections(runnable).map((section) => ({
    id: section.id,
    label: section.label,
    options: section.templates.map((item) => {
      const { title } = workflowPresentation(item);
      return {
        description: <span className="block truncate">{item.description}</span>,
        label: (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{title}</span>
            {item.isDefault && <Badge tone="accent">Default</Badge>}
            {item.team && <Badge tone="neutral">{item.team.name}</Badge>}
          </span>
        ),
        searchText: `${title} ${item.name}`,
        textValue: title,
        value: item.id,
      };
    }),
  }));
  const template = runnable.find((item) => item.id === templateId);
  const { summary } = useWorkflowProcess(mode === 'workflow' ? (template?.id ?? '') : '');
  const workflowRail = workflowGuide(summary, template?.workspaceProvider);
  const unrunnableTemplate =
    !!initialTemplateId &&
    !teamsPending &&
    !teamsFailed &&
    !templates.isLoading &&
    !templates.isError &&
    !template;
  const onLaunched = (requestId: string) => router.push(requestHref(requestId));
  const options: ModeOption[] = [
    {
      description: 'A reusable process with checks.',
      icon: 'workflows',
      label: 'Run a workflow',
      value: 'workflow',
    },
    {
      description: 'One focused task on one repository.',
      icon: 'agents',
      label: 'Run an agent',
      value: 'agent',
    },
    {
      description: canStartEpic ? 'Coordinated work across repositories.' : epic.reason,
      disabled: !canStartEpic,
      icon: 'epics',
      label: 'Run a multi-repo epic',
      value: 'epic',
    },
    {
      // POST /prd-runs takes the same decision as an epic: team lead on every repository's owner.
      description: canStartEpic ? 'Break a product requirements doc into stories.' : epic.reason,
      disabled: !canStartEpic,
      icon: 'docs',
      label: 'Run from a PRD',
      value: 'prd',
    },
  ];
  const guide = mode === 'workflow' ? workflowRail : GUIDE[mode];
  const detailsStep = mode === 'workflow' ? 3 : 2;
  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <ButtonLink href="/requests" variant="secondary">
            View requests
          </ButtonLink>
        }
        learnMore={{ ...HELP_LINKS.concepts, label: 'What happens after you start work' }}
        subtitle="Choose how to work, enter the details, then review before launching."
        title="Start work"
      />
      {scopeTeam && (
        <p className="text-sm text-paper-400" data-testid="start-scope">
          Starting work for <span className="font-medium text-paper-100">{scopeTeam.name}</span>.
          Work on a repository runs under the team that owns it.
        </p>
      )}
      <HowItWorks />
      <StartScopeProvider value={scope}>
        <div className="grid gap-8 xl:grid-cols-[minmax(0,48rem)_18rem]">
          <div className="min-w-0 space-y-5 sm:space-y-8">
            <SetupBanner compact items={['credentials', 'github', 'connections']} />
            {unrunnableTemplate && (
              <Alert variant="warning">
                The workflow you picked is not available to run.{' '}
                {
                  handLaunchBlock(
                    templates.data?.find((item) => item.id === initialTemplateId) ?? {
                      name: '',
                      team: null,
                    }
                  )?.reason
                }{' '}
                It may be inactive, archived or not visible to your team. Choose another workflow
                below.
              </Alert>
            )}
            <Step number={1} title="How do you want to work?">
              <WorkModePicker onChange={setMode} options={options} value={mode} />
              <details className="rounded-lg border border-ink-500/70 p-3">
                <summary className="cursor-pointer text-sm text-paper-400">
                  Need help choosing?
                </summary>
                <div className="mt-3">
                  <ModeChooser
                    canStartEpic={canStartEpic}
                    current={mode}
                    epicReason={epic.reason === BASE_EPIC_REASON ? undefined : epic.reason}
                    onChoose={setMode}
                  />
                </div>
              </details>
            </Step>
            <div className="space-y-8" hidden={mode !== 'workflow'}>
              <Step
                hint="Choose the process that matches the outcome you need."
                number={2}
                title="Pick a workflow"
              >
                <Card className="p-5">
                  <QueryBoundary
                    error={teamsFailed ? memberTeams.error : templates.error}
                    isError={teamsFailed || templates.isError}
                    isFetching={teamsFailed ? memberTeams.isFetching : templates.isFetching}
                    isLoading={teamsPending || templates.isLoading}
                    label="workflows"
                    onRetry={() => void (teamsFailed ? memberTeams.refetch() : templates.refetch())}
                  >
                    {!runnable.length ? (
                      <EmptyState
                        action={
                          <ButtonLink href="/library" size="sm">
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
                            setVisited((prev) => [...new Set([...prev, templateId, id])]);
                          }}
                          placeholder="Find a workflow…"
                          sections={sections}
                          value={templateId}
                        />
                        {template && (
                          <ButtonLink
                            className="sm:mb-px"
                            href={`/library/${template.id}`}
                            variant="ghost"
                          >
                            View process
                            <Icon name="arrowRight" size={14} />
                          </ButtonLink>
                        )}
                      </div>
                    )}
                    {template?.description && (
                      <p className="mt-3 text-sm leading-relaxed text-paper-400">
                        {template.description}
                      </p>
                    )}
                    {template && (
                      <div className="mt-4">
                        <WorkflowLaunchSummary templateId={template.id} />
                      </div>
                    )}
                  </QueryBoundary>
                </Card>
              </Step>
              {/* Visited forms stay mounted (hidden) so switching workflows keeps what was typed. */}
              <div hidden={!template}>
                <Step number={detailsStep} title="Describe the task">
                  {runnable
                    .filter((item) => item.id === templateId || visited.includes(item.id))
                    .map((item) => (
                      <div hidden={templateId !== item.id} key={item.id}>
                        <WorkflowLaunchForm
                          onLaunched={onLaunched}
                          showProcessSummary={false}
                          template={item}
                        />
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
            <div hidden={mode !== 'prd'}>
              <Step number={detailsStep} title="Describe the PRD">
                <PrdRunLaunchForm reviewBeforeLaunch />
              </Step>
            </div>
          </div>
          <aside
            aria-label="What happens next"
            className="space-y-4 xl:sticky xl:top-6 xl:self-start"
          >
            <Card className="p-5" variant="inset">
              <h2 className="text-sm font-semibold text-paper-100">{guide.title}</h2>
              <ul className="mt-3 space-y-2.5">
                {guide.points.map((point) => (
                  <li className="flex gap-2 text-sm leading-relaxed text-paper-400" key={point}>
                    <Icon className="mt-0.5 text-success-400" name="check" size={14} />
                    {point}
                  </li>
                ))}
              </ul>
              {(mode !== 'workflow' || workflowRail.producesPr) && (
                <p className="mt-4 border-t border-ink-600 pt-3 text-xs text-paper-500">
                  No built-in step or template merges a pull request. Follow progress from Requests.
                </p>
              )}
            </Card>
          </aside>
        </div>
      </StartScopeProvider>
    </div>
  );
}
