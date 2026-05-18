'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';

type Role = 'ADMIN' | 'LEAD' | 'ENGINEER' | string;

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

export function DashboardOnboarding({ repos, role }: { repos: RepositorySummary[]; role: Role }) {
  const canManageRepos = role === 'ADMIN' || role === 'LEAD';
  const hasRepo = repos.length > 0;
  const sampleRepo = repos[0];
  const sampleRepoId = sampleRepo?.id ?? '<repo-uuid>';
  const sampleRepoLabel = sampleRepo
    ? `${sampleRepo.organizationName}/${sampleRepo.repoName}`
    : 'your repo';

  const curlExample = `curl -X POST ${API_BASE}/api/v1/work-requests \\
  -H 'Authorization: Bearer <your-token>' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "externalTicketId": "JIRA-1",
    "description": "Add a GET /health endpoint",
    "repoIds": ["${sampleRepoId}"]
  }'`;

  return (
    <div className="space-y-12">
      <div className="fade-up">
        <PageHeader
          chapter="§ Welcome to auto-swe"
          subtitle="No runs yet. Here's the shortest path to your first reviewed pull request."
          title="Let's get the workshop running."
        />
      </div>

      <section className="fade-up stagger-1">
        <SectionHeader hint="three steps" number="01" title="Get started" />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <OnboardingStep
            body={
              hasRepo ? (
                <p>
                  <span className="text-moss-400">{repos.length}</span> repository
                  {repos.length === 1 ? '' : 'ies'} connected.
                  {canManageRepos && (
                    <>
                      {' '}
                      <Link className="text-ember-400 hover:underline" href="/repositories">
                        Manage
                      </Link>
                      .
                    </>
                  )}
                </p>
              ) : canManageRepos ? (
                <p>
                  Add the GitHub repo auto-swe should send pull requests to.{' '}
                  <Link className="text-ember-400 hover:underline" href="/repositories">
                    Open repositories →
                  </Link>
                </p>
              ) : (
                <p>
                  No repositories yet. Ask an{' '}
                  <span className="text-paper-200">admin or team lead</span> to add one — only they
                  can connect repos.
                </p>
              )
            }
            done={hasRepo}
            index={1}
            title="Connect a repository"
          />
          <OnboardingStep
            body={
              <p>
                Use the API directly, or the <code className="text-paper-200">auto-swe</code> CLI.
                {hasRepo ? (
                  <>
                    {' '}
                    Target the repo <span className="text-paper-200">{sampleRepoLabel}</span> with
                    its ID below.
                  </>
                ) : (
                  <> Step 1 unlocks this.</>
                )}
              </p>
            }
            disabled={!hasRepo}
            index={2}
            title="Submit a work request"
          />
          <OnboardingStep
            body={
              <p>
                Live runs land in{' '}
                <Link className="text-ember-400 hover:underline" href="/workflows">
                  Active runs
                </Link>{' '}
                and on this dashboard. The Temporal UI at{' '}
                <a
                  className="text-ember-400 hover:underline"
                  href="http://localhost:8233"
                  rel="noreferrer"
                  target="_blank"
                >
                  localhost:8233
                </a>{' '}
                shows the underlying workflow history.
              </p>
            }
            index={3}
            title="Watch it run"
          />
        </div>
      </section>

      <section className="fade-up stagger-2">
        <SectionHeader hint="copy & paste" number="02" title="Your first work request" />
        <Card variant="inset">
          <pre className="overflow-x-auto font-mono text-[12px] leading-relaxed text-paper-200">
            <code>{curlExample}</code>
          </pre>
          <p className="mt-4 text-xs text-paper-500">
            Get <span className="text-paper-300">&lt;your-token&gt;</span> from{' '}
            <Link className="text-ember-400 hover:underline" href="/settings">
              Settings → Personal access tokens
            </Link>
            . The CLI (<code className="text-paper-300">yarn workspace @auto-swe/cli build</code>)
            reads <code className="text-paper-300">AUTO_SWE_TOKEN</code> from your environment for
            the same effect.
          </p>
        </Card>
      </section>

      <section className="fade-up stagger-3">
        <SectionHeader hint="learn more" number="03" title="Next steps" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <ResourceLink
            body="Architecture, configurable workflows, OAuth setup."
            eyebrow="reference"
            href="/docs"
            title="Documentation"
          />
          <ResourceLink
            body="Customise the default engineering loop — gates, fan-out, signals."
            eyebrow="workflows"
            href="/templates"
            title="Workflow templates"
          />
          <ResourceLink
            body="Scope repositories and lessons to the right group."
            eyebrow="people"
            href="/teams"
            title="Teams"
          />
        </div>
      </section>
    </div>
  );
}

function OnboardingStep({
  index,
  title,
  body,
  done = false,
  disabled = false,
}: {
  index: number;
  title: string;
  body: React.ReactNode;
  done?: boolean;
  disabled?: boolean;
}) {
  return (
    <Card className={disabled ? 'opacity-50' : undefined}>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">
          Step 0{index}
        </span>
        {done && (
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-moss-400">
            ✓ done
          </span>
        )}
      </div>
      <h3 className="mb-3 font-display text-lg text-paper-100">{title}</h3>
      <div className="text-sm leading-relaxed text-paper-400">{body}</div>
    </Card>
  );
}

function ResourceLink({
  href,
  eyebrow,
  title,
  body,
}: {
  href: string;
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <Link
      className="group block border border-ink-600 bg-ink-800/40 p-5 transition-colors hover:border-ember-400/60"
      href={href}
    >
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">
        {eyebrow}
      </div>
      <div className="mb-2 font-display text-base text-paper-100 group-hover:text-ember-400">
        {title} →
      </div>
      <p className="text-xs leading-relaxed text-paper-500">{body}</p>
    </Link>
  );
}
