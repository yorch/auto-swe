'use client';

import { eventSource } from '@auto-swe/shared/automation';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { outcomeLabel, outcomeTone } from '@/components/automations/AutomationHistory';
import { TeamAutomationsModal } from '@/components/automations/TeamAutomationsModal';
import {
  type AutomationRepository,
  RepoAutomationsModal,
} from '@/components/repositories/RepoAutomationsModal';
import { TeamChip } from '@/components/teams/TeamChip';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { Icon } from '@/components/ui/Icon';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Select } from '@/components/ui/Select';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import {
  type AutomationKind,
  type AutomationSummary,
  useAllAutomations,
} from '@/hooks/useAutomations';
import { useDataTableSort } from '@/hooks/useDataTableSort';
import { useRepositories } from '@/hooks/useRepositories';
import { useSchedules } from '@/hooks/useSchedules';
import { useTeamParam } from '@/hooks/useTeamParam';
import { useTeam } from '@/hooks/useTeams';
import { connectionLabel } from '@/lib/connectionDisplay';
import { HELP_LINKS } from '@/lib/helpLinks';
import { cn, FOCUS_RING } from '@/lib/utils';

const KIND_LABEL: Record<AutomationKind, string> = {
  event: 'Event',
  schedule: 'Schedule',
  template_webhook: 'Template webhook',
  tracker_transition: 'Tracker transition',
};

/** The tone of the last-activity badge for kinds whose activity is a run, not a decision. */
const RUN_TONE: Record<string, BadgeTone> = {
  CANCELLED: 'muted',
  COMPLETED: 'success',
  FAILED: 'danger',
  RUNNING: 'accent2',
  TERMINATED: 'danger',
  TIMED_OUT: 'danger',
};

/**
 * Whether a row's last activity is a decision from the ledger (an event automation's, a
 * schedule fire's, a webhook call's) rather than a run's status (the tracker hook).
 */
function isDecision(row: AutomationSummary): boolean {
  return row.kind !== 'tracker_transition' && row.lastActivity?.outcome !== 'fired';
}

/** A run status as a sentence-case label: `TIMED_OUT` reads "Timed out", not "timed_out". */
function runStatusLabel(status: string): string {
  const words = status.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function activityTone(row: AutomationSummary, outcome: string): BadgeTone {
  return isDecision(row) ? outcomeTone(outcome) : (RUN_TONE[outcome] ?? 'neutral');
}

/** Where an automation of each kind is edited. */
function manageHref(row: AutomationSummary): string | null {
  switch (row.kind) {
    case 'schedule':
      return '/admin/schedules';
    case 'template_webhook':
      return `/library/${row.id}`;
    case 'tracker_transition':
      return '/admin/integrations';
    default:
      return null;
  }
}

const AUTOMATION_SORT_KEYS = {
  // An automation that has never done anything sorts last.
  lastActivity: (r: AutomationSummary) =>
    r.lastActivity ? new Date(r.lastActivity.at).getTime() : null,
  name: (r: AutomationSummary) => r.name.toLowerCase(),
};

/** Pick the repository a new event automation goes on, then open its automations. */
function PickRepository({
  onPick,
  onClose,
}: {
  onPick: (repo: AutomationRepository) => void;
  onClose: () => void;
}) {
  const { data: repos } = useRepositories();
  const [id, setId] = useState('');
  const gitRepos = (repos ?? []).filter((r) => (r.type ?? 'git_repo') === 'git_repo');
  const picked = gitRepos.find((r) => r.id === id);
  return (
    <Modal
      onClose={onClose}
      open
      subtitle="Event automations live on a repository. Pick one; only its owning team’s leads and admins can add one."
      title="Which repository?"
    >
      <Combobox
        emptyMessage="No repositories match"
        label="Repository"
        onChange={setId}
        options={gitRepos.map((r) => ({ label: connectionLabel(r), value: r.id }))}
        placeholder="Select a repository…"
        value={id}
      />
      <ModalFooter
        cancelLabel="Cancel"
        disabled={!picked}
        onCancel={onClose}
        onSubmit={() => {
          if (picked) {
            onPick(picked);
          }
        }}
        submitLabel="Continue"
      />
    </Modal>
  );
}

/**
 * Every automation the caller may see, of every kind (docs/automations.md): event automations
 * on repositories, cron schedules, template webhook URLs and — for admins — the tracker
 * transition hook. Each row says when it fires, what it starts and what it last did, and opens
 * where that kind is edited.
 */
function Automations() {
  const all = useAllAutomations();
  const teamFilter = useTeamParam();
  const teamDetail = useTeam(teamFilter.teamId ?? '');
  const schedules = useSchedules();
  const [kind, setKind] = useState<'all' | AutomationKind>('all');
  const [query, setQuery] = useState('');
  const { onSortChange, sort, sortRows } =
    useDataTableSort<AutomationSummary>(AUTOMATION_SORT_KEYS);
  const [picking, setPicking] = useState(false);
  const [openRepo, setOpenRepo] = useState<AutomationRepository | null>(null);
  const [openTeam, setOpenTeam] = useState<{ id: string; name: string } | null>(null);

  const scheduleRows: AutomationSummary[] = (schedules.data ?? []).map((s) => ({
    canManage: s.canManage,
    // Off when paused, deactivated, or its Temporal schedule is gone; unknown (Temporal not
    // reachable) reads as the stored flag.
    enabled: s.isActive && !s.schedule.paused && s.schedule.exists !== false,
    id: s.id,
    kind: 'schedule',
    // What the latest fire decided, from the ledger; before any is recorded, Temporal's last
    // action, else the database's when Temporal cannot be asked.
    lastActivity: s.lastDecision
      ? s.lastDecision
      : (s.schedule.lastRunAt ?? s.lastFiredAt)
        ? { at: (s.schedule.lastRunAt ?? s.lastFiredAt) as string, outcome: 'fired' }
        : null,
    name: s.name,
    repository: s.repository,
    team: s.team,
    template: s.template,
    when: `On a schedule: ${s.cronExpression} (UTC)`,
  }));
  const rows = [...(all.data ?? []), ...scheduleRows];
  const needle = query.trim().toLowerCase();
  // `?team=<slug>` keeps the team's own automations: those it owns, those on a repository it
  // owns and, read-only, those on a repository another team shared with it (the same list scope
  // as every other `?team=` page). Which repositories those are comes from the team's detail, so
  // the rows wait for it rather than showing the team-level ones alone.
  const teamRepoIds = new Set((teamDetail.data?.repositories ?? []).map((r) => r.id));
  const sharedRepoIds = new Set((teamDetail.data?.sharedRepositories ?? []).map((r) => r.id));
  const teamDetailPending = !!teamFilter.team && teamDetail.isLoading;
  const teamDetailFailed = !!teamFilter.team && teamDetail.isError;
  const shown = rows
    .filter(
      (r) =>
        (!teamFilter.team ||
          r.team?.id === teamFilter.team.id ||
          (!!r.repository &&
            (teamRepoIds.has(r.repository.id) || sharedRepoIds.has(r.repository.id)))) &&
        (kind === 'all' || r.kind === kind) &&
        (!needle ||
          [
            r.name,
            r.when,
            r.repository ? `${r.repository.organizationName}/${r.repository.repoName}` : '',
            r.template?.name ?? '',
            r.team?.name ?? '',
          ].some((t) => t.toLowerCase().includes(needle)))
    )
    // A repository shared into the team is the owner's to manage: the row opens read-only.
    .map((r) =>
      teamFilter.team &&
      r.canManage &&
      r.team?.id !== teamFilter.team.id &&
      r.repository &&
      !teamRepoIds.has(r.repository.id) &&
      sharedRepoIds.has(r.repository.id)
        ? { ...r, canManage: false }
        : r
    );
  // From the row itself: the repository list is active-only and capped, and an automation on a
  // deactivated or far-down repository must still open.
  const repoOf = (r: AutomationSummary): AutomationRepository | undefined =>
    r.repository ? { ...r.repository, name: null, type: 'git_repo' } : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => setPicking(true)} variant="primary">
              <Icon name="plus" size={14} />
              New event automation
            </Button>
            <ButtonLink href="/admin/schedules" variant="secondary">
              Schedules
            </ButtonLink>
          </div>
        }
        help={
          <p>
            This page lists rules that react to events on a repository (such as a failed CI run),
            cron schedules, template webhook URLs and the issue-tracker hook. Each says when it
            fires, what it starts and what it last did.
          </p>
        }
        learnMore={{ ...HELP_LINKS.automations, label: 'About automations' }}
        subtitle="Everything that starts a run without a person pressing run."
        title="Automations"
      />
      <TeamChip onRemove={teamFilter.clear} team={teamFilter.team} />
      <p className="max-w-3xl text-sm leading-relaxed text-paper-400">
        Event automations are limited by a cooldown and a daily cap{' '}
        <HelpTip label="automations">
          The cooldown is the minimum time between runs for the same branch or other scope; the
          daily cap is the most runs one automation starts in 24 hours. The first matching
          automation decides, and records a decision: started, or suppressed with the reason. Events
          that no automation matches, and events that arrive while the kill switch is off, are
          ignored and not recorded. Schedules and webhooks follow their own rules.
        </HelpTip>
        .
      </p>
      <Card>
        <QueryBoundary
          error={
            teamFilter.isError ? new Error('team lookup failed') : (all.error ?? teamDetail.error)
          }
          isError={teamFilter.isError || all.isError || teamDetailFailed}
          isFetching={all.isFetching || schedules.isFetching || teamDetail.isFetching}
          isLoading={
            teamFilter.pending || all.isLoading || schedules.isLoading || teamDetailPending
          }
          label="automations"
          onRetry={() => {
            teamFilter.retry();
            void all.refetch();
            void schedules.refetch();
            if (teamDetailFailed) {
              void teamDetail.refetch();
            }
          }}
        >
          {/* Schedules come from a separate list that some callers may not read. Without it the
              event automations still show, and the page says the picture is partial. */}
          {schedules.isError && (
            <Alert
              action={
                <Button onClick={() => void schedules.refetch()} size="sm">
                  Retry
                </Button>
              }
              className="mb-3"
              variant="warning"
            >
              Schedules could not be loaded, so none are listed here. Other automations are shown.
            </Alert>
          )}
          {rows.length === 0 ? (
            <EmptyState
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button onClick={() => setPicking(true)} size="sm" variant="primary">
                    New event automation
                  </Button>
                  <ButtonLink href="/admin/schedules" size="sm" variant="secondary">
                    Create a schedule
                  </ButtonLink>
                  <ButtonLink href="/library" size="sm" variant="secondary">
                    Template webhooks
                  </ButtonLink>
                </div>
              }
              hint="React to a failed CI run on a repository, run a template on a schedule, or give a template a webhook URL."
              icon="clock"
              title="No automations yet"
            />
          ) : (
            <>
              <Toolbar
                end={
                  <span className="text-paper-500 text-xs tabular-nums">
                    {shown.length} of {rows.length}
                  </span>
                }
              >
                <SearchInput
                  label="Search automations"
                  onChange={setQuery}
                  placeholder="Search automations…"
                  value={query}
                />
                <Select
                  compact
                  label="Kind"
                  onChange={(v) => setKind(v as 'all' | AutomationKind)}
                  options={[
                    { label: 'All kinds', value: 'all' },
                    ...(Object.keys(KIND_LABEL) as AutomationKind[]).map((k) => ({
                      label: KIND_LABEL[k],
                      value: k,
                    })),
                  ]}
                  value={kind}
                />
              </Toolbar>
              {shown.length === 0 ? (
                <EmptyState icon="search" title="No automations match" />
              ) : (
                <div className="-mx-4">
                  <DataTable
                    actions={(r) => {
                      const href = manageHref(r);
                      const repo = repoOf(r);
                      return r.kind === 'event' && repo ? (
                        <Button onClick={() => setOpenRepo(repo)} size="sm" variant="ghost">
                          {r.canManage ? 'Manage' : 'View'}
                        </Button>
                      ) : r.kind === 'event' && r.team ? (
                        // An automation with no repository belongs to its team.
                        <Button onClick={() => setOpenTeam(r.team)} size="sm" variant="ghost">
                          {r.canManage ? 'Manage' : 'View'}
                        </Button>
                      ) : href ? (
                        <Link
                          className={cn(
                            'rounded-sm text-sm text-paper-100 underline-offset-2 hover:underline focus-visible:underline',
                            FOCUS_RING
                          )}
                          href={href}
                        >
                          {r.canManage ? 'Manage' : 'View'}
                        </Link>
                      ) : null;
                    }}
                    className="max-sm:px-4"
                    columns={[
                      {
                        cell: (r) => r.name,
                        header: 'Name',
                        id: 'name',
                        primary: true,
                        secondary: (r) => (
                          <>
                            <div className="flex flex-wrap gap-1.5">
                              <Badge tone="neutral" variant="outline">
                                {KIND_LABEL[r.kind]}
                              </Badge>
                              {!r.enabled && (
                                <Badge tone="warning" variant="outline">
                                  Off
                                </Badge>
                              )}
                              {r.kind === 'template_webhook' && !r.signatureRequired && (
                                <Badge tone="warning" variant="outline">
                                  {r.signed ? 'Signature optional' : 'Unsigned'}
                                </Badge>
                              )}
                            </div>
                            {r.kind === 'template_webhook' && !r.signatureRequired && (
                              <p className="mt-1 text-xs text-paper-400">
                                {r.signed
                                  ? 'Signed calls are checked, but unsigned calls are still accepted.'
                                  : 'Anyone holding the URL can call it: there is no signing secret.'}
                              </p>
                            )}
                          </>
                        ),
                        sortable: true,
                      },
                      {
                        cell: (r) => <span className="text-paper-300 text-xs">{r.when}</span>,
                        header: 'When',
                        id: 'when',
                      },
                      {
                        cell: (r) =>
                          r.repository
                            ? `${r.repository.organizationName}/${r.repository.repoName}`
                            : (r.team?.name ?? 'Platform'),
                        header: 'On',
                        id: 'on',
                      },
                      {
                        cell: (r) =>
                          r.template?.name ??
                          (r.kind === 'event' && r.source
                            ? `${eventSource(r.source)?.defaultTemplate?.name ?? '—'} (default)`
                            : r.kind === 'tracker_transition'
                              ? 'the team’s default template'
                              : '—'),
                        header: 'Starts',
                        id: 'starts',
                      },
                      {
                        cell: (r) =>
                          r.lastActivity ? (
                            <span className="flex flex-col gap-1">
                              <span className="flex items-center gap-2">
                                <Badge
                                  tone={activityTone(r, r.lastActivity.outcome)}
                                  variant="outline"
                                >
                                  {isDecision(r)
                                    ? outcomeLabel(r.lastActivity.outcome)
                                    : runStatusLabel(r.lastActivity.outcome)}
                                </Badge>
                                <RelativeTime
                                  className="text-paper-500"
                                  value={r.lastActivity.at}
                                />
                              </span>
                              {/* Why it was suppressed or failed: the point of this ledger. */}
                              {r.lastActivity.reason && (
                                <span className="max-w-xs break-words text-xs text-paper-400">
                                  {r.lastActivity.reason}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-paper-600">—</span>
                          ),
                        header: 'Last activity',
                        id: 'lastActivity',
                        sortable: true,
                      },
                    ]}
                    getRowId={(r) => `${r.kind}:${r.id}`}
                    onSortChange={onSortChange}
                    revealActions={false}
                    rows={sortRows(shown)}
                    sort={sort}
                  />
                </div>
              )}
            </>
          )}
        </QueryBoundary>
      </Card>
      {picking && (
        <PickRepository
          onClose={() => setPicking(false)}
          onPick={(repo) => {
            setPicking(false);
            setOpenRepo(repo);
          }}
        />
      )}
      {openRepo && <RepoAutomationsModal onClose={() => setOpenRepo(null)} repo={openRepo} />}
      {openTeam && <TeamAutomationsModal onClose={() => setOpenTeam(null)} team={openTeam} />}
    </div>
  );
}

export default function GovernAutomationsPage() {
  return (
    <Suspense>
      <Automations />
    </Suspense>
  );
}
