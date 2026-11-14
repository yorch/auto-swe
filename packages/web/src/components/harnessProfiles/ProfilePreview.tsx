'use client';

import { Fragment, useState } from 'react';
import { FullText } from '@/components/skills/FullText';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import type { HarnessProfilePreview, ReviewedFile } from '@/hooks/useHarnessProfiles';
import { visibleText } from '@/lib/visibleText';
import { formatBytes, keyed, shortSha } from './profileDisplay';

/**
 * What a preview found, all of it repository-derived and therefore shown through `visibleText`:
 * the manifest, the commit, every file (each one can be opened and read), and the warnings the
 * approval will have to acknowledge. Mount it with a `key` that changes with the preview so
 * the files already read never outlive the commit they came from.
 */
export function ProfilePreview({
  onReadFile,
  preview,
}: {
  preview: HarnessProfilePreview;
  onReadFile: (path: string) => Promise<ReviewedFile>;
}) {
  const [reading, setReading] = useState<string | null>(null);
  const [read, setRead] = useState<Record<string, ReviewedFile>>({});
  const [readErrors, setReadErrors] = useState<Record<string, string>>({});
  const { manifest } = preview;

  async function readFile(path: string) {
    setReading(path);
    setReadErrors((cur) => ({ ...cur, [path]: '' }));
    try {
      const r = await onReadFile(path);
      setRead((cur) => ({ ...cur, [path]: r }));
    } catch (err) {
      setReadErrors((cur) => ({
        ...cur,
        [path]: visibleText(err instanceof Error ? err.message : 'Failed to read the file'),
      }));
    } finally {
      setReading(null);
    }
  }

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-paper-500">Name</dt>
        <dd className="font-medium text-paper-100">{visibleText(manifest.name)}</dd>
        <dt className="text-paper-500">Description</dt>
        <dd className="text-paper-300">{visibleText(manifest.description)}</dd>
        <dt className="text-paper-500">Commit</dt>
        <dd className="font-mono text-xs text-paper-300" title={preview.sha}>
          {visibleText(preview.sha)}
        </dd>
        <dt className="text-paper-500">Content</dt>
        <dd className="font-mono text-xs text-paper-400" title={preview.contentHash}>
          {shortSha(preview.contentHash)} · {preview.files.length} file
          {preview.files.length === 1 ? '' : 's'} · {formatBytes(preview.totalBytes)}
        </dd>
        {manifest.instructions && (
          <>
            <dt className="text-paper-500">Instructions</dt>
            <dd className="font-mono text-xs text-paper-300">
              {visibleText(manifest.instructions)}
            </dd>
          </>
        )}
        <dt className="text-paper-500">Plugins</dt>
        <dd className="font-mono text-xs text-paper-300">
          {manifest.plugins?.length
            ? manifest.plugins.map((p) => visibleText(p)).join(', ')
            : 'none'}
        </dd>
        <dt className="text-paper-500">Extra tools</dt>
        <dd className="text-paper-300">
          {manifest.tools?.length ? manifest.tools.map((t) => visibleText(t)).join(', ') : 'none'}
        </dd>
      </dl>

      {preview.warnings.length === 0 ? (
        <Alert announce={false} variant="success">
          The folder is valid and the scanners found nothing to report. Scanning is advisory: read
          the files.
        </Alert>
      ) : (
        <Alert announce={false} title={`${preview.warnings.length} warning(s)`} variant="warning">
          <ul className="list-disc space-y-0.5 pl-5">
            {keyed(preview.warnings).map((w) => (
              <li key={w.key}>{visibleText(w.text)}</li>
            ))}
          </ul>
        </Alert>
      )}

      <Table>
        <THead>
          <Th variant="compact">File</Th>
          <Th variant="compact">Size</Th>
          <Th variant="compact">Mode</Th>
          <Th variant="compact" />
        </THead>
        <tbody>
          {preview.files.map((f) => {
            const file = read[f.path];
            const label = visibleText(f.path);
            return (
              <Fragment key={f.path}>
                <TRow>
                  <Td className="py-2 pr-4 align-top font-mono text-xs text-paper-200 break-all">
                    {label}
                  </Td>
                  <Td className="py-2 pr-4 align-top tabular-nums text-paper-400">
                    {formatBytes(f.size)}
                  </Td>
                  <Td className="py-2 pr-4 align-top">
                    {f.mode === '100755' ? (
                      <Badge tone="warning">executable</Badge>
                    ) : (
                      <span className="text-xs text-paper-500">file</span>
                    )}
                  </Td>
                  <Td className="py-2 align-top">
                    <Button
                      aria-label={`Read ${label}`}
                      disabled={reading === f.path}
                      onClick={() => readFile(f.path)}
                      size="sm"
                    >
                      {reading === f.path ? 'Reading…' : file ? 'Read again' : 'Read'}
                    </Button>
                    {readErrors[f.path] && (
                      <div className="mt-1 text-xs text-danger-400">{readErrors[f.path]}</div>
                    )}
                  </Td>
                </TRow>
                {file && (
                  <TRow>
                    <Td className="pb-3" colSpan={4}>
                      {file.binary || file.text === null ? (
                        <Alert announce={false} variant="info">
                          Binary file; its content cannot be shown.
                        </Alert>
                      ) : (
                        <>
                          <FullText label={`Content of ${label}`} text={file.text} />
                          {file.truncated && (
                            <p className="mt-1 text-xs text-warning-400">
                              Cut at 200,000 characters; the rest of this file is not shown.
                            </p>
                          )}
                        </>
                      )}
                    </Td>
                  </TRow>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
