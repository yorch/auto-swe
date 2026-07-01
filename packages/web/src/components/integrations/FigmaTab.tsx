'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  type FigmaConfigInput,
  testFigmaConnection,
  useFigmaConfig,
  useUpdateFigmaConfig,
} from '@/hooks/useAdminConfig';
import { SecretInput } from './SecretInput';

function errMsg(err: unknown, fallback = 'Request failed'): string {
  return err instanceof Error ? err.message : fallback;
}

export function FigmaTab() {
  const { data: resp, isLoading } = useFigmaConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateFigmaConfig();

  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [apiToken, setApiToken] = useState('');
  const [maxNodes, setMaxNodes] = useState('');

  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setTestResult(null);

    const body: FigmaConfigInput = {};
    if (enabled !== undefined) {
      body.enabled = enabled;
    }
    if (apiToken) {
      body.apiToken = apiToken;
    }
    if (maxNodes) {
      const parsed = Number.parseInt(maxNodes, 10);
      if (!Number.isNaN(parsed)) {
        body.maxNodes = parsed;
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
      const res = await testFigmaConnection();
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
          <CardTitle eyebrow="Figma">Figma design source</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Connect Figma so a work request that references a Figma file/node is enriched with a
          compact design summary (frames, text, tokens) that the implementer matches against. The
          connector is read-only — it never writes to Figma. To give agents live, on-demand design
          access during a run, add the Figma Dev Mode endpoint as an MCP connection under{' '}
          <span className="font-mono text-[10px] text-paper-400">/admin/mcp-connections</span>{' '}
          instead.
        </p>
        <div className="space-y-4">
          <div>
            <label
              className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
              htmlFor="figma-enabled"
            >
              Enabled
              {data?.enabled !== undefined && (
                <span className="font-mono text-[10px] normal-case tracking-normal text-paper-400">
                  current: {data.enabled ? 'yes' : 'no'}
                </span>
              )}
            </label>
            <select
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs focus:border-ember-400 focus:outline-none"
              id="figma-enabled"
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
          <SecretInput
            current={data?.apiToken ?? null}
            id="figma-api-token"
            label="API token"
            onChange={setApiToken}
            placeholder="Figma personal access token (figd_…)"
            source={sources.apiToken}
            value={apiToken}
          />
          <div>
            <label
              className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
              htmlFor="figma-max-nodes"
            >
              Max nodes
              {data?.maxNodes !== null && data?.maxNodes !== undefined && (
                <span className="font-mono text-[10px] normal-case tracking-normal text-paper-400">
                  current: {data.maxNodes}
                </span>
              )}
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="figma-max-nodes"
              inputMode="numeric"
              onChange={(e) => setMaxNodes(e.target.value)}
              placeholder="12"
              value={maxNodes}
            />
            <p className="mt-1 text-[10px] text-paper-600">
              Caps how many design nodes are summarized per request — bounds context size and cost.
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Figma">Test connection</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Calls the Figma API with the saved token to verify connectivity and access.
        </p>
        <Button
          disabled={testing || !data?.enabled}
          onClick={handleTest}
          size="sm"
          type="button"
          variant="secondary"
        >
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
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
