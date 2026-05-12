'use client';

import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { type DiffKind, WorkflowDag } from '@/components/workflow/WorkflowDag';
import { useWorkflowSpecDiff, useWorkflowTemplate } from '@/hooks/useWorkflows';

interface PageProps {
  params: Promise<{ id: string }>;
}

function diffMarkers(
  diff: { addedNodes: string[]; changedNodes: string[]; removedNodes: string[] },
  side: 'a' | 'b'
): Record<string, DiffKind> {
  const out: Record<string, DiffKind> = {};
  if (side === 'a') {
    for (const id of diff.removedNodes) out[id] = 'removed';
    for (const id of diff.changedNodes) out[id] = 'changed';
  } else {
    for (const id of diff.addedNodes) out[id] = 'added';
    for (const id of diff.changedNodes) out[id] = 'changed';
  }
  return out;
}

export default function TemplateDiffPage({ params }: PageProps) {
  const { id } = use(params);
  const { data: template } = useWorkflowTemplate(id);
  const sortedVersions = useMemo(
    () => (template ? [...template.versions].sort((a, b) => b.version - a.version) : []),
    [template]
  );
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);

  // Default A to active (or newest if no active), B to a distinct neighbour so
  // the first diff render is meaningful — fall back to A only when there's a
  // single version, in which case the equality guard below disables the diff.
  useEffect(() => {
    if (!template || sortedVersions.length === 0) return;
    const defaultA = template.activeVersion ?? sortedVersions[0]?.version ?? null;
    if (a === null) setA(defaultA);
    if (b === null) {
      const defaultB = sortedVersions.find((v) => v.version !== defaultA)?.version ?? defaultA;
      setB(defaultB);
    }
  }, [template, sortedVersions, a, b]);

  const { data: diffPayload, isLoading } = useWorkflowSpecDiff(id, a, b);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link className="text-[var(--primary)] hover:underline text-sm" href={`/templates/${id}`}>
          &larr; {template?.name ?? 'Template'}
        </Link>
        <h2 className="text-2xl font-bold">Compare versions</h2>
      </div>

      <Card>
        <div className="flex items-center gap-4">
          <VersionSelect
            activeVersion={template?.activeVersion ?? null}
            label="A"
            onChange={setA}
            value={a}
            versions={sortedVersions}
          />
          <VersionSelect
            activeVersion={template?.activeVersion ?? null}
            label="B"
            onChange={setB}
            value={b}
            versions={sortedVersions}
          />
          {a !== null && b !== null && a === b && (
            <span className="text-xs text-[var(--muted-foreground)]">
              Pick two distinct versions to compare.
            </span>
          )}
        </div>
      </Card>

      {isLoading && (
        <div className="text-center py-12 text-[var(--muted-foreground)]">Computing diff…</div>
      )}

      {diffPayload && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <ul className="text-sm space-y-1">
              <li>
                <span className="inline-block w-2 h-2 rounded-full bg-green-600 mr-2" />
                Added: <span className="font-mono">{diffPayload.diff.addedNodes.length}</span>{' '}
                {diffPayload.diff.addedNodes.length > 0 && (
                  <span className="text-[var(--muted-foreground)] text-xs">
                    [{diffPayload.diff.addedNodes.join(', ')}]
                  </span>
                )}
              </li>
              <li>
                <span className="inline-block w-2 h-2 rounded-full bg-red-600 mr-2" />
                Removed: <span className="font-mono">{diffPayload.diff.removedNodes.length}</span>{' '}
                {diffPayload.diff.removedNodes.length > 0 && (
                  <span className="text-[var(--muted-foreground)] text-xs">
                    [{diffPayload.diff.removedNodes.join(', ')}]
                  </span>
                )}
              </li>
              <li>
                <span className="inline-block w-2 h-2 rounded-full bg-amber-600 mr-2" />
                Changed: <span className="font-mono">{diffPayload.diff.changedNodes.length}</span>{' '}
                {diffPayload.diff.changedNodes.length > 0 && (
                  <span className="text-[var(--muted-foreground)] text-xs">
                    [{diffPayload.diff.changedNodes.join(', ')}]
                  </span>
                )}
              </li>
              <li className="text-[var(--muted-foreground)]">
                Unchanged: {diffPayload.diff.unchangedNodes.length}
              </li>
              {diffPayload.diff.metaChanges.length > 0 && (
                <li className="pt-2 border-t border-[var(--border)] mt-2">
                  <span className="text-xs font-medium">Metadata changes:</span>
                  <ul className="ml-4 mt-1 text-xs space-y-1">
                    {diffPayload.diff.metaChanges.map((m) => (
                      <li key={m.field}>
                        <span className="font-mono">{m.field}</span>:{' '}
                        <span className="line-through text-[var(--muted-foreground)]">
                          {JSON.stringify(m.before)}
                        </span>{' '}
                        → <span className="font-mono">{JSON.stringify(m.after)}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              )}
            </ul>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>v{diffPayload.a.version} (before)</CardTitle>
              </CardHeader>
              <div className="overflow-x-auto">
                <WorkflowDag
                  diffMarkers={diffMarkers(diffPayload.diff, 'a')}
                  spec={diffPayload.a.spec as WorkflowSpec}
                />
              </div>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>v{diffPayload.b.version} (after)</CardTitle>
              </CardHeader>
              <div className="overflow-x-auto">
                <WorkflowDag
                  diffMarkers={diffMarkers(diffPayload.diff, 'b')}
                  spec={diffPayload.b.spec as WorkflowSpec}
                />
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

interface VersionSelectProps {
  label: string;
  versions: Array<{ id: string; version: number }>;
  value: number | null;
  onChange: (v: number) => void;
  activeVersion: number | null;
}

function VersionSelect({ label, versions, value, onChange, activeVersion }: VersionSelectProps) {
  return (
    <label className="text-sm flex items-center gap-2">
      <span className="text-[var(--muted-foreground)]">{label}</span>
      <select
        className="px-2 py-1 border border-[var(--border)] rounded text-sm bg-[var(--background)]"
        onChange={(e) => onChange(Number(e.target.value))}
        value={value ?? ''}
      >
        {versions.map((v) => (
          <option key={v.id} value={v.version}>
            v{v.version}
            {v.version === activeVersion ? ' (active)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
