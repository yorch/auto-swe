'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useExportBundle, useInstallBundleFromUrl, useInstalledBundles } from '@/hooks/useBundles';
import { errMsg } from '@/lib/errors';

export default function AdminBundlesPage() {
  const { data: bundles, isLoading, isError, error: loadError } = useInstalledBundles();
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
      setError(errMsg(e, 'Install failed'));
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
      setError(errMsg(e, 'Export failed'));
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
        <QueryBoundary error={loadError} isError={isError} isLoading={isLoading} label="bundles">
          {!bundles || bundles.length === 0 ? (
            <EmptyState className="py-4" title="No bundles installed yet." />
          ) : (
            <Table>
              <THead>
                <Th variant="compact">Name</Th>
                <Th variant="compact">Version</Th>
                <Th variant="compact">Trust</Th>
                <Th variant="compact">Source</Th>
              </THead>
              <tbody>
                {bundles.map((b) => (
                  <TRow key={b.name}>
                    <Td className="py-2 pr-4 font-mono text-xs text-paper-100">{b.name}</Td>
                    <Td className="py-2 pr-4 text-paper-300">{b.version}</Td>
                    <Td className="py-2 pr-4">
                      <span
                        className={b.trustState === 'VERIFIED' ? 'text-moss-400' : 'text-amber-400'}
                      >
                        {b.trustState}
                        {b.signedBy ? ` · ${b.signedBy}` : ''}
                      </span>
                    </Td>
                    <Td className="py-2 pr-4 text-xs text-paper-400">{b.source ?? '—'}</Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </QueryBoundary>
      </Card>
    </div>
  );
}
