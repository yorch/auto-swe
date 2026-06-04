'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  useUpdateWorkflowDefaultsConfig,
  useWorkflowDefaultsConfig,
  type WorkflowDefaultsInput,
} from '@/hooks/useAdminConfig';

export default function AdminWorkflowPage() {
  const { data, isLoading } = useWorkflowDefaultsConfig();
  const update = useUpdateWorkflowDefaultsConfig();

  const [branchPrefix, setBranchPrefix] = useState('');
  const [prTitleTemplate, setPrTitleTemplate] = useState('');
  const [prBodyTemplate, setPrBodyTemplate] = useState('');
  const [defaultTeamSlug, setDefaultTeamSlug] = useState('');

  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed form from loaded data (once)
  useEffect(() => {
    if (!data) {
      return;
    }
    setBranchPrefix(data.branchPrefix ?? '');
    setPrTitleTemplate(data.prTitleTemplate ?? '');
    setPrBodyTemplate(data.prBodyTemplate ?? '');
    setDefaultTeamSlug(data.defaultTeamSlug ?? '');
  }, [data]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);

    const body: WorkflowDefaultsInput = {};
    if (branchPrefix) {
      body.branchPrefix = branchPrefix;
    }
    if (prTitleTemplate) {
      body.prTitleTemplate = prTitleTemplate;
    }
    if (prBodyTemplate) {
      body.prBodyTemplate = prBodyTemplate;
    }
    if (defaultTeamSlug) {
      body.defaultTeamSlug = defaultTeamSlug;
    }

    try {
      await update.mutateAsync(body);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Admin — Workflow defaults</h2>
        <p className="mt-1 text-sm text-paper-400">
          System-wide defaults applied to every new work request. Per-team overrides take precedence
          when set.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-paper-400">Loading…</p>
      ) : (
        <form className="space-y-6" onSubmit={handleSubmit}>
          <Card>
            <CardHeader>
              <CardTitle eyebrow="Git &amp; PR">Branch and pull request templates</CardTitle>
            </CardHeader>
            <div className="space-y-4">
              <div>
                <label
                  className="mb-1 block text-xs uppercase text-paper-500"
                  htmlFor="branch-prefix"
                >
                  Branch prefix
                </label>
                <input
                  className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                  id="branch-prefix"
                  onChange={(e) => setBranchPrefix(e.target.value)}
                  placeholder="auto"
                  value={branchPrefix}
                />
                <p className="mt-1 text-[11px] text-paper-500">
                  Branches are created as{' '}
                  <span className="font-mono">
                    {branchPrefix || 'auto'}/{'<ticketId>'}
                  </span>
                  .
                </p>
              </div>

              <div>
                <label
                  className="mb-1 block text-xs uppercase text-paper-500"
                  htmlFor="pr-title-template"
                >
                  PR title template
                </label>
                <input
                  className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                  id="pr-title-template"
                  onChange={(e) => setPrTitleTemplate(e.target.value)}
                  placeholder="[auto-swe] {{ticketId}}"
                  value={prTitleTemplate}
                />
                <p className="mt-1 text-[11px] text-paper-500">
                  Available variables: <span className="font-mono">{'{{ticketId}}'}</span>,{' '}
                  <span className="font-mono">{'{{description}}'}</span>.
                </p>
              </div>

              <div>
                <label
                  className="mb-1 block text-xs uppercase text-paper-500"
                  htmlFor="pr-body-template"
                >
                  PR body template
                  <span className="ml-2 font-mono text-[10px] normal-case tracking-normal text-paper-600">
                    (leave blank to use system default)
                  </span>
                </label>
                <textarea
                  className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                  id="pr-body-template"
                  onChange={(e) => setPrBodyTemplate(e.target.value)}
                  placeholder={
                    'Resolves {{ticketId}}\n\n## Summary\n{{description}}\n\n---\n🤖 Implemented by auto-swe'
                  }
                  rows={6}
                  value={prBodyTemplate}
                />
                <p className="mt-1 text-[11px] text-paper-500">
                  Available variables: <span className="font-mono">{'{{ticketId}}'}</span>,{' '}
                  <span className="font-mono">{'{{description}}'}</span>,{' '}
                  <span className="font-mono">{'{{prUrl}}'}</span>.
                </p>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle eyebrow="Teams">Default team</CardTitle>
            </CardHeader>
            <div>
              <label
                className="mb-1 block text-xs uppercase text-paper-500"
                htmlFor="default-team-slug"
              >
                Default team slug
              </label>
              <input
                className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                id="default-team-slug"
                onChange={(e) => setDefaultTeamSlug(e.target.value)}
                placeholder="default"
                value={defaultTeamSlug}
              />
              <p className="mt-1 text-[11px] text-paper-500">
                Work requests without an explicit team are assigned to this team.
              </p>
            </div>
          </Card>

          {saved && <p className="text-sm text-emerald-400">Settings saved.</p>}
          {error && <p className="text-sm text-brick-400">{error}</p>}

          <div className="flex justify-end">
            <Button disabled={update.isPending} type="submit" variant="primary">
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
