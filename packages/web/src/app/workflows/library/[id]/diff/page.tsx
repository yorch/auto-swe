'use client';

import { parseWorkflowSpec } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, use, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { PromoteVersionModal } from '@/components/workflow/PromoteVersionModal';
import {
  TemplateBackLink,
  TemplateNotFound,
  TemplateSubNav,
} from '@/components/workflow/templateNav';
import { type DiffKind, WorkflowDag } from '@/components/workflow/WorkflowDag';
import { useLedTeamIds } from '@/hooks/useTeams';
import { useWorkflowSpecDiff, useWorkflowTemplate } from '@/hooks/useTemplates';
import { errMsg } from '@/lib/errors';
import { validateRouteParam } from '@/lib/routeParams';
import { diffFields, type FieldChange, orientVersions } from '@/lib/specDiff';
import { canWriteTeamResource } from '@/lib/teamPermissions';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

interface PageProps {
  params: Promise<{ id: string }>;
}

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

const GLYPH: Record<FieldChange['kind'], string> = { added: '+', changed: '~', removed: '−' };
const GLYPH_LABEL: Record<FieldChange['kind'], string> = {
  added: 'added',
  changed: 'changed',
  removed: 'removed',
};
const GLYPH_CLASS: Record<FieldChange['kind'], string> = {
  added: 'text-moss-400',
  changed: 'text-amber-400',
  removed: 'text-brick-400',
};

function show(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : (JSON.stringify(v) ?? 'undefined');
}

/** The changed fields of one node: each row carries a +/−/~ glyph and a word, so it never relies on colour alone. */
function NodeFieldDiff({
  nodeId,
  title,
  before,
  after,
}: {
  nodeId: string;
  title: string | null;
  before: unknown;
  after: unknown;
}) {
  const changes = diffFields(before, after);
  return (
    <details className="rounded-lg border border-ink-600 bg-ink-900/50" open>
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-2 text-sm text-paper-100">
        <span className="min-w-0 truncate">
          {title ?? nodeId}
          {title && <span className="ml-2 font-mono text-[11px] text-paper-500">{nodeId}</span>}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-paper-500">
          {changes.length} field{changes.length === 1 ? '' : 's'} changed
        </span>
      </summary>
      <ul className="space-y-1 border-t border-ink-600 p-3 font-mono text-[11px] leading-relaxed">
        {changes.map((c) => (
          <li className="flex flex-wrap items-baseline gap-x-2" key={c.path}>
            <span className={cn('w-4 shrink-0 text-center font-bold', GLYPH_CLASS[c.kind])}>
              {GLYPH[c.kind]}
              <span className="sr-only">{GLYPH_LABEL[c.kind]}</span>
            </span>
            <span className="text-paper-200">{c.path}</span>
            {c.kind !== 'added' && (
              <span className="break-all text-paper-500 line-through">{show(c.before)}</span>
            )}
            {c.kind === 'changed' && <span className="text-paper-400">→</span>}
            {c.kind !== 'removed' && (
              <span className="break-all text-paper-100">{show(c.after)}</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function nodeTitle(node: unknown): string | null {
  const t = (node as { title?: unknown } | undefined)?.title;
  return typeof t === 'string' && t ? t : null;
}

export default function TemplateDiffPage({ params }: PageProps) {
  return (
    <Suspense>
      <TemplateDiffContent params={params} />
    </Suspense>
  );
}

function TemplateDiffContent({ params }: PageProps) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const search = useSearchParams();
  const {
    data: template,
    isLoading: templateLoading,
    isError: templateError,
    error: templateErr,
  } = useWorkflowTemplate(id ?? '');
  const platformRole = useAuthStore((s) => s.user?.role);
  const ledTeamIds = useLedTeamIds();
  const canManage = canWriteTeamResource(platformRole, template?.team?.id, ledTeamIds);
  const sortedVersions = useMemo(
    () => (template ? [...template.versions].sort((a, b) => b.version - a.version) : []),
    [template]
  );
  // The user's explicit picks (or the ?a=&b= of a link); until then the active
  // version against the newest other one.
  const [picked, setPicked] = useState<{ x: number | null; y: number | null }>(() => {
    const qa = Number(search.get('a'));
    const qb = Number(search.get('b'));
    return {
      x: Number.isInteger(qa) && qa > 0 ? qa : null,
      y: Number.isInteger(qb) && qb > 0 ? qb : null,
    };
  });
  const [reversed, setReversed] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);

  const defaultX = template?.activeVersion ?? sortedVersions[0]?.version ?? null;
  const x = picked.x ?? defaultX;
  const y =
    picked.y ?? sortedVersions.find((v) => v.version !== x)?.version ?? (x !== null ? x : null);
  const pair = x !== null && y !== null ? orientVersions(x, y, reversed) : null;
  const before = pair?.before ?? null;
  const after = pair?.after ?? null;

  const {
    data: diffPayload,
    isLoading,
    isError: isDiffError,
    error: diffError,
  } = useWorkflowSpecDiff(id ?? '', before, after);

  const { specPair, parseError } = useMemo(() => {
    if (!diffPayload) {
      return { parseError: null, specPair: null };
    }
    try {
      return {
        parseError: null,
        specPair: {
          specA: parseWorkflowSpec(diffPayload.a.spec),
          specB: parseWorkflowSpec(diffPayload.b.spec),
        },
      };
    } catch (err) {
      return {
        parseError: errMsg(err, 'Failed to parse one of the workflow specs'),
        specPair: null,
      };
    }
  }, [diffPayload]);

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

  if (!id) {
    return <TemplateNotFound />;
  }

  const afterRow = template?.versions.find((v) => v.version === after);
  const afterNeedsReview = !!afterRow?.generatedBy && !afterRow.reviewedAt;
  const canPromote =
    canManage && after !== null && template !== undefined && after !== template.activeVersion;
  const singleVersion = template !== undefined && template.versions.length < 2;

  return (
    <div className="space-y-8">
      <div>
        <TemplateBackLink href={`/workflows/library/${id}`} label={template?.name ?? 'Template'} />
        <PageHeader
          actions={
            <div className="flex flex-wrap items-end gap-4">
              <VersionSelect
                activeVersion={template?.activeVersion ?? null}
                label="Version"
                onChange={(v) => setPicked({ x: v, y })}
                value={x}
                versions={sortedVersions}
              />
              <VersionSelect
                activeVersion={template?.activeVersion ?? null}
                label="Compare with"
                onChange={(v) => setPicked({ x, y: v })}
                value={y}
                versions={sortedVersions}
              />
              <Button
                aria-label="Swap before and after"
                disabled={x === y}
                onClick={() => setReversed((r) => !r)}
                size="sm"
                variant="secondary"
              >
                ⇄ Swap
              </Button>
              {canPromote && !afterNeedsReview && (
                <Button onClick={() => setPromoteOpen(true)} size="sm" variant="primary">
                  Promote v{after}
                </Button>
              )}
            </div>
          }
          chapter="§ Workflows"
          className="mb-0 mt-4"
          subtitle={
            before !== null && after !== null && before !== after
              ? `Before (v${before}) → After (v${after}). Changed nodes are highlighted on both diagrams and expanded below.`
              : 'Side-by-side diff of two versions of this template.'
          }
          title="Version diff"
        />
        {canPromote && afterNeedsReview && (
          <p className="mt-2 text-xs text-paper-500">
            v{after} is AI-generated and needs review before it can be promoted. Review it from the{' '}
            <Link className="text-ember-400 hover:underline" href={`/workflows/library/${id}`}>
              template page
            </Link>
            .
          </p>
        )}
      </div>

      <TemplateSubNav active="compare" templateId={id} />

      {after !== null && (
        <PromoteVersionModal
          activeVersion={template?.activeVersion ?? null}
          hideDiffLink
          onClose={() => setPromoteOpen(false)}
          open={promoteOpen}
          templateId={id}
          version={after}
        />
      )}

      <QueryBoundary
        error={templateErr}
        isError={templateError}
        isLoading={templateLoading}
        label="template"
      >
        {singleVersion || (before !== null && before === after) ? (
          <EmptyState
            hint="Compare needs two versions of this template."
            title="Only one version — save a change to compare"
          />
        ) : (
          <QueryBoundary
            error={diffError}
            isError={isDiffError}
            isLoading={isLoading}
            label="the diff"
            loadingMessage="computing diff…"
          >
            {parseError && <Alert>{parseError}</Alert>}
            {diffPayload && !parseError && specPair && (
              <DiffBody
                changedNodeDiffs={changedNodeDiffs}
                diffPayload={diffPayload}
                specPair={specPair}
              />
            )}
          </QueryBoundary>
        )}
      </QueryBoundary>
    </div>
  );
}

function DiffBody({
  diffPayload,
  specPair,
  changedNodeDiffs,
}: {
  diffPayload: NonNullable<ReturnType<typeof useWorkflowSpecDiff>['data']>;
  specPair: {
    specA: ReturnType<typeof parseWorkflowSpec>;
    specB: ReturnType<typeof parseWorkflowSpec>;
  };
  changedNodeDiffs: Array<{ nodeId: string; before: unknown; after: unknown }>;
}) {
  return (
    <div className="space-y-8">
      <section>
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
            {(diffPayload.diff.presentationOnlyNodes?.length ?? 0) > 0 && (
              <li
                className="font-mono text-[11px] uppercase tracking-wider text-paper-500"
                title={(diffPayload.diff.presentationOnlyNodes ?? []).join(', ')}
              >
                Group / title only: {diffPayload.diff.presentationOnlyNodes?.length}
              </li>
            )}
            {diffPayload.diff.metaChanges.length > 0 && (
              <li className="mt-3 border-t border-ink-600 pt-3">
                <div className="label-mono mb-2">Metadata changes</div>
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

      {changedNodeDiffs.length > 0 && (
        <section>
          <SectionHeader hint="only changed fields" number="02" title="Changed node details" />
          <div className="space-y-2">
            {changedNodeDiffs.map(({ nodeId, before, after }) => (
              <NodeFieldDiff
                after={after}
                before={before}
                key={nodeId}
                nodeId={nodeId}
                title={nodeTitle(after) ?? nodeTitle(before)}
              />
            ))}
          </div>
        </section>
      )}

      <section>
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
    <Select
      className="w-auto"
      compact
      id={selectId}
      label={label}
      onChange={(v) => onChange(Number(v))}
      options={versions.map((v) => ({
        label: `v${v.version}${v.version === activeVersion ? ' (active)' : ''}`,
        value: String(v.version),
      }))}
      value={value == null ? '' : String(value)}
    />
  );
}
