'use client';

import { parseWorkflowSpec } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, use, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { PageHeader } from '@/components/ui/PageHeader';
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
import { cn, FOCUS_RING } from '@/lib/utils';
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
    <details className="group rounded-lg border border-ink-600 bg-ink-900/50" open>
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-2.5 text-sm text-paper-100 [&::-webkit-details-marker]:hidden',
          FOCUS_RING
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Icon
            className="text-paper-500 transition-transform group-open:rotate-90"
            name="chevronRight"
            size={13}
          />
          <span className="truncate font-medium">{title ?? nodeId}</span>
          {title && <span className="truncate font-mono text-xs text-paper-500">{nodeId}</span>}
        </span>
        <span className="shrink-0 text-xs text-paper-500 tabular-nums">
          {changes.length} field{changes.length === 1 ? '' : 's'} changed
        </span>
      </summary>
      <ul className="space-y-1 border-t border-ink-600 p-3 font-mono text-xs leading-relaxed">
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
    isFetching: templateFetching,
    refetch: refetchTemplate,
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
  // `?reversed=1` opens active -> older, the direction promoting an older version would apply.
  const [reversed, setReversed] = useState(() => search.get('reversed') === '1');
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
    isFetching: diffFetching,
    refetch: refetchDiff,
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
    // Full-screen route: the shell gives this page the whole pane, so it scrolls itself.
    <div className="h-full overflow-y-auto">
      <div className="space-y-6 px-4 py-6 md:px-10 md:py-8">
        <div>
          <TemplateBackLink
            href={`/workflows/library/${id}`}
            label={template?.name ?? 'Workflow'}
          />
          <PageHeader
            actions={
              canPromote && !afterNeedsReview ? (
                <Button onClick={() => setPromoteOpen(true)} size="sm" variant="primary">
                  Promote v{after} to active
                </Button>
              ) : undefined
            }
            className="mt-3 mb-0"
            subtitle={
              before !== null && after !== null && before !== after
                ? `What changed from v${before} to v${after}. Changed nodes are marked on both diagrams and listed field by field.`
                : 'Compare two versions of this workflow side by side.'
            }
            title="Compare versions"
          />
          {canPromote && afterNeedsReview && (
            <Alert className="mt-4" variant="info">
              v{after} is AI-generated and needs review before it can be promoted. Review it on the{' '}
              <Link className="text-ember-400 hover:underline" href={`/workflows/library/${id}`}>
                workflow page
              </Link>
              .
            </Alert>
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

        {!singleVersion && sortedVersions.length > 0 && (
          <div className="flex flex-wrap items-end gap-3">
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
              size="md"
              title="Swap before and after"
              variant="secondary"
            >
              <Icon name="swap" size={13} />
              Swap
            </Button>
            {before !== null && after !== null && before !== after && (
              <p className="flex items-center gap-1.5 pb-1.5 text-[13px] text-paper-400 tabular-nums">
                Showing
                <Badge tone="neutral" variant="outline">
                  v{before}
                </Badge>
                <Icon name="arrowRight" size={13} />
                <Badge tone="neutral" variant="outline">
                  v{after}
                </Badge>
              </p>
            )}
          </div>
        )}

        <QueryBoundary
          error={templateErr}
          isError={templateError}
          isFetching={templateFetching}
          isLoading={templateLoading}
          label="workflow"
          onRetry={() => void refetchTemplate()}
        >
          {singleVersion || (before !== null && before === after) ? (
            <EmptyState
              action={
                <ButtonLink href={`/workflows/library/${id}`} size="sm">
                  Open the editor
                </ButtonLink>
              }
              bordered
              hint={
                singleVersion
                  ? 'Compare needs two versions. Edit the workflow and save a new version to compare it with this one.'
                  : 'Pick two different versions to compare.'
              }
              icon="layers"
              title={singleVersion ? 'Only one version so far' : 'Same version on both sides'}
            />
          ) : (
            <QueryBoundary
              error={diffError}
              isError={isDiffError}
              isFetching={diffFetching}
              isLoading={isLoading}
              label="the diff"
              loadingMessage="Comparing versions…"
              onRetry={() => void refetchDiff()}
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
  const { diff } = diffPayload;
  const presentationOnly = diff.presentationOnlyNodes ?? [];
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Summary">What changed</CardTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="moss" variant="outline">
              {diff.addedNodes.length} added
            </Badge>
            <Badge tone="brick" variant="outline">
              {diff.removedNodes.length} removed
            </Badge>
            <Badge tone="amber" variant="outline">
              {diff.changedNodes.length} changed
            </Badge>
            <Badge tone="neutral" variant="outline">
              {diff.unchangedNodes.length} unchanged
            </Badge>
          </div>
        </CardHeader>
        <dl className="divide-y divide-ink-600 text-[13px]">
          <DiffStat ids={diff.addedNodes} label="Added" tone="moss" />
          <DiffStat ids={diff.removedNodes} label="Removed" tone="brick" />
          <DiffStat ids={diff.changedNodes} label="Changed" tone="amber" />
          {presentationOnly.length > 0 && (
            <DiffStat ids={presentationOnly} label="Title or group only" tone="neutral" />
          )}
        </dl>
        {diff.metaChanges.length > 0 && (
          <div className="mt-4 border-t border-ink-600 pt-4">
            <h4 className="mb-2 text-[13px] font-semibold text-paper-200">Workflow settings</h4>
            <ul className="space-y-1 font-mono text-xs">
              {diff.metaChanges.map((m) => (
                <li className="break-all" key={m.field}>
                  <span className="text-paper-200">{m.field}</span>:{' '}
                  <span className="text-paper-500 line-through">{JSON.stringify(m.before)}</span>{' '}
                  <span className="text-paper-400">→</span>{' '}
                  <span className="text-paper-50">{JSON.stringify(m.after)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {changedNodeDiffs.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-paper-100">
            Changed nodes
            <span className="ml-2 text-[13px] font-normal text-paper-500">
              Only the fields that differ
            </span>
          </h2>
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

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-paper-100">
          Diagrams
          <span className="ml-2 text-[13px] font-normal text-paper-500">Before and after</span>
        </h2>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card className="p-4">
            <CardHeader className="mb-3">
              <CardTitle eyebrow="Before">v{diffPayload.a.version}</CardTitle>
            </CardHeader>
            <WorkflowDag
              diffMarkers={diffMarkers(diffPayload.diff, 'a')}
              height={560}
              spec={specPair.specA}
            />
          </Card>
          <Card className="p-4">
            <CardHeader className="mb-3">
              <CardTitle eyebrow="After">v{diffPayload.b.version}</CardTitle>
            </CardHeader>
            <WorkflowDag
              diffMarkers={diffMarkers(diffPayload.diff, 'b')}
              height={560}
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
  ids,
  tone,
}: {
  label: string;
  ids: string[];
  tone: 'moss' | 'brick' | 'amber' | 'neutral';
}) {
  return (
    <div className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="w-40 shrink-0 text-paper-400">
        {label}
        <span className="ml-1.5 text-paper-500 tabular-nums">{ids.length}</span>
      </dt>
      <dd className="flex min-w-0 flex-wrap gap-1.5">
        {ids.length === 0 ? (
          <span className="text-paper-500">None</span>
        ) : (
          ids.map((nodeId) => (
            <Badge className="font-mono" key={nodeId} tone={tone} variant="outline">
              {nodeId}
            </Badge>
          ))
        )}
      </dd>
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
  const selectId = `version-${label.replace(/[^a-z]/gi, '-').toLowerCase()}`;
  return (
    <Select
      className="w-full sm:w-44"
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
