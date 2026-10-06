'use client';

import { useRef, useState } from 'react';
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
  useInstallBundleFromFile,
  useInstallBundleFromUrl,
  useInstalledBundles,
  usePreviewBundle,
} from '@/hooks/useBundles';
import { ApiError } from '@/lib/api';
import { readBundleFile } from '@/lib/bundleFile';
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
  const installFromFile = useInstallBundleFromFile();
  const previewBundle = usePreviewBundle();
  const exportBundle = useExportBundle();

  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  // Where the previewed bundle came from, so the install sends the same thing the admin reviewed.
  const [fileBundle, setFileBundle] = useState<unknown>(null);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child the pointer crosses, so count them rather than flip.
  const dragDepth = useRef(0);
  // Set synchronously at entry: `isPending` only flips after the file has been read.
  const loadingFile = useRef(false);
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
      setFileBundle(null);
      setPreview(await previewBundle.mutateAsync({ url: url.trim() }));
    } catch (e) {
      setInstallError(errMsg(e, 'Could not load the bundle'));
    }
  }

  async function handleFile(file: File | undefined) {
    // A drop while a preview is loading would race it and could replace what the admin is reviewing.
    if (!file || previewBundle.isPending || loadingFile.current) {
      return;
    }
    loadingFile.current = true;
    try {
      setInstallError(null);
      setInstallDone(null);
      const read = await readBundleFile(file);
      if (!read.ok) {
        setInstallError(read.message);
        return;
      }
      try {
        const result = await previewBundle.mutateAsync({ bundle: read.bundle });
        setFileBundle(read.bundle);
        setPreview(result);
      } catch (e) {
        setInstallError(
          e instanceof ApiError && e.status === 413
            ? 'This bundle is larger than the server allows.'
            : errMsg(e, 'Could not read the bundle')
        );
      }
    } finally {
      loadingFile.current = false;
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
        subtitle={
          <>
            Distribute library content (Agents, Skills, scanner patterns, Templates) across
            deployments. Install seeds a <strong>managed base layer</strong>; your team/template
            overrides sit on top. A bundle whose detached signature matches a deployment-trusted key
            installs as <strong>Verified</strong>, otherwise as <strong>Unverified</strong>{' '}
            (community).
          </>
        }
        title={navLabel('/studio/bundles')}
      />

      <Card>
        <CardHeader>
          <CardTitle>Export</CardTitle>
        </CardHeader>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-64">
            <Input
              label="Name"
              onChange={(e) => setExportForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="bundle"
              value={exportForm.name}
            />
          </div>
          <div className="w-full sm:w-64">
            <Input
              label="Version"
              onChange={(e) => setExportForm((f) => ({ ...f, version: e.target.value }))}
              value={exportForm.version}
            />
          </div>
          <div className="w-full sm:w-64">
            <Input
              label="Origin"
              onChange={(e) => setExportForm((f) => ({ ...f, origin: e.target.value }))}
              placeholder="swe-starter"
              value={exportForm.origin}
            />
          </div>
          <Button disabled={exportBundle.isPending} onClick={handleExport} variant="primary">
            {exportBundle.isPending ? 'Exporting…' : 'Export & download'}
          </Button>
        </div>
        <p className="mt-2 text-xs text-paper-500">
          Origin is the tag of the content to export. Leave it blank to export all platform-wide
          content. A blank name downloads as bundle.bundle.json.
        </p>
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
          <CardTitle>Install from file</CardTitle>
        </CardHeader>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target only; the file input inside is the keyboard path */}
        <div
          className={`rounded-md border border-dashed p-4 transition-colors ${
            dragging ? 'border-ember-400 bg-ember-500/5' : 'border-ink-400'
          }`}
          onDragEnter={() => {
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) {
              setDragging(false);
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            void handleFile(e.dataTransfer.files[0]);
          }}
        >
          <label className="label-mono mb-2 block" htmlFor="bundle-file">
            Bundle file (.json)
          </label>
          <input
            accept=".json,application/json"
            className="block w-full text-sm text-paper-300 file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-ink-400 file:bg-ink-600 file:px-3 file:py-1 file:text-paper-200"
            disabled={previewBundle.isPending}
            id="bundle-file"
            onChange={(e) => {
              void handleFile(e.target.files?.[0]);
              // Allow picking the same file again after a failed attempt.
              e.target.value = '';
            }}
            type="file"
          />
          <p className="mt-2 text-xs text-paper-500">
            Choose a file or drop it here. You review what it contains and what it replaces before
            anything is installed. Bundles up to 5 MB.
          </p>
        </div>
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
            <EmptyState
              className="py-4"
              hint="The built-in starter content is seeded with the platform, not installed from a bundle, so it is not listed here."
              title="No bundles installed yet."
            />
          ) : (
            <Table stacked>
              <THead>
                <Th variant="compact">Name</Th>
                <Th variant="compact">Version</Th>
                <Th variant="compact">Trust</Th>
                <Th variant="compact">Source</Th>
              </THead>
              <tbody>
                {bundles.map((b) => (
                  <TRow key={b.name}>
                    <Td className="py-2 pr-4 font-mono text-xs text-paper-100" primary>
                      {b.name}
                    </Td>
                    <Td className="py-2 pr-4 text-paper-300" label="Version">
                      {b.version}
                    </Td>
                    <Td className="py-2 pr-4" label="Trust">
                      <Badge tone={b.trustState === 'VERIFIED' ? 'moss' : 'amber'} variant="text">
                        {b.trustState === 'VERIFIED' ? 'Verified' : 'Unverified'}
                        {b.signedBy ? ` · ${b.signedBy}` : ''}
                      </Badge>
                    </Td>
                    <Td className="py-2 pr-4 text-xs text-paper-400" label="Source">
                      {b.source ?? '—'}
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </QueryBoundary>
      </Card>
      {preview && (
        <BundlePreviewModal
          onClose={() => {
            setPreview(null);
            setFileBundle(null);
          }}
          onInstall={async (overwriteProtected) => {
            const result =
              fileBundle !== null
                ? await installFromFile.mutateAsync({
                    bundle: fileBundle,
                    expectedContentHash: preview.contentHash,
                    overwriteProtected,
                  })
                : await installFromUrl.mutateAsync({
                    expectedContentHash: preview.contentHash,
                    overwriteProtected,
                    url: url.trim(),
                  });
            const c = result.counts;
            setInstallDone(
              `Installed ${preview.name} ${preview.version}: ${c.agents} agents, ${c.skills} skills, ${c.scannerPatterns} scanner rules, ${c.templates} templates.`
            );
            setUrl('');
            setFileBundle(null);
            return result;
          }}
          preview={preview}
        />
      )}
    </div>
  );
}
