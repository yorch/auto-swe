'use client';

import type { StepMetadata, WorkflowSpec } from '@auto-swe/shared/workflow';
import { estimateSpecCost } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { TemplateEditor } from '@/components/workflow/TemplateEditor';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
import {
  useCreateWorkflowVersion,
  usePromoteWorkflowVersion,
  useStepRegistry,
  useWorkflowTemplate,
  useWorkflowTemplateAnalytics,
  useWorkflowTemplateVersion,
} from '@/hooks/useWorkflows';
import { formatRelativeTime } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

type ViewMode = 'view' | 'edit' | 'json';

function tryParseSpec(
  json: string
): { ok: true; spec: WorkflowSpec } | { ok: false; error: string } {
  try {
    return { ok: true, spec: JSON.parse(json) as WorkflowSpec };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid JSON', ok: false };
  }
}

export default function TemplateDetailPage({ params }: PageProps) {
  const { id } = use(params);
  const { data: template, isLoading } = useWorkflowTemplate(id);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const effectiveVersion = selectedVersion ?? template?.activeVersion ?? null;
  const { data: versionDetail } = useWorkflowTemplateVersion(id, effectiveVersion);
  const { data: stepRegistry } = useStepRegistry();
  const { data: analytics } = useWorkflowTemplateAnalytics(id, 30);
  const createVersion = useCreateWorkflowVersion(id);
  const promoteVersion = usePromoteWorkflowVersion(id);

  const [mode, setMode] = useState<ViewMode>('view');
  const [editorSpec, setEditorSpec] = useState<WorkflowSpec | null>(null);
  const [editorJson, setEditorJson] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (versionDetail) {
      setEditorSpec(versionDetail.spec as WorkflowSpec);
      setEditorJson(JSON.stringify(versionDetail.spec, null, 2));
      setSaveError(null);
    }
  }, [versionDetail]);

  // In JSON mode, the textarea is the source of truth and we re-parse on every change.
  const jsonParsed = useMemo(
    () => (mode === 'json' && editorJson ? tryParseSpec(editorJson) : null),
    [mode, editorJson]
  );
  const visualSpec: WorkflowSpec | null =
    mode === 'json' ? (jsonParsed?.ok ? jsonParsed.spec : null) : editorSpec;

  const stepRegistryByName = useMemo(
    () => (stepRegistry ? new Map(stepRegistry.map((s) => [s.name, s as StepMetadata])) : null),
    [stepRegistry]
  );
  const costEstimate = useMemo(() => {
    if (!visualSpec || !stepRegistryByName) return null;
    return estimateSpecCost(visualSpec, { stepLookup: (name) => stepRegistryByName.get(name) });
  }, [visualSpec, stepRegistryByName]);

  if (isLoading || !template) {
    return (
      <div className="flex items-center justify-center py-20 font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500">
        <span className="pulse-dot mr-3 inline-block h-1.5 w-1.5 rounded-full bg-ember-400" />
        loading template…
      </div>
    );
  }

  const handleSave = async () => {
    const specToSave = mode === 'json' ? (jsonParsed?.ok ? jsonParsed.spec : null) : editorSpec;
    if (!specToSave) {
      setSaveError(jsonParsed?.ok === false ? jsonParsed.error : 'no spec to save');
      return;
    }
    const shellCount = Object.values(specToSave.nodes).filter((n) => n.type === 'shell').length;
    if (shellCount > 0) {
      const ok = window.confirm(
        `This version contains ${shellCount} shell step(s). Shell steps run user-authored commands in an ephemeral container and require team-admin authoring. Save?`
      );
      if (!ok) return;
    }
    try {
      const result = await createVersion.mutateAsync(specToSave);
      const newVersion = (result as { data: { version: number } }).data.version;
      setSelectedVersion(newVersion);
      setMode('view');
      setSaveError(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'save failed');
    }
  };

  const handleCancel = () => {
    if (versionDetail) {
      setEditorSpec(versionDetail.spec as WorkflowSpec);
      setEditorJson(JSON.stringify(versionDetail.spec, null, 2));
    }
    setMode('view');
    setSaveError(null);
  };

  const handlePromote = async () => {
    if (effectiveVersion === null) return;
    await promoteVersion.mutateAsync(effectiveVersion);
  };

  const handleSpecChange = (next: WorkflowSpec) => {
    setEditorSpec(next);
    setEditorJson(JSON.stringify(next, null, 2));
    if (mode !== 'edit') setMode('edit');
  };

  const handleJsonChange = (text: string) => {
    setEditorJson(text);
    const parsed = tryParseSpec(text);
    if (parsed.ok) setEditorSpec(parsed.spec);
    if (mode !== 'edit') setMode('edit');
  };

  const isDirty =
    mode === 'edit' ||
    (mode === 'json' && editorJson !== JSON.stringify(versionDetail?.spec, null, 2));

  // Action bar — Save / Cancel / View JSON / View visual
  const editorActions = (
    <>
      <Button
        onClick={() => setMode(mode === 'json' ? 'edit' : 'json')}
        size="sm"
        variant={mode === 'json' ? 'primary' : 'ghost'}
      >
        {mode === 'json' ? 'Visual' : 'JSON'}
      </Button>
      {isDirty && (
        <Button onClick={handleCancel} size="sm" variant="secondary">
          Cancel
        </Button>
      )}
      {isDirty && (
        <Button
          disabled={createVersion.isPending || (mode === 'json' && jsonParsed?.ok === false)}
          onClick={handleSave}
          size="sm"
          variant="primary"
        >
          {createVersion.isPending ? 'Saving…' : 'Save new version'}
        </Button>
      )}
      {!isDirty && effectiveVersion !== null && effectiveVersion !== template.activeVersion && (
        <Button
          disabled={promoteVersion.isPending}
          onClick={handlePromote}
          size="sm"
          variant="primary"
        >
          {promoteVersion.isPending ? 'Promoting…' : 'Promote to active'}
        </Button>
      )}
    </>
  );

  return (
    <div className="space-y-10">
      <div className="fade-up">
        <Link
          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500 transition-colors hover:text-ember-400"
          href="/templates"
        >
          <span>←</span> templates
        </Link>
        <div className="mt-4">
          <PageHeader
            actions={
              <>
                <Link
                  className="font-mono text-[11px] uppercase tracking-[0.14em] text-paper-400 transition-colors hover:text-ember-400"
                  href={`/templates/${id}/analytics`}
                >
                  Analytics →
                </Link>
                <Link
                  className="font-mono text-[11px] uppercase tracking-[0.14em] text-paper-400 transition-colors hover:text-ember-400"
                  href={`/templates/${id}/diff`}
                >
                  Compare →
                </Link>
                <Link
                  className="font-mono text-[11px] uppercase tracking-[0.14em] text-paper-400 transition-colors hover:text-ember-400"
                  href={`/templates/${id}/runs`}
                >
                  Run history →
                </Link>
              </>
            }
            chapter={`§ Template · v${effectiveVersion ?? '?'}`}
            subtitle={template.description ?? undefined}
            title={template.name}
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <StatusBadge status={template.status} />
          {template.isDefault && (
            <span className="rounded-sm border border-ember-400/40 bg-ember-400/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ember-400">
              default
            </span>
          )}
          {effectiveVersion === template.activeVersion && (
            <span className="rounded-sm border border-moss-400/40 bg-moss-400/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-moss-400">
              active
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_280px]">
        {/* Editor */}
        <div className="fade-up stagger-1 min-w-0 space-y-4">
          {saveError && (
            <div className="rounded-sm border border-brick-400/40 bg-brick-400/10 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-brick-400">
              ! {saveError}
            </div>
          )}

          {mode === 'view' && visualSpec && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
                  Spec — read-only
                </div>
                <div className="flex items-center gap-2">{editorActions}</div>
              </div>
              <WorkflowDag
                height={520}
                onSelect={setSelectedNodeId}
                selectedNodeId={selectedNodeId}
                spec={visualSpec}
              />
              {!isDirty && (
                <Button onClick={() => setMode('edit')} size="sm" variant="secondary">
                  Edit visually →
                </Button>
              )}
            </div>
          )}

          {mode === 'edit' && editorSpec && stepRegistry && (
            <TemplateEditor
              actions={editorActions}
              costEstimateUsd={costEstimate?.totalUsd}
              observedCostUsd={analytics?.avgCostPerRun ?? null}
              onChange={handleSpecChange}
              onSelect={setSelectedNodeId}
              parseError={null}
              selectedNodeId={selectedNodeId}
              spec={editorSpec}
              stepRegistry={stepRegistry as StepMetadata[]}
            />
          )}

          {mode === 'json' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
                  Raw JSON
                </div>
                <div className="flex items-center gap-2">{editorActions}</div>
              </div>
              <textarea
                className="h-[520px] w-full rounded-sm border border-ink-500 bg-ink-900 p-4 font-mono text-xs text-paper-100 outline-none focus:border-ember-400"
                onChange={(e) => handleJsonChange(e.target.value)}
                spellCheck={false}
                value={editorJson}
              />
              {jsonParsed?.ok === false && (
                <div className="font-mono text-[11px] uppercase tracking-wider text-brick-400">
                  ! JSON parse error — {jsonParsed.error}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right rail — versions */}
        <aside className="fade-up stagger-2 space-y-4">
          <Card variant="inset">
            <SectionHeader hint={`${template.versions.length}`} number="01" title="Versions" />
            <ul className="space-y-1">
              {template.versions.map((v) => (
                <li key={v.id}>
                  <button
                    className={`w-full rounded-sm px-3 py-2 text-left text-sm transition-colors ${
                      effectiveVersion === v.version
                        ? 'bg-ink-700 text-paper-100'
                        : 'text-paper-400 hover:bg-ink-700/40 hover:text-paper-100'
                    }`}
                    onClick={() => setSelectedVersion(v.version)}
                    type="button"
                  >
                    <div className="flex items-baseline justify-between">
                      <span className="tabular font-mono">v{v.version}</span>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
                        {formatRelativeTime(v.createdAt)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {v.version === template.activeVersion && (
                        <span className="rounded-sm border border-moss-400/40 bg-moss-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-moss-400">
                          active
                        </span>
                      )}
                      {v.version === template.experimentVersion && (
                        <span className="rounded-sm border border-violet-400/40 bg-violet-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-violet-400">
                          experiment
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          {analytics && analytics.totalRuns > 0 && (
            <Card variant="inset">
              <SectionHeader hint={`${analytics.windowDays}d`} number="02" title="Observed" />
              <dl className="space-y-3 text-sm">
                <Stat label="Runs" value={analytics.totalRuns} />
                {analytics.avgCostPerRun != null && (
                  <Stat label="Avg cost / run" value={`$${analytics.avgCostPerRun.toFixed(2)}`} />
                )}
              </dl>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline justify-between border-t border-ink-600 pt-2 first:border-t-0 first:pt-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-paper-500">{label}</dt>
      <dd className="tabular font-mono text-sm text-paper-100">{value}</dd>
    </div>
  );
}
