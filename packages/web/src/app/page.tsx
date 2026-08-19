'use client';

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { WorkflowStatusChart } from '@/components/charts/WorkflowStatusChart';
import { WorkflowsByRepoChart } from '@/components/charts/WorkflowsByRepoChart';
import { WorkflowsOverTimeChart } from '@/components/charts/WorkflowsOverTimeChart';
import { DashboardOnboarding } from '@/components/dashboard/DashboardOnboarding';
import { SubmitWorkRequestModal } from '@/components/dashboard/SubmitWorkRequestModal';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { Stat } from '@/components/ui/Stat';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useInbox } from '@/hooks/useInbox';
import { useRepositories, useWorkflows } from '@/hooks/useWorkflows';
import {
  groupWorkflowsByDate,
  groupWorkflowsByRepo,
  groupWorkflowsByStatus,
} from '@/lib/chartUtils';
import { formatRelativeTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

function InboxWidget({ steps }: { steps: HumanStepSummary[] }) {
  if (steps.length === 0) {
    return null;
  }
  return (
    <section className="fade-up stagger-1">
      <SectionHeader
        hint={`${steps.length} awaiting response`}
        number="00"
        title="Pending approvals"
      />
      <Card variant="inset">
        <ul className="divide-y divide-ink-600">
          {steps.slice(0, 5).map((step) => (
            <li key={step.id}>
              <Link
                className="group flex items-center justify-between gap-4 py-3 transition-colors hover:text-ember-400"
                href={`/runs/${step.runId}`}
              >
                <div className="flex min-w-0 items-baseline gap-3">
                  <span className="shrink-0 rounded bg-amber-400/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-amber-400">
                    {step.kind}
                  </span>
                  <span className="truncate text-sm text-paper-200 group-hover:text-ember-400">
                    {step.title}
                  </span>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-paper-500">
                  {formatRelativeTime(step.requestedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {steps.length > 5 && (
          <div className="border-t border-ink-600 px-4 py-2 text-right">
            <Link
              className="font-mono text-[11px] uppercase tracking-wider text-ember-400 hover:text-ember-300"
              href="/inbox"
            >
              View all {steps.length} →
            </Link>
          </div>
        )}
      </Card>
    </section>
  );
}

export default function DashboardPage() {
  const { data: workflows, isLoading } = useWorkflows();
  const { data: repos, isLoading: reposLoading } = useRepositories();
  const { data: inboxSteps } = useInbox();
  const role = useAuthStore((s) => s.user?.role ?? 'ENGINEER');
  const [submitOpen, setSubmitOpen] = useState(false);
  const canSubmit = (repos ?? []).length > 0;

  const all = workflows ?? [];
  const active = all.filter((w) => !['COMPLETED', 'FAILED', 'TIMED_OUT'].includes(w.currentStatus));
  const completed = all.filter((w) => w.currentStatus === 'COMPLETED');
  const failed = all.filter((w) => w.currentStatus === 'FAILED');
  const pendingApprovals = inboxSteps ?? [];

  const statusData = useMemo(() => groupWorkflowsByStatus(all), [all]);
  const timeData = useMemo(() => groupWorkflowsByDate(all), [all]);
  const repoData = useMemo(() => groupWorkflowsByRepo(all), [all]);

  if (isLoading || reposLoading) {
    return <LoadingState message="loading…" />;
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
  const today = new Intl.DateTimeFormat(undefined, {
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
            <div className="flex items-center gap-2">
              <Button
                onClick={() => window.location.assign('/templates')}
                size="sm"
                variant="secondary"
              >
                Browse workflows
              </Button>
              <Button
                disabled={!canSubmit}
                onClick={() => setSubmitOpen(true)}
                title={canSubmit ? undefined : 'Connect a repository first'}
                variant="primary"
              >
                + Run SWE agent
              </Button>
            </div>
          }
          chapter={`§ Home · ${today}`}
          subtitle="Active runs, pending approvals, and platform health at a glance."
          title="Command centre."
        />
      </div>
      <SubmitWorkRequestModal onClose={() => setSubmitOpen(false)} open={submitOpen} />

      {/* HITL inbox — shown first so approvals are never missed */}
      <InboxWidget steps={pendingApprovals} />

      {/* KPI row */}
      <section className="fade-up stagger-2 grid grid-cols-2 gap-y-8 border-y border-ink-600 py-8 sm:grid-cols-4">
        <Stat label="Active" tone="ember" unit="runs" value={active.length} />
        <Stat label="Completed" tone="moss" unit="runs" value={completed.length} />
        <Stat label="Failed" tone="brick" unit="runs" value={failed.length} />
        <Stat label="Approvals" tone="amber" unit="pending" value={pendingApprovals.length} />
      </section>

      {/* Charts grid */}
      <section className="fade-up stagger-3">
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

      {/* By connection */}
      <section className="fade-up stagger-4">
        <SectionHeader hint="topology" number="02" title="By connection" />
        <Card>
          <WorkflowsByRepoChart data={repoData} />
        </Card>
      </section>

      {/* Recent runs */}
      <section className="fade-up stagger-5">
        <SectionHeader hint="recent · 10" number="03" title="Recent runs" />
        <Card variant="inset">
          <ul className="divide-y divide-ink-600">
            {all.slice(0, 10).map((w) => (
              <li key={w.id}>
                <Link
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
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </div>
  );
}
