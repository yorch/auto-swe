'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  type KnowledgeBaseConfigInput,
  type KnowledgeBaseProvider,
  testKnowledgeBaseConnection,
  useKnowledgeBaseConfig,
  useUpdateKnowledgeBaseConfig,
} from '@/hooks/useAdminConfig';
import { SecretInput } from './SecretInput';
import { SourceBadge } from './SourceBadge';

function errMsg(err: unknown, fallback = 'Request failed'): string {
  return err instanceof Error ? err.message : fallback;
}

const PROVIDER_HINTS: Record<KnowledgeBaseProvider, { baseUrl: string; token: string; spaces: string }> =
  {
    confluence: {
      baseUrl: 'Atlassian site URL, e.g. https://acme.atlassian.net',
      spaces: 'Space keys, e.g. ENG, ARCH, RUNBOOKS',
      token: 'Atlassian API token (same as Issue Tracker if Jira is configured)',
    },
    notion: {
      baseUrl: 'Leave empty — Notion API is fixed (api.notion.com)',
      spaces: 'Database IDs to search (comma-separated)',
      token: 'Notion integration token',
    },
  };

export function KnowledgeBaseTab() {
  const { data: resp, isLoading } = useKnowledgeBaseConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateKnowledgeBaseConfig();

  const [provider, setProvider] = useState<'' | 'disabled' | KnowledgeBaseProvider>('');
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [baseUrl, setBaseUrl] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [spacesRaw, setSpacesRaw] = useState('');
  const [maxPages, setMaxPages] = useState('');

  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testQuery, setTestQuery] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const effectiveProvider = (provider === '' ? data?.provider : provider) as
    | KnowledgeBaseProvider
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

    const body: KnowledgeBaseConfigInput = {};
    if (provider) {
      body.provider = provider === 'disabled' ? null : provider;
    }
    if (enabled !== undefined) {
      body.enabled = enabled;
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
    if (spacesRaw) {
      body.spaces = spacesRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (maxPages) {
      const parsed = Number.parseInt(maxPages, 10);
      if (!Number.isNaN(parsed)) {
        body.maxPages = parsed;
      }
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
      const res = await testKnowledgeBaseConnection(testQuery.trim());
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
          <CardTitle eyebrow="Knowledge base">Knowledge base</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Connect a knowledge base so agents can search internal documentation at run time.
          Confluence and Notion are supported. The connector is read-only — it never writes to your
          knowledge base.
        </p>
        <div className="space-y-4">
          <div>
            <label
              className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
              htmlFor="kb-provider"
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
              id="kb-provider"
              onChange={(e) =>
                setProvider(e.target.value as '' | 'disabled' | KnowledgeBaseProvider)
              }
              value={provider}
            >
              <option value="">(keep current)</option>
              <option value="disabled">Disabled</option>
              <option value="confluence">Confluence</option>
              <option value="notion">Notion</option>
            </select>
          </div>
          <div>
            <label
              className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
              htmlFor="kb-enabled"
            >
              Enabled
              <SourceBadge source={sources.enabled} />
              {data?.enabled !== undefined && (
                <span className="font-mono text-[10px] normal-case tracking-normal text-paper-400">
                  current: {data.enabled ? 'yes' : 'no'}
                </span>
              )}
            </label>
            <select
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs focus:border-ember-400 focus:outline-none"
              id="kb-enabled"
              onChange={(e) => {
                const v = e.target.value;
                setEnabled(v === '' ? undefined : v === 'true');
              }}
              value={enabled === undefined ? '' : String(enabled)}
            >
              <option value="">(keep current)</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>
          <div>
            <label
              className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
              htmlFor="kb-base-url"
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
              id="kb-base-url"
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={hints?.baseUrl ?? 'https://acme.atlassian.net'}
              value={baseUrl}
            />
          </div>
          {effectiveProvider === 'confluence' && (
            <div>
              <label
                className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
                htmlFor="kb-email"
              >
                Email (Confluence only)
                <SourceBadge source={sources.email} />
                {data?.email && (
                  <span className="font-mono text-[10px] normal-case tracking-normal text-paper-400">
                    current: {data.email}
                  </span>
                )}
              </label>
              <input
                className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                id="kb-email"
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com (Confluence basic-auth user)"
                value={email}
              />
            </div>
          )}
          <SecretInput
            current={data?.apiToken ?? null}
            id="kb-api-token"
            label="API token"
            onChange={setApiToken}
            placeholder={hints?.token ?? 'API token'}
            source={sources.apiToken}
            value={apiToken}
          />
          <div>
            <label
              className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
              htmlFor="kb-spaces"
            >
              Spaces
              <SourceBadge source={sources.spaces} />
              {data?.spaces && data.spaces.length > 0 && (
                <span className="font-mono text-[10px] normal-case tracking-normal text-paper-400">
                  current: {data.spaces.join(', ')}
                </span>
              )}
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="kb-spaces"
              onChange={(e) => setSpacesRaw(e.target.value)}
              placeholder={hints?.spaces ?? 'ENG, ARCH'}
              value={spacesRaw}
            />
          </div>
          <div>
            <label
              className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
              htmlFor="kb-max-pages"
            >
              Max pages
              <SourceBadge source={sources.maxPages} />
              {data?.maxPages !== null && data?.maxPages !== undefined && (
                <span className="font-mono text-[10px] normal-case tracking-normal text-paper-400">
                  current: {data.maxPages}
                </span>
              )}
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="kb-max-pages"
              inputMode="numeric"
              onChange={(e) => setMaxPages(e.target.value)}
              placeholder="50"
              value={maxPages}
            />
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Knowledge base">Test connection</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Runs a search query through the saved configuration to verify connectivity and access.
        </p>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label
              className="mb-1 block text-xs uppercase text-paper-500"
              htmlFor="kb-test-query"
            >
              Search query
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="kb-test-query"
              onChange={(e) => setTestQuery(e.target.value)}
              placeholder="deployment runbook"
              value={testQuery}
            />
          </div>
          <Button
            disabled={testing || !testQuery.trim() || !data?.provider}
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
