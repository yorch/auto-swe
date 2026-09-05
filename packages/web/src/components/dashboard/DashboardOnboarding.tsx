'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { useRepositories } from '@/hooks/useRepositories';
import { API_BASE, TEMPORAL_UI_URL } from '@/lib/config';

type Role = 'ADMIN' | 'LEAD' | 'ENGINEER' | string;

export function DashboardOnboarding({
  role,
  onNewRequest,
}: {
  role: Role;
  onNewRequest?: () => void;
}) {
  const { data: repos = [], isLoading: connectionsLoading } = useRepositories();

  // Start empty so SSR output is stable regardless of runtime env. After mount,
  // window.__APP_CONFIG__ is set and TEMPORAL_UI_URL holds the runtime value.
  const [temporalUiUrl, setTemporalUiUrl] = useState('');
  useEffect(() => {
    setTemporalUiUrl(TEMPORAL_UI_URL);
  }, []);

  const canManageRepos = role === 'ADMIN' || role === 'LEAD';
  const hasConnections = repos.length > 0;

  const curlExample = `curl -X POST ${API_BASE}/api/v1/workflow-templates/<template-id>/runs \\
  -H 'Authorization: Bearer <your-token>' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "label": "Short request description",
    "payload": {}
  }'`;

  return (
    <div className="space-y-12">
      <div className="fade-up">
        <PageHeader
          chapter="§ Welcome"
          subtitle="No runs yet. Here's the shortest path to your first validated outcome."
          title="Let's get the workshop running."
        />
      </div>

      {role === 'ADMIN' && (
        <section className="fade-up stagger-1">
          <SectionHeader
            hint="admins only · do this first"
            number="00"
            title="Configure the platform"
          />
          <Card className="border-ember-400/40">
            <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-ember-400">
              Step 00 · prerequisite
            </div>
            <p className="text-sm leading-relaxed text-paper-400">
              The worker refuses to boot until every agent role has a model, a provider credential,
              and a workspace connection — skip this and the first run hangs silently. Two stops:
            </p>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ResourceLink
                body="Seed Anthropic defaults + add a provider credential."
                eyebrow="models"
                href="/studio/models"
                title="Model config"
              />
              <ResourceLink
                body="Provider credentials, tokens, and webhook secrets."
                eyebrow="integrations"
                href="/studio/integrations"
                title="Integrations"
              />
            </div>
          </Card>
        </section>
      )}

      <section className="fade-up stagger-1">
        <SectionHeader hint="three steps" number="01" title="Get started" />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <OnboardingStep
            body={
              <div className="space-y-3">
                <p>
                  Pick a workflow template and provide the inputs it expects — some need a
                  connection, others only free text.
                </p>
                {onNewRequest && (
                  <Button onClick={onNewRequest} size="sm" type="button" variant="primary">
                    + New request
                  </Button>
                )}
              </div>
            }
            index={1}
            title="Start a request"
          />
          <OnboardingStep
            body={
              connectionsLoading ? (
                <p>Loading connections…</p>
              ) : hasConnections ? (
                <p>
                  <span className="text-moss-400">{repos.length}</span>{' '}
                  {repos.length === 1 ? 'connection' : 'connections'} ready for templates that need
                  them.
                  {canManageRepos && (
                    <>
                      {' '}
                      <Link className="text-ember-400 hover:underline" href="/connections">
                        Manage
                      </Link>
                      .
                    </>
                  )}
                </p>
              ) : canManageRepos ? (
                <p>
                  Add Notion pages, Zendesk accounts, Slack workspaces, repositories, or other
                  integrations when a template asks for one.{' '}
                  <Link className="text-ember-400 hover:underline" href="/connections">
                    Open connections →
                  </Link>
                </p>
              ) : (
                <p>
                  No connections yet. Ask an{' '}
                  <span className="text-paper-200">admin or team lead</span> to add one when a
                  template needs it.
                </p>
              )
            }
            index={2}
            title="Connect integrations"
          />
          <OnboardingStep
            body={
              <p>
                Live runs land in{' '}
                <Link className="text-ember-400 hover:underline" href="/workflows">
                  Active runs
                </Link>{' '}
                and on this dashboard.{' '}
                {temporalUiUrl ? (
                  <>
                    The Temporal UI at{' '}
                    <a
                      className="text-ember-400 hover:underline"
                      href={temporalUiUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {temporalUiUrl}
                    </a>{' '}
                    shows the underlying workflow history.
                  </>
                ) : (
                  <>The Temporal UI shows the underlying workflow history.</>
                )}
              </p>
            }
            index={3}
            title="Watch it run"
          />
        </div>
      </section>

      <section className="fade-up stagger-2">
        <SectionHeader hint="optional" number="02" title="Prefer the API or CLI?" />
        <Card variant="inset">
          <ApiCurlDetails curlExample={curlExample} />
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
            href="/workflows/library"
            title="Workflow templates"
          />
          <ResourceLink
            body="Scope repositories and lessons to the right group."
            eyebrow="people"
            href="/govern/teams"
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

function ApiCurlDetails({ curlExample }: { curlExample: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        aria-expanded={open}
        className="font-mono text-[11px] uppercase tracking-[0.18em] text-paper-400 hover:text-ember-400"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        {open ? '— Hide API example' : '+ Show API example'}
      </button>
      {open && (
        <div className="mt-4 space-y-3">
          <pre
            className="overflow-x-auto font-mono text-[12px] leading-relaxed text-paper-200"
            suppressHydrationWarning
          >
            <code>{curlExample}</code>
          </pre>
          <p className="text-xs text-paper-500">
            Get <span className="text-paper-300">&lt;your-token&gt;</span> from{' '}
            <Link className="text-ember-400 hover:underline" href="/settings">
              Settings → Personal access tokens
            </Link>
            . The CLI (<code className="text-paper-300">yarn workspace @auto-swe/cli build</code>)
            reads <code className="text-paper-300">AUTO_SWE_TOKEN</code> from your environment for
            the same effect.
          </p>
        </div>
      )}
    </div>
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
