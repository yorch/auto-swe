'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  type TrackerConfigInput,
  type TrackerProvider,
  testTrackerConnection,
  useTrackerConfig,
  useUpdateTrackerConfig,
} from '@/hooks/useAdminConfig';
import { SecretInput } from './SecretInput';
import { SourceBadge } from './SourceBadge';

function errMsg(err: unknown, fallback = 'Request failed'): string {
  return err instanceof Error ? err.message : fallback;
}

const PROVIDER_HINTS: Record<TrackerProvider, { baseUrl: string; ticket: string; token: string }> =
  {
    github: {
      baseUrl: 'API base — leave empty for https://api.github.com (set for GHE)',
      ticket: 'owner/repo#123 (or a bare issue number — resolves to the target repo)',
      token: 'GitHub token with repo read access',
    },
    jira: {
      baseUrl: 'Jira site URL, e.g. https://acme.atlassian.net',
      ticket: 'Issue key, e.g. PROJ-123',
      token: 'Jira API token (used with the email below as basic auth)',
    },
    linear: {
      baseUrl: 'Not used — Linear endpoint is fixed (api.linear.app)',
      ticket: 'Issue identifier, e.g. ENG-123',
      token: 'Linear API key',
    },
  };

export function TrackerTab() {
  const { data: resp, isLoading } = useTrackerConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateTrackerConfig();

  const [provider, setProvider] = useState<'' | 'disabled' | TrackerProvider>('');
  const [baseUrl, setBaseUrl] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');

  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testTicketId, setTestTicketId] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const effectiveProvider = (provider === '' ? data?.provider : provider) as
    | TrackerProvider
    | 'disabled'
    | null
    | undefined;
  const hints =
    effectiveProvider && effectiveProvider !== 'disabled'
      ? PROVIDER_HINTS[effectiveProvider]
      : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setTestResult(null);

    const body: TrackerConfigInput = {};
    if (provider) {
      body.provider = provider === 'disabled' ? null : provider;
    }
    if (baseUrl) {
      body.baseUrl = baseUrl;
    }
    if (email) {
      body.email = email;
    }
    if (apiToken) {
      body.apiToken = apiToken;
    }

    try {
      await update.mutateAsync(body);
      setSaved(true);
      setApiToken('');
    } catch (err) {
      setError(errMsg(err, 'Failed to save'));
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testTrackerConnection(testTicketId.trim());
      setTestResult(res);
    } catch (err) {
      setTestResult({ detail: errMsg(err), ok: false });
    } finally {
      setTesting(false);
    }
  };

  if (isLoading) {
    return <p className="text-sm text-paper-400">Loading…</p>;
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Issue tracker">Ticket connector</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Read-only connector that fetches the external ticket at submit time and attaches its
          title, description, status, and labels to the work request&apos;s context snapshot — so
          agents see the real ticket instead of only the pasted description. Fetch failures never
          block a submission.
        </p>
        <div className="space-y-4">
          <div>
            <label
              className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
              htmlFor="tracker-provider"
            >
              Provider
              <SourceBadge source={sources.provider} />
              {data?.provider && (
                <span className="font-mono text-[10px] normal-case tracking-normal text-paper-400">
                  current: {data.provider}
                </span>
              )}
            </label>
            <select
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs focus:border-ember-400 focus:outline-none"
              id="tracker-provider"
              onChange={(e) => setProvider(e.target.value as '' | 'disabled' | TrackerProvider)}
              value={provider}
            >
              <option value="">(keep current)</option>
              <option value="disabled">Disabled</option>
              <option value="jira">Jira</option>
              <option value="linear">Linear</option>
              <option value="github">GitHub Issues</option>
            </select>
            {hints && (
              <p className="mt-1 text-[11px] text-paper-600">Ticket ID format: {hints.ticket}</p>
            )}
          </div>
          <div>
            <label
              className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
              htmlFor="tracker-base-url"
            >
              Base URL
              <SourceBadge source={sources.baseUrl} />
              {data?.baseUrl && (
                <span className="font-mono text-[10px] normal-case tracking-normal text-paper-400">
                  current: {data.baseUrl}
                </span>
              )}
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="tracker-base-url"
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={hints?.baseUrl ?? 'https://acme.atlassian.net'}
              value={baseUrl}
            />
          </div>
          <div>
            <label
              className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
              htmlFor="tracker-email"
            >
              Email (Jira only)
              <SourceBadge source={sources.email} />
              {data?.email && (
                <span className="font-mono text-[10px] normal-case tracking-normal text-paper-400">
                  current: {data.email}
                </span>
              )}
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="tracker-email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com (Jira basic-auth user)"
              value={email}
            />
          </div>
          <SecretInput
            current={data?.apiToken ?? null}
            id="tracker-api-token"
            label="API token"
            onChange={setApiToken}
            placeholder={hints?.token ?? 'API token'}
            source={sources.apiToken}
            value={apiToken}
          />
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Issue tracker">Test connection</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Fetches a real ticket through the saved configuration and shows its title and status.
        </p>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label
              className="mb-1 block text-xs uppercase text-paper-500"
              htmlFor="tracker-test-ticket"
            >
              Ticket ID
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="tracker-test-ticket"
              onChange={(e) => setTestTicketId(e.target.value)}
              placeholder={hints?.ticket ?? 'PROJ-123'}
              value={testTicketId}
            />
          </div>
          <Button
            disabled={testing || !testTicketId.trim() || !data?.provider}
            onClick={handleTest}
            size="sm"
            type="button"
            variant="secondary"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
        {testResult && (
          <p className={`mt-2 text-sm ${testResult.ok ? 'text-emerald-400' : 'text-brick-400'}`}>
            {testResult.ok ? '✓' : '✗'} {testResult.detail}
          </p>
        )}
      </Card>

      {saved && <p className="text-sm text-emerald-400">Settings saved.</p>}
      {error && <p className="text-sm text-brick-400">{error}</p>}

      <div className="flex justify-end">
        <Button disabled={update.isPending} type="submit" variant="primary">
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
