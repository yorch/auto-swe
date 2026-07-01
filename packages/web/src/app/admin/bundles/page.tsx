'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { useExportBundle, useInstallBundleFromUrl, useInstalledBundles } from '@/hooks/useBundles';

export default function AdminBundlesPage() {
  const { data: bundles, isLoading } = useInstalledBundles();
  const installFromUrl = useInstallBundleFromUrl();
  const exportBundle = useExportBundle();

  const [url, setUrl] = useState('');
  const [exportForm, setExportForm] = useState({ name: '', origin: '', version: '1.0.0' });
  const [error, setError] = useState<string | null>(null);

  async function handleInstall() {
    setError(null);
    try {
      await installFromUrl.mutateAsync(url);
      setUrl('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Install failed');
    }
  }

  async function handleExport() {
    setError(null);
    try {
      const manifest = await exportBundle.mutateAsync({
        name: exportForm.name || 'bundle',
        origin: exportForm.origin || undefined,
        version: exportForm.version || '1.0.0',
      });
      // Download the bundle JSON in the browser.
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = `${exportForm.name || 'bundle'}.bundle.json`;
      a.href = href;
      a.click();
      URL.revokeObjectURL(href);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle={
          <>
            Distribute library content (Agents, Skills, scanner patterns, Templates) across
            deployments. Install seeds a <strong>managed base layer</strong>; your team/template
            overrides sit on top. A bundle whose detached signature matches a deployment-trusted key
            installs as <code className="text-paper-300">VERIFIED</code>, otherwise{' '}
            <code className="text-paper-300">UNVERIFIED</code> (community).
          </>
        }
        title="Bundles"
      />

      {error && <Alert variant="error">{error}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>Export</CardTitle>
        </CardHeader>
        <div className="flex flex-wrap items-end gap-3">
          <Input
            label="Name"
            onChange={(e) => setExportForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="swe-starter"
            value={exportForm.name}
          />
          <Input
            label="Version"
            onChange={(e) => setExportForm((f) => ({ ...f, version: e.target.value }))}
            value={exportForm.version}
          />
          <Input
            hint="origin tag to export (blank = all GLOBAL content)"
            label="Origin"
            onChange={(e) => setExportForm((f) => ({ ...f, origin: e.target.value }))}
            placeholder="swe-starter"
            value={exportForm.origin}
          />
          <Button disabled={exportBundle.isPending} onClick={handleExport} variant="primary">
            {exportBundle.isPending ? 'Exporting…' : 'Export & download'}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Install from URL</CardTitle>
        </CardHeader>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Input
              label="Bundle URL (http/https)"
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/swe.bundle.json"
              value={url}
            />
          </div>
          <Button
            disabled={!url || installFromUrl.isPending}
            onClick={handleInstall}
            variant="primary"
          >
            {installFromUrl.isPending ? 'Installing…' : 'Install'}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Installed bundles</CardTitle>
        </CardHeader>
        {isLoading ? (
          <LoadingState />
        ) : !bundles || bundles.length === 0 ? (
          <div className="py-4 text-center text-sm text-paper-400">No bundles installed yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-600">
                <th className="py-2 text-left text-xs text-paper-500">Name</th>
                <th className="py-2 text-left text-xs text-paper-500">Version</th>
                <th className="py-2 text-left text-xs text-paper-500">Trust</th>
                <th className="py-2 text-left text-xs text-paper-500">Source</th>
              </tr>
            </thead>
            <tbody>
              {bundles.map((b) => (
                <tr className="border-b border-ink-600 last:border-0" key={b.name}>
                  <td className="py-2 pr-4 font-mono text-xs text-paper-100">{b.name}</td>
                  <td className="py-2 pr-4 text-paper-300">{b.version}</td>
                  <td className="py-2 pr-4">
                    <span
                      className={b.trustState === 'VERIFIED' ? 'text-moss-400' : 'text-amber-400'}
                    >
                      {b.trustState}
                      {b.signedBy ? ` · ${b.signedBy}` : ''}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-xs text-paper-400">{b.source ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
