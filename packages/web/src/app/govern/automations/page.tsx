'use client';

import { EVENT_SOURCE_KEYS, eventSource } from '@auto-swe/shared/automation';
import type { RepositorySummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { outcomeLabel, outcomeTone } from '@/components/automations/AutomationHistory';
import { RepoAutomationsModal } from '@/components/repositories/RepoAutomationsModal';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import {
  type AutomationKind,
  type AutomationSummary,
  useAllAutomations,
} from '@/hooks/useAutomations';
import { useRepositories } from '@/hooks/useRepositories';
import { useSchedules } from '@/hooks/useSchedules';
import { connectionLabel } from '@/lib/connectionDisplay';

const KIND_LABEL: Record<AutomationKind, string> = {
  event: 'Event',
  schedule: 'Schedule',
  template_webhook: 'Template webhook',
  tracker_transition: 'Tracker transition',
};

/** Where an automation of each kind is edited. */
function manageHref(row: AutomationSummary): string | null {
  switch (row.kind) {
    case 'schedule':
      return '/govern/schedules';
    case 'template_webhook':
      return `/workflows/library/${row.id}`;
    case 'tracker_transition':
      return '/studio/integrations';
    default:
      return null;
  }
}

/** Pick the repository a new event automation goes on, then open its automations. */
function PickRepository({
  onPick,
  onClose,
}: {
  onPick: (repo: RepositorySummary) => void;
  onClose: () => void;
}) {
  const { data: repos } = useRepositories();
  const [id, setId] = useState('');
  const gitRepos = (repos ?? []).filter((r) => (r.type ?? 'git_repo') === 'git_repo');
  const picked = gitRepos.find((r) => r.id === id);
  return (
    <Modal
      eyebrow="New automation"
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
export default function GovernAutomationsPage() {
  const all = useAllAutomations();
  const schedules = useSchedules();
  const { data: repos } = useRepositories();
  const [kind, setKind] = useState<'all' | AutomationKind>('all');
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(false);
  const [openRepo, setOpenRepo] = useState<RepositorySummary | null>(null);

  const scheduleRows: AutomationSummary[] = (schedules.data ?? []).map((s) => ({
    canManage: s.canManage,
    enabled: s.isActive && !s.schedule.paused,
    id: s.id,
    kind: 'schedule',
    lastActivity: s.schedule.lastRunAt ? { at: s.schedule.lastRunAt, outcome: 'fired' } : null,
    name: s.name,
    repository: s.repository,
    team: s.team,
    template: s.template,
    when: `On a schedule: ${s.cronExpression} (UTC)`,
  }));
  const rows = [...(all.data ?? []), ...scheduleRows];
  const needle = query.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (kind === 'all' || r.kind === kind) &&
      (!needle ||
        [
          r.name,
          r.when,
          r.repository ? `${r.repository.organizationName}/${r.repository.repoName}` : '',
          r.template?.name ?? '',
          r.team?.name ?? '',
        ].some((t) => t.toLowerCase().includes(needle)))
  );
  const repoOf = (r: AutomationSummary) =>
    r.repository ? (repos ?? []).find((x) => x.id === r.repository?.id) : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            {EVENT_SOURCE_KEYS.map((key) => (
              <Button key={key} onClick={() => setPicking(true)} variant="primary">
                <Icon name="plus" size={14} />
                {eventSource(key)?.label ?? key}
              </Button>
            ))}
            <Link
              className="inline-flex items-center rounded-md border border-ink-500 px-3 py-1.5 text-paper-200 text-sm hover:bg-ink-800"
              href="/govern/schedules"
            >
              Schedules
            </Link>
          </div>
        }
        subtitle="Everything that starts a run without a person pressing run: rules that react to events on a repository, such as a failed CI run, cron schedules, template webhook URLs and the issue-tracker hook. Each says when it fires, what it starts and what it last did."
        title="Automations"
      />
      <Card>
        <QueryBoundary
          error={all.error ?? schedules.error}
          isError={all.isError || schedules.isError}
          isFetching={all.isFetching || schedules.isFetching}
          isLoading={all.isLoading || schedules.isLoading}
          label="automations"
          onRetry={() => {
            void all.refetch();
            void schedules.refetch();
          }}
        >
          {rows.length === 0 ? (
            <EmptyState
              hint="React to a failed CI run on a repository, or run a template on a schedule."
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
                  <Table className="max-sm:px-4" stacked>
                    <THead>
                      <Th variant="plain">Name</Th>
                      <Th variant="plain">When</Th>
                      <Th variant="plain">On</Th>
                      <Th variant="plain">Starts</Th>
                      <Th variant="plain">Last activity</Th>
                      <Th variant="plain">
                        <span className="sr-only">Actions</span>
                      </Th>
                    </THead>
                    <tbody>
                      {shown.map((r) => {
                        const href = manageHref(r);
                        const repo = repoOf(r);
                        return (
                          <TRow key={`${r.kind}:${r.id}`}>
                            <Td label="Name">
                              <div className="font-medium text-paper-100">{r.name}</div>
                              <div className="mt-0.5 flex flex-wrap gap-1.5">
                                <Badge tone="neutral" variant="outline">
                                  {KIND_LABEL[r.kind]}
                                </Badge>
                                {!r.enabled && (
                                  <Badge tone="amber" variant="outline">
                                    off
                                  </Badge>
                                )}
                              </div>
                            </Td>
                            <Td label="When">
                              <span className="text-paper-300 text-xs">{r.when}</span>
                            </Td>
                            <Td label="On">
                              {r.repository
                                ? `${r.repository.organizationName}/${r.repository.repoName}`
                                : (r.team?.name ?? 'Platform')}
                            </Td>
                            <Td label="Starts">
                              {r.template?.name ??
                                (r.kind === 'event' && r.source
                                  ? `${eventSource(r.source)?.defaultTemplate.name ?? '—'} (default)`
                                  : r.kind === 'tracker_transition'
                                    ? 'the team’s default template'
                                    : '—')}
                            </Td>
                            <Td label="Last activity">
                              {r.lastActivity ? (
                                <span className="flex items-center gap-2">
                                  <Badge
                                    tone={outcomeTone(r.lastActivity.outcome)}
                                    variant="outline"
                                  >
                                    {r.kind === 'event'
                                      ? outcomeLabel(r.lastActivity.outcome)
                                      : r.lastActivity.outcome.toLowerCase()}
                                  </Badge>
                                  <RelativeTime
                                    className="text-paper-500"
                                    value={r.lastActivity.at}
                                  />
                                </span>
                              ) : (
                                <span className="text-paper-600">—</span>
                              )}
                            </Td>
                            <Td label="Actions">
                              {r.kind === 'event' && repo ? (
                                <Button onClick={() => setOpenRepo(repo)} size="sm" variant="ghost">
                                  {r.canManage ? 'Manage' : 'View'}
                                </Button>
                              ) : href ? (
                                <Link
                                  className="text-ember-400 text-sm hover:underline"
                                  href={href}
                                >
                                  {r.canManage ? 'Manage' : 'View'}
                                </Link>
                              ) : null}
                            </Td>
                          </TRow>
                        );
                      })}
                    </tbody>
                  </Table>
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
    </div>
  );
}
