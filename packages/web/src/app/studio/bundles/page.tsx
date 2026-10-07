'use client';

import { useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
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
import { cn } from '@/lib/utils';
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
    <div className="space-y-6">
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

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="p-5 sm:p-6 lg:col-span-3">
          <CardHeader>
            <CardTitle eyebrow="Install">Add a bundle</CardTitle>
          </CardHeader>
          <p className="-mt-1 mb-5 text-[13px] leading-relaxed text-paper-400">
            Load a bundle from a URL or a file. You review what it contains and what it replaces
            before anything is installed.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 basis-64">
              <Input
                className="font-mono"
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

          <div aria-hidden className="my-5 flex items-center gap-3 text-xs text-paper-500">
            <span className="h-px flex-1 bg-ink-600" />
            or
            <span className="h-px flex-1 bg-ink-600" />
          </div>

          {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target only; the file input inside is the keyboard path */}
          <div
            className={cn(
              'flex flex-col items-center rounded-lg border border-dashed px-4 py-6 text-center transition-colors',
              dragging ? 'border-ember-400 bg-ember-500/5' : 'border-ink-400 bg-ink-900/30'
            )}
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
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-ink-400 bg-ink-700 text-paper-400">
              <Icon name="package" size={18} />
            </div>
            <label className="mb-3 text-sm font-medium text-paper-200" htmlFor="bundle-file">
              Bundle file (.json)
            </label>
            <input
              accept=".json,application/json"
              className="block max-w-full text-[13px] text-paper-400 file:mr-3 file:h-8 file:cursor-pointer file:rounded-lg file:border file:border-ink-400 file:bg-ink-600 file:px-4 file:text-[13px] file:text-paper-200 hover:file:bg-ink-500"
              disabled={previewBundle.isPending}
              id="bundle-file"
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
                // Allow picking the same file again after a failed attempt.
                e.target.value = '';
              }}
              type="file"
            />
            <p className="mt-3 text-xs text-paper-500">
              Choose a file or drop it here. Bundles up to 5 MB.
            </p>
          </div>
          {installError && (
            <Alert className="mt-4" variant="error">
              {installError}
            </Alert>
          )}
          {installDone && (
            <Alert className="mt-4" variant="success">
              {installDone}
            </Alert>
          )}
        </Card>

        <Card className="p-5 sm:p-6 lg:col-span-2">
          <CardHeader>
            <CardTitle eyebrow="Export">Download a bundle</CardTitle>
          </CardHeader>
          <p className="-mt-1 mb-5 text-[13px] leading-relaxed text-paper-400">
            Package this deployment&apos;s library content as a bundle file to install elsewhere.
          </p>
          <div className="space-y-4">
            <Input
              hint="A blank name downloads as bundle.bundle.json."
              label="Name"
              onChange={(e) => setExportForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="bundle"
              value={exportForm.name}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                className="font-mono"
                label="Version"
                onChange={(e) => setExportForm((f) => ({ ...f, version: e.target.value }))}
                value={exportForm.version}
              />
              <Input
                className="font-mono"
                label="Origin"
                onChange={(e) => setExportForm((f) => ({ ...f, origin: e.target.value }))}
                placeholder="swe-starter"
                value={exportForm.origin}
              />
            </div>
            <p className="text-xs text-paper-500">
              Origin is the tag of the content to export. Leave it blank to export all platform-wide
              content.
            </p>
          </div>
          {exportError && (
            <Alert className="mt-4" variant="error">
              {exportError}
            </Alert>
          )}
          {exportDone && (
            <Alert className="mt-4" variant="success">
              {exportDone}
            </Alert>
          )}
          <div className="mt-5 flex justify-end border-t border-ink-600 pt-4">
            <Button disabled={exportBundle.isPending} onClick={handleExport}>
              <Icon name="download" size={14} />
              {exportBundle.isPending ? 'Exporting…' : 'Export and download'}
            </Button>
          </div>
        </Card>
      </div>

      <Card className="p-5 sm:p-6">
        <CardHeader>
          <CardTitle eyebrow="Library">Installed bundles</CardTitle>
          {bundles && bundles.length > 0 && (
            <span className="text-xs text-paper-500 tabular-nums">{bundles.length} installed</span>
          )}
        </CardHeader>
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="bundles"
          loading={<SkeletonRows rows={3} />}
          onRetry={() => void refetch()}
        >
          {!bundles || bundles.length === 0 ? (
            <EmptyState
              bordered
              hint="The built-in starter content is seeded with the platform, not installed from a bundle, so it is not listed here."
              icon="package"
              title="No bundles installed yet"
            />
          ) : (
            <Table stacked>
              <THead>
                <Th className="pl-0" variant="plain">
                  Name
                </Th>
                <Th variant="plain">Version</Th>
                <Th variant="plain">Trust</Th>
                <Th className="pr-0" variant="plain">
                  Source
                </Th>
              </THead>
              <tbody>
                {bundles.map((b) => (
                  <TRow key={b.name}>
                    <Td
                      className="py-2.5 pr-4 font-mono text-[13px] font-medium text-paper-100"
                      primary
                    >
                      {b.name}
                    </Td>
                    <Td className="px-4 py-2.5 font-mono text-xs text-paper-300" label="Version">
                      {b.version}
                    </Td>
                    <Td className="px-4 py-2.5" label="Trust">
                      <Badge dot tone={b.trustState === 'VERIFIED' ? 'moss' : 'amber'}>
                        {b.trustState === 'VERIFIED' ? 'Verified' : 'Unverified'}
                        {b.signedBy ? ` · ${b.signedBy}` : ''}
                      </Badge>
                    </Td>
                    <Td
                      className="max-w-xs truncate py-2.5 pl-4 font-mono text-xs text-paper-400"
                      label="Source"
                      title={b.source ?? undefined}
                    >
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
