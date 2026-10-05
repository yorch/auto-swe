'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type BundlePreview,
  useExportBundle,
  useInstallBundleFromUrl,
  useInstalledBundles,
  usePreviewBundle,
} from '@/hooks/useBundles';
import { errMsg } from '@/lib/errors';
import { navLabel } from '@/lib/navigation';
import { BundlePreviewModal } from './BundlePreviewModal';

export default function StudioBundlesPage() {
  const {
    data: bundles,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useInstalledBundles();
  const installFromUrl = useInstallBundleFromUrl();
  const previewBundle = usePreviewBundle();
  const exportBundle = useExportBundle();

  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [exportForm, setExportForm] = useState({ name: '', origin: '', version: '1.0.0' });
  // Each card reports its own outcome, so an export failure is never shown above the install card.
  const [installError, setInstallError] = useState<string | null>(null);
  const [installDone, setInstallDone] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportDone, setExportDone] = useState<string | null>(null);

  async function handlePreview() {
    setInstallError(null);
    setInstallDone(null);
    try {
      setPreview(await previewBundle.mutateAsync(url.trim()));
    } catch (e) {
      setInstallError(errMsg(e, 'Could not load the bundle'));
    }
  }

  async function handleExport() {
    setExportError(null);
    setExportDone(null);
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
      setExportDone(`Downloaded ${exportForm.name || 'bundle'}.bundle.json.`);
    } catch (e) {
      setExportError(errMsg(e, 'Export failed'));
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        chapter="§ Studio"
        subtitle={
          <>
            Distribute library content (Agents, Skills, scanner patterns, Templates) across
            deployments. Install seeds a <strong>managed base layer</strong>; your team/template
            overrides sit on top. A bundle whose detached signature matches a deployment-trusted key
            installs as <code className="text-paper-300">VERIFIED</code>, otherwise{' '}
            <code className="text-paper-300">UNVERIFIED</code> (community).
          </>
        }
        title={navLabel('/studio/bundles')}
      />

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
        {exportError && (
          <Alert className="mt-3" variant="error">
            {exportError}
          </Alert>
        )}
        {exportDone && (
          <Alert className="mt-3" variant="success">
            {exportDone}
          </Alert>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Install from URL</CardTitle>
        </CardHeader>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <Input
              hint="You review what it contains and what it replaces before anything is installed."
              label="Bundle URL (http/https)"
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/swe.bundle.json"
              value={url}
            />
          </div>
          <Button
            disabled={!url.trim() || previewBundle.isPending}
            onClick={handlePreview}
            variant="primary"
          >
            {previewBundle.isPending ? 'Loading…' : 'Preview'}
          </Button>
        </div>
        {installError && (
          <Alert className="mt-3" variant="error">
            {installError}
          </Alert>
        )}
        {installDone && (
          <Alert className="mt-3" variant="success">
            {installDone}
          </Alert>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Installed bundles</CardTitle>
        </CardHeader>
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="bundles"
          onRetry={() => void refetch()}
        >
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
                      <Badge tone={b.trustState === 'VERIFIED' ? 'moss' : 'amber'} variant="text">
                        {b.trustState}
                        {b.signedBy ? ` · ${b.signedBy}` : ''}
                      </Badge>
                    </Td>
                    <Td className="py-2 pr-4 text-xs text-paper-400">{b.source ?? '—'}</Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </QueryBoundary>
      </Card>
      {preview && (
        <BundlePreviewModal
          onClose={() => setPreview(null)}
          onInstall={async (overwriteProtected) => {
            const result = await installFromUrl.mutateAsync({
              expectedContentHash: preview.contentHash,
              overwriteProtected,
              url: url.trim(),
            });
            const c = result.counts;
            setInstallDone(
              `Installed ${preview.name} ${preview.version}: ${c.agents} agents, ${c.skills} skills, ${c.scannerPatterns} scanner rules, ${c.templates} templates.`
            );
            setUrl('');
            return result;
          }}
          preview={preview}
        />
      )}
    </div>
  );
}
