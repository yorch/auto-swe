'use client';

import type { StepMetadata, WorkflowSpec } from '@auto-swe/shared/workflow';
import { estimateSpecCost } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { NodeConfigForm } from '@/components/workflow/NodeConfigForm';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
import {
  useCreateWorkflowVersion,
  usePromoteWorkflowVersion,
  useStepRegistry,
  useUpdateWorkflowTemplate,
  useWorkflowTemplate,
  useWorkflowTemplateVersion,
} from '@/hooks/useWorkflows';
import { formatRelativeTime } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

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
  const createVersion = useCreateWorkflowVersion(id);
  const promoteVersion = usePromoteWorkflowVersion(id);
  const updateTemplate = useUpdateWorkflowTemplate(id);

  const [editorJson, setEditorJson] = useState<string>('');
  const [editorMode, setEditorMode] = useState<'view' | 'edit'>('view');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (versionDetail) {
      setEditorJson(JSON.stringify(versionDetail.spec, null, 2));
      setSaveError(null);
    }
  }, [versionDetail]);

  const parsed = useMemo(() => (editorJson ? tryParseSpec(editorJson) : null), [editorJson]);
  const spec = parsed?.ok ? parsed.spec : null;

  const stepRegistryByName = useMemo(
    () => (stepRegistry ? new Map(stepRegistry.map((s) => [s.name, s as StepMetadata])) : null),
    [stepRegistry]
  );
  const costEstimate = useMemo(() => {
    if (!spec || !stepRegistryByName) return null;
    return estimateSpecCost(spec, { stepLookup: (name) => stepRegistryByName.get(name) });
  }, [spec, stepRegistryByName]);

  if (isLoading || !template) {
    return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading…</div>;
  }

  const handleSave = async () => {
    if (!parsed?.ok) {
      setSaveError(parsed?.error ?? 'JSON not parsed');
      return;
    }
    try {
      const result = await createVersion.mutateAsync(parsed.spec);
      const newVersion = (result as { data: { version: number } }).data.version;
      setSelectedVersion(newVersion);
      setEditorMode('view');
      setSaveError(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'save failed');
    }
  };

  const handlePromote = async () => {
    if (effectiveVersion === null) return;
    await promoteVersion.mutateAsync(effectiveVersion);
  };

  const selectedNode = selectedNodeId && spec?.nodes[selectedNodeId];
  const selectedStepMeta =
    selectedNode && selectedNode.type === 'step'
      ? stepRegistry?.find((s) => s.name === selectedNode.step)
      : null;

  // Per-field config edits mutate the in-memory spec and re-serialize into
  // editorJson. Switches to edit mode so the existing Save/Cancel buttons
  // can land the change as a new version. Falls through silently if the spec
  // is in an unparseable state — the JSON editor stays the source of truth.
  const handleConfigChange = (key: string, value: unknown) => {
    if (!parsed?.ok || !selectedNodeId) return;
    const node = parsed.spec.nodes[selectedNodeId];
    if (!node || node.type !== 'step') return;
    const currentConfig = node.config ?? {};
    // No-op if the value didn't actually change. Stops a typed-then-erased
    // keystroke from triggering a full spec re-serialize + DAG re-layout.
    if (Object.is(currentConfig[key], value)) return;
    const nextConfig = { ...currentConfig };
    if (value === undefined) delete nextConfig[key];
    else nextConfig[key] = value;
    const nextSpec: WorkflowSpec = {
      ...parsed.spec,
      nodes: {
        ...parsed.spec.nodes,
        [selectedNodeId]: { ...node, config: nextConfig },
      },
    };
    setEditorJson(JSON.stringify(nextSpec, null, 2));
    setEditorMode('edit');
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link className="text-[var(--primary)] hover:underline text-sm" href="/templates">
            &larr; Templates
          </Link>
          <h2 className="text-2xl font-bold">{template.name}</h2>
          <StatusBadge status={template.status} />
          {template.isDefault && (
            <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded">default</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Link
            className="text-sm text-[var(--muted-foreground)] hover:underline"
            href={`/templates/${id}/runs`}
          >
            Run history →
          </Link>
        </div>
      </div>

      {template.description && (
        <p className="text-sm text-[var(--muted-foreground)]">{template.description}</p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>
                  Spec — v{effectiveVersion ?? '?'}
                  {effectiveVersion === template.activeVersion && (
                    <span className="ml-2 text-xs px-1.5 py-0.5 bg-green-100 text-green-800 rounded">
                      active
                    </span>
                  )}
                  {costEstimate && costEstimate.totalUsd > 0 && (
                    <span
                      className="ml-2 text-xs px-1.5 py-0.5 bg-gray-100 text-gray-700 rounded font-normal"
                      title={`Static estimate from step costHints. Branches take max; fanOut assumes width ${costEstimate.fanOutWidthAssumed}.`}
                    >
                      ~${costEstimate.totalUsd.toFixed(2)}/run
                    </span>
                  )}
                </CardTitle>
                <div className="flex items-center gap-2">
                  {editorMode === 'view' ? (
                    <button
                      className="text-xs px-3 py-1 bg-[var(--primary)] text-white rounded hover:opacity-90"
                      onClick={() => setEditorMode('edit')}
                      type="button"
                    >
                      Edit JSON
                    </button>
                  ) : (
                    <>
                      <button
                        className="text-xs px-3 py-1 border border-[var(--border)] rounded hover:bg-[var(--muted)]"
                        onClick={() => {
                          if (versionDetail)
                            setEditorJson(JSON.stringify(versionDetail.spec, null, 2));
                          setEditorMode('view');
                          setSaveError(null);
                        }}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="text-xs px-3 py-1 bg-[var(--primary)] text-white rounded hover:opacity-90 disabled:opacity-50"
                        disabled={!parsed?.ok || createVersion.isPending}
                        onClick={handleSave}
                        type="button"
                      >
                        {createVersion.isPending ? 'Saving…' : 'Save as new version'}
                      </button>
                    </>
                  )}
                  {effectiveVersion !== null &&
                    effectiveVersion !== template.activeVersion &&
                    editorMode === 'view' && (
                      <button
                        className="text-xs px-3 py-1 border border-[var(--border)] rounded hover:bg-[var(--muted)]"
                        disabled={promoteVersion.isPending}
                        onClick={handlePromote}
                        type="button"
                      >
                        {promoteVersion.isPending ? 'Promoting…' : 'Promote to active'}
                      </button>
                    )}
                </div>
              </div>
            </CardHeader>

            {saveError && (
              <div className="mb-4 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                {saveError}
              </div>
            )}

            {editorMode === 'edit' ? (
              <div className="space-y-2">
                <textarea
                  className="w-full h-96 font-mono text-xs p-3 border border-[var(--border)] rounded"
                  onChange={(e) => setEditorJson(e.target.value)}
                  spellCheck={false}
                  value={editorJson}
                />
                {parsed?.ok === false && (
                  <div className="text-xs text-red-700">JSON parse error: {parsed.error}</div>
                )}
              </div>
            ) : spec ? (
              <div className="overflow-x-auto">
                <WorkflowDag
                  onSelect={setSelectedNodeId}
                  selectedNodeId={selectedNodeId}
                  spec={spec}
                />
              </div>
            ) : (
              <div className="text-sm text-[var(--muted-foreground)]">No spec to display</div>
            )}
          </Card>

          {selectedNode && (
            <Card>
              <CardHeader>
                <CardTitle>Node · {selectedNodeId}</CardTitle>
              </CardHeader>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-[var(--muted-foreground)]">Type</dt>
                  <dd className="font-mono text-xs">{selectedNode.type}</dd>
                </div>
                {selectedNode.type === 'step' && (
                  <div className="flex justify-between">
                    <dt className="text-[var(--muted-foreground)]">Step</dt>
                    <dd className="font-mono text-xs">{selectedNode.step}</dd>
                  </div>
                )}
                {selectedStepMeta && (
                  <>
                    <div className="text-xs text-[var(--muted-foreground)] pt-2 border-t border-[var(--border)]">
                      {selectedStepMeta.description}
                    </div>
                    {selectedNode.type === 'step' && (
                      <NodeConfigForm
                        fields={selectedStepMeta.configFields}
                        onChange={handleConfigChange}
                        values={(selectedNode.config ?? {}) as Record<string, unknown>}
                      />
                    )}
                  </>
                )}
                <details className="pt-2">
                  <summary className="text-xs cursor-pointer text-[var(--muted-foreground)]">
                    Raw JSON
                  </summary>
                  <pre className="mt-2 text-xs bg-[var(--muted)] p-2 rounded overflow-x-auto">
                    {JSON.stringify(selectedNode, null, 2)}
                  </pre>
                </details>
              </dl>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Versions</CardTitle>
            </CardHeader>
            <ul className="space-y-1">
              {template.versions.map((v) => (
                <li key={v.id}>
                  <button
                    className={`w-full text-left text-sm px-2 py-1.5 rounded hover:bg-[var(--muted)] ${
                      effectiveVersion === v.version ? 'bg-[var(--muted)] font-medium' : ''
                    }`}
                    onClick={() => setSelectedVersion(v.version)}
                    type="button"
                  >
                    <div className="flex items-center justify-between">
                      <span>
                        v{v.version}
                        {v.version === template.activeVersion && (
                          <span className="ml-2 text-xs px-1 py-0.5 bg-green-100 text-green-800 rounded">
                            active
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-[var(--muted-foreground)]">
                        {formatRelativeTime(v.createdAt)}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Step palette</CardTitle>
            </CardHeader>
            <p className="text-xs text-[var(--muted-foreground)] mb-3">
              Steps available in this build. Reference these from spec nodes by{' '}
              <code>step: &lt;name&gt;</code>.
            </p>
            <ul className="space-y-1 max-h-96 overflow-y-auto text-xs">
              {(stepRegistry ?? []).map((s) => (
                <li className="border-b border-[var(--border)] pb-1.5" key={s.name}>
                  <div className="font-mono">{s.name}</div>
                  <div className="text-[var(--muted-foreground)]">
                    <span className="uppercase">{s.category}</span> · {s.label}
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Settings</CardTitle>
            </CardHeader>
            <label className="flex items-center gap-2 text-sm">
              <input
                checked={template.isDefault}
                disabled={updateTemplate.isPending}
                onChange={(e) => updateTemplate.mutate({ isDefault: e.target.checked })}
                type="checkbox"
              />
              Default for {template.team?.name ?? 'all teams'}
            </label>
          </Card>
        </div>
      </div>
    </div>
  );
}
