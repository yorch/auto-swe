'use client';

import { parseWorkflowSpec } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { TabBar } from '@/components/ui/TabBar';
import { type DiffKind, WorkflowDag } from '@/components/workflow/WorkflowDag';
import { useWorkflowSpecDiff, useWorkflowTemplate } from '@/hooks/useTemplates';
import { errMsg } from '@/lib/errors';
import { cn } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

type SubTab = 'editor' | 'analytics' | 'runs' | 'compare';

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'editor', label: 'Editor' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'runs', label: 'Run history' },
  { id: 'compare', label: 'Compare versions' },
];

function diffMarkers(
  diff: { addedNodes: string[]; changedNodes: string[]; removedNodes: string[] },
  side: 'a' | 'b'
): Record<string, DiffKind> {
  const out: Record<string, DiffKind> = {};
  if (side === 'a') {
    for (const id of diff.removedNodes) {
      out[id] = 'removed';
    }
    for (const id of diff.changedNodes) {
      out[id] = 'changed';
    }
  } else {
    for (const id of diff.addedNodes) {
      out[id] = 'added';
    }
    for (const id of diff.changedNodes) {
      out[id] = 'changed';
    }
  }
  return out;
}

function NodeJsonDiff({
  nodeId,
  before,
  after,
}: {
  nodeId: string;
  before: unknown;
  after: unknown;
}) {
  const beforeStr = JSON.stringify(before, null, 2);
  const afterStr = JSON.stringify(after, null, 2);

  return (
    <details className="rounded-lg border border-ink-600 bg-ink-900/50">
      <summary className="flex cursor-pointer items-center justify-between px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-amber-400 hover:text-amber-300">
        <span>changed · {nodeId}</span>
        <span className="text-paper-600">▸</span>
      </summary>
      <div className="grid grid-cols-1 gap-px border-t border-ink-600 xl:grid-cols-2">
        <div className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[9px] uppercase tracking-wider text-paper-500">
              Before
            </span>
            <CopyButton value={beforeStr} />
          </div>
          <pre className="overflow-auto rounded-sm bg-ink-950/60 p-2 font-mono text-[10px] leading-relaxed text-brick-400/80">
            {beforeStr}
          </pre>
        </div>
        <div className="border-t border-ink-600 p-3 xl:border-l xl:border-t-0">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[9px] uppercase tracking-wider text-paper-500">
              After
            </span>
            <CopyButton value={afterStr} />
          </div>
          <pre className="overflow-auto rounded-sm bg-ink-950/60 p-2 font-mono text-[10px] leading-relaxed text-moss-400/80">
            {afterStr}
          </pre>
        </div>
      </div>
    </details>
  );
}

export default function TemplateDiffPage({ params }: PageProps) {
  const router = useRouter();
  const { id } = use(params);
  const { data: template } = useWorkflowTemplate(id);
  const sortedVersions = useMemo(
    () => (template ? [...template.versions].sort((a, b) => b.version - a.version) : []),
    [template]
  );
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);

  useEffect(() => {
    if (!template || sortedVersions.length === 0) {
      return;
    }
    const defaultA = template.activeVersion ?? sortedVersions[0]?.version ?? null;
    if (a === null) {
      setA(defaultA);
    }
    if (b === null) {
      const defaultB = sortedVersions.find((v) => v.version !== defaultA)?.version ?? defaultA;
      setB(defaultB);
    }
  }, [template, sortedVersions, a, b]);

  const {
    data: diffPayload,
    isLoading,
    isError: isDiffError,
    error: diffError,
  } = useWorkflowSpecDiff(id, a, b);
  const [parseError, setParseError] = useState<string | null>(null);

  const specPair = useMemo(() => {
    setParseError(null);
    if (!diffPayload) {
      return null;
    }
    try {
      const specA = parseWorkflowSpec(diffPayload.a.spec);
      const specB = parseWorkflowSpec(diffPayload.b.spec);
      return { specA, specB };
    } catch (err) {
      setParseError(errMsg(err, 'Failed to parse one of the workflow specs'));
      return null;
    }
  }, [diffPayload]);

  const handleTabChange = (tab: SubTab) => {
    if (tab === 'editor') {
      router.push(`/templates/${id}`);
    } else if (tab === 'analytics') {
      router.push(`/templates/${id}/analytics`);
    } else if (tab === 'runs') {
      router.push(`/templates/${id}/runs`);
    }
  };

  const changedNodeDiffs = useMemo(() => {
    if (!diffPayload || !specPair) {
      return [];
    }
    return diffPayload.diff.changedNodes.map((nodeId) => ({
      after: specPair.specB.nodes[nodeId],
      before: specPair.specA.nodes[nodeId],
      nodeId,
    }));
  }, [diffPayload, specPair]);

  return (
    <div className="space-y-10">
      <div className="fade-up">
        <Link
          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500 transition-colors hover:text-ember-400"
          href={`/templates/${id}`}
        >
          <span>←</span> {template?.name ?? 'template'}
        </Link>
        <div className="mt-4">
          <PageHeader
            actions={
              <div className="flex flex-wrap items-end gap-4">
                <VersionSelect
                  activeVersion={template?.activeVersion ?? null}
                  label="A · before"
                  onChange={setA}
                  value={a}
                  versions={sortedVersions}
                />
                <VersionSelect
                  activeVersion={template?.activeVersion ?? null}
                  label="B · after"
                  onChange={setB}
                  value={b}
                  versions={sortedVersions}
                />
                {a !== null && b !== null && a === b && (
                  <span className="font-mono text-[10px] uppercase tracking-wider text-amber-400">
                    ! pick two distinct versions
                  </span>
                )}
              </div>
            }
            chapter="§ Compare versions"
            subtitle="Side-by-side diff of two versions of this template. Changed nodes are highlighted on both diagrams and expanded below."
            title="Version diff."
          />
        </div>
      </div>

      <TabBar active="compare" className="fade-up" onChange={handleTabChange} tabs={SUB_TABS} />

      {isLoading && (
        <div className="fade-up stagger-1 flex items-center justify-center py-12 font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500">
          <span className="pulse-dot mr-3 inline-block h-1.5 w-1.5 rounded-full bg-ember-400" />
          computing diff…
        </div>
      )}

      {(isDiffError || parseError) && (
        <Alert>{parseError ?? errMsg(diffError, 'Failed to load diff')}</Alert>
      )}

      {diffPayload && !parseError && specPair && (
        <>
          <section className="fade-up stagger-1">
            <SectionHeader hint="changes" number="01" title="Summary" />
            <Card variant="inset">
              <ul className="space-y-2 text-sm">
                <DiffStat
                  count={diffPayload.diff.addedNodes.length}
                  ids={diffPayload.diff.addedNodes}
                  label="Added"
                  tone="moss"
                />
                <DiffStat
                  count={diffPayload.diff.removedNodes.length}
                  ids={diffPayload.diff.removedNodes}
                  label="Removed"
                  tone="brick"
                />
                <DiffStat
                  count={diffPayload.diff.changedNodes.length}
                  ids={diffPayload.diff.changedNodes}
                  label="Changed"
                  tone="amber"
                />
                <li className="font-mono text-[11px] uppercase tracking-wider text-paper-500">
                  Unchanged: {diffPayload.diff.unchangedNodes.length}
                </li>
                {diffPayload.diff.metaChanges.length > 0 && (
                  <li className="mt-3 border-t border-ink-600 pt-3">
                    <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
                      Metadata changes
                    </div>
                    <ul className="space-y-1 text-xs">
                      {diffPayload.diff.metaChanges.map((m) => (
                        <li className="font-mono" key={m.field}>
                          <span className="text-paper-200">{m.field}</span>:{' '}
                          <span className="text-paper-500 line-through">
                            {JSON.stringify(m.before)}
                          </span>{' '}
                          <span className="text-paper-400">→</span>{' '}
                          <span className="text-ember-400">{JSON.stringify(m.after)}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                )}
              </ul>
            </Card>
          </section>

          {/* Per-changed-node JSON diff */}
          {changedNodeDiffs.length > 0 && (
            <section className="fade-up stagger-2">
              <SectionHeader hint="field-level" number="02" title="Changed node details" />
              <div className="space-y-2">
                {changedNodeDiffs.map(({ nodeId, before, after }) => (
                  <NodeJsonDiff after={after} before={before} key={nodeId} nodeId={nodeId} />
                ))}
              </div>
            </section>
          )}

          <section className="fade-up stagger-3">
            <SectionHeader
              hint="side-by-side"
              number={changedNodeDiffs.length > 0 ? '03' : '02'}
              title="Topology"
            />
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle eyebrow="before">v{diffPayload.a.version}</CardTitle>
                </CardHeader>
                <WorkflowDag
                  diffMarkers={diffMarkers(diffPayload.diff, 'a')}
                  height={520}
                  spec={specPair.specA}
                />
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle eyebrow="after">v{diffPayload.b.version}</CardTitle>
                </CardHeader>
                <WorkflowDag
                  diffMarkers={diffMarkers(diffPayload.diff, 'b')}
                  height={520}
                  spec={specPair.specB}
                />
              </Card>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function DiffStat({
  label,
  count,
  ids,
  tone,
}: {
  label: string;
  count: number;
  ids: string[];
  tone: 'moss' | 'brick' | 'amber';
}) {
  const dotClass =
    tone === 'moss' ? 'bg-moss-400' : tone === 'brick' ? 'bg-brick-400' : 'bg-amber-400';
  const textClass =
    tone === 'moss' ? 'text-moss-400' : tone === 'brick' ? 'text-brick-400' : 'text-amber-400';
  return (
    <li className="flex items-baseline gap-2">
      <span className={cn('inline-block h-1.5 w-1.5 rounded-full', dotClass)} />
      <span className="font-mono text-[11px] uppercase tracking-wider text-paper-300">
        {label}:
      </span>
      <span className={cn('tabular font-mono text-sm', textClass)}>{count}</span>
      {ids.length > 0 && (
        <span className="truncate font-mono text-[11px] text-paper-500">[{ids.join(', ')}]</span>
      )}
    </li>
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
  const selectId = `version-${label.replace(/[^a-z]/gi, '-').toLowerCase()}`;
  return (
    <div className="space-y-1.5">
      <label
        className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
        htmlFor={selectId}
      >
        {label}
      </label>
      <Select
        className="h-9 w-auto px-2 font-mono text-xs"
        id={selectId}
        onChange={(e) => onChange(Number(e.target.value))}
        value={value ?? ''}
      >
        {versions.map((v) => (
          <option key={v.id} value={v.version}>
            v{v.version}
            {v.version === activeVersion ? ' (active)' : ''}
          </option>
        ))}
      </Select>
    </div>
  );
}
