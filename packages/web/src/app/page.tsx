'use client';

import { useMemo, useState } from 'react';
import { WorkflowStatusChart } from '@/components/charts/WorkflowStatusChart';
import { WorkflowsByRepoChart } from '@/components/charts/WorkflowsByRepoChart';
import { WorkflowsOverTimeChart } from '@/components/charts/WorkflowsOverTimeChart';
import { DashboardOnboarding } from '@/components/dashboard/DashboardOnboarding';
import { SubmitWorkRequestModal } from '@/components/dashboard/SubmitWorkRequestModal';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { Stat } from '@/components/ui/Stat';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useRepositories, useWorkflows } from '@/hooks/useWorkflows';
import {
  groupWorkflowsByDate,
  groupWorkflowsByRepo,
  groupWorkflowsByStatus,
} from '@/lib/chartUtils';
import { formatRelativeTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

export default function DashboardPage() {
  const { data: workflows, isLoading } = useWorkflows();
  const { data: repos, isLoading: reposLoading } = useRepositories();
  const role = useAuthStore((s) => s.user?.role ?? 'ENGINEER');
  const [submitOpen, setSubmitOpen] = useState(false);
  const canSubmit = (repos ?? []).length > 0;

  const all = workflows ?? [];
  const active = all.filter((w) => !['COMPLETED', 'FAILED', 'TIMED_OUT'].includes(w.currentStatus));
  const completed = all.filter((w) => w.currentStatus === 'COMPLETED');
  const failed = all.filter((w) => w.currentStatus === 'FAILED');
  const needsAttention = all.filter((w) =>
    ['AWAITING_HUMAN_MERGE', 'FAILED'].includes(w.currentStatus)
  );

  const statusData = useMemo(() => groupWorkflowsByStatus(all), [all]);
  const timeData = useMemo(() => groupWorkflowsByDate(all), [all]);
  const repoData = useMemo(() => groupWorkflowsByRepo(all), [all]);

  if (isLoading || reposLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.2em] text-paper-500">
          <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-ember-400" />
          loading telemetry…
        </div>
      </div>
    );
  }

  if (all.length === 0) {
    return (
      <>
        <DashboardOnboarding onSubmit={() => setSubmitOpen(true)} repos={repos ?? []} role={role} />
        <SubmitWorkRequestModal onClose={() => setSubmitOpen(false)} open={submitOpen} />
      </>
    );
  }

  const now = new Date();
  const today = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'long',
    weekday: 'long',
    year: 'numeric',
  }).format(now);

  return (
    <div className="space-y-12">
      <div className="fade-up">
        <PageHeader
          actions={
            <Button
              disabled={!canSubmit}
              onClick={() => setSubmitOpen(true)}
              title={canSubmit ? undefined : 'Connect a repository first'}
              variant="primary"
            >
              + Submit work request
            </Button>
          }
          chapter={`§ Dashboard · ${today}`}
          subtitle="A live cross-section of every active engineering workflow under management. Watch where intent meets execution."
          title="The workshop, at a glance."
        />
      </div>
      <SubmitWorkRequestModal onClose={() => setSubmitOpen(false)} open={submitOpen} />

      {/* KPI row — flat, no cards, just rules */}
      <section className="fade-up stagger-1 grid grid-cols-2 gap-y-8 border-y border-ink-600 py-8 sm:grid-cols-4">
        <Stat label="Active" tone="ember" unit="runs" value={active.length} />
        <Stat label="Completed" tone="moss" unit="runs" value={completed.length} />
        <Stat label="Failed" tone="brick" unit="runs" value={failed.length} />
        <Stat label="Attention" tone="amber" unit="items" value={needsAttention.length} />
      </section>

      {/* Charts grid */}
      <section className="fade-up stagger-2">
        <SectionHeader hint={`${all.length} runs · last 30 days`} number="01" title="Telemetry" />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle eyebrow="distribution">By status</CardTitle>
            </CardHeader>
            <WorkflowStatusChart data={statusData} />
          </Card>
          <Card>
            <CardHeader>
              <CardTitle eyebrow="velocity">Over time</CardTitle>
            </CardHeader>
            <WorkflowsOverTimeChart data={timeData} />
          </Card>
        </div>
      </section>

      {/* By repo */}
      <section className="fade-up stagger-3">
        <SectionHeader hint="topology" number="02" title="By repository" />
        <Card>
          <WorkflowsByRepoChart data={repoData} />
        </Card>
      </section>

      {/* Needs attention */}
      {needsAttention.length > 0 && (
        <section className="fade-up stagger-4">
          <SectionHeader
            hint={`${needsAttention.length} pending`}
            number="03"
            title="Needs attention"
          />
          <Card variant="inset">
            <ul className="divide-y divide-ink-600">
              {needsAttention.map((w) => (
                <li key={w.id}>
                  <a
                    className="group flex items-center justify-between py-3 transition-colors hover:text-ember-400"
                    href={`/workflows/${w.id}`}
                  >
                    <div className="flex min-w-0 items-baseline gap-4">
                      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
                        ↳
                      </span>
                      <span className="truncate text-sm text-paper-100 group-hover:text-ember-400">
                        {w.repository?.repoName ?? 'unknown'}
                      </span>
                      <span className="font-mono text-[11px] text-paper-500">
                        {w.assignedBranch}
                      </span>
                    </div>
                    <StatusBadge status={w.currentStatus} />
                  </a>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {/* Recent activity */}
      <section className="fade-up stagger-5">
        <SectionHeader hint="recent · 10" number="04" title="Activity log" />
        <Card variant="inset">
          <ul className="divide-y divide-ink-600">
            {all.slice(0, 10).map((w) => (
              <li key={w.id}>
                <a
                  className="group grid grid-cols-[auto_1fr_auto_auto] items-center gap-4 py-3 transition-colors hover:text-ember-400"
                  href={`/workflows/${w.id}`}
                >
                  <StatusBadge showDot status={w.currentStatus} />
                  <span className="min-w-0 truncate text-sm text-paper-200 group-hover:text-ember-400">
                    {w.repository?.repoName ?? 'unknown'}
                  </span>
                  <span className="hidden font-mono text-[11px] text-paper-500 sm:inline">
                    {w.assignedBranch}
                  </span>
                  <span className="tabular font-mono text-[11px] uppercase tracking-wider text-paper-500">
                    {formatRelativeTime(w.updatedAt)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </div>
  );
}
