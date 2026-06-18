'use client';

import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import type { StepMetadata, WorkflowSpec } from '@auto-swe/shared/workflow';
import { estimateSpecCost } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { TabBar } from '@/components/ui/TabBar';
import { Textarea } from '@/components/ui/Textarea';
import { InputSchemaBuilder } from '@/components/workflow/InputSchemaBuilder';
import { RunTemplateModal } from '@/components/workflow/RunTemplateModal';
import { TemplateEditor } from '@/components/workflow/TemplateEditor';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
import {
  useCreateWorkflowVersion,
  usePromoteWorkflowVersion,
  useStepRegistry,
  useUpdateWorkflowTemplate,
  useWorkflowTemplate,
  useWorkflowTemplateAnalytics,
  useWorkflowTemplateVersion,
} from '@/hooks/useWorkflows';
import { formatPercent, formatRelativeTime } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

type ViewMode = 'view' | 'edit' | 'json';
type SubTab = 'editor' | 'analytics' | 'runs' | 'compare';

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'editor', label: 'Editor' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'runs', label: 'Run history' },
  { id: 'compare', label: 'Compare versions' },
];

function tryParseSpec(
  json: string
): { ok: true; spec: WorkflowSpec } | { ok: false; error: string } {
  try {
    return { ok: true, spec: JSON.parse(json) as WorkflowSpec };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid JSON', ok: false };
  }
}

function EditMetadataModal({
  open,
  onClose,
  templateId,
  initialName,
  initialDescription,
  isDefault,
}: {
  open: boolean;
  onClose: () => void;
  templateId: string;
  initialName: string;
  initialDescription: string;
  isDefault: boolean;
}) {
  const updateTemplate = useUpdateWorkflowTemplate(templateId);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [defaultChecked, setDefaultChecked] = useState(isDefault);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setDescription(initialDescription);
      setDefaultChecked(isDefault);
      setError(null);
    }
  }, [open, initialName, initialDescription, isDefault]);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    setError(null);
    try {
      await updateTemplate.mutateAsync({
        description: description.trim() || undefined,
        isDefault: defaultChecked,
        name: trimmed,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    }
  };

  return (
    <Modal eyebrow="§ Template" onClose={onClose} open={open} title="Edit metadata">
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Input label="Name" onChange={(e) => setName(e.target.value)} value={name} />
        <Textarea
          hint="Optional"
          label="Description"
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          value={description}
        />
        <label className="flex cursor-pointer items-center gap-2 text-sm text-paper-300">
          <input
            checked={defaultChecked}
            className="rounded border-ink-400 bg-ink-900 text-ember-400 focus:ring-ember-400"
            onChange={(e) => setDefaultChecked(e.target.checked)}
            type="checkbox"
          />
          Set as default template
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button disabled={updateTemplate.isPending} onClick={handleSave} variant="primary">
            {updateTemplate.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function EditSchemaModal({
  open,
  onClose,
  templateId,
  initialSchema,
}: {
  open: boolean;
  onClose: () => void;
  templateId: string;
  initialSchema: InputSchema | null | undefined;
}) {
  const updateTemplate = useUpdateWorkflowTemplate(templateId);
  const [schema, setSchema] = useState<InputSchema | null>(initialSchema ?? null);
  const [builderKey, setBuilderKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSchema(initialSchema ?? null);
      setBuilderKey((k) => k + 1);
      setError(null);
    }
  }, [open, initialSchema]);

  const handleSave = async () => {
    setError(null);
    try {
      await updateTemplate.mutateAsync({ inputSchema: schema ?? null });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    }
  };

  return (
    <Modal
      eyebrow="§ Template"
      onClose={onClose}
      open={open}
      size="lg"
      subtitle="Define the fields users fill in when running this template. Leave empty for no required inputs."
      title="Run schema"
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <InputSchemaBuilder key={builderKey} onChange={setSchema} value={schema ?? undefined} />
        <div className="flex justify-end gap-2 border-t border-ink-600 pt-4">
          <Button onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button disabled={updateTemplate.isPending} onClick={handleSave} variant="primary">
            {updateTemplate.isPending ? 'Saving…' : 'Save schema'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ExperimentCard({
  templateId,
  versions,
  activeVersion,
  experimentVersion,
  experimentSplit,
}: {
  templateId: string;
  versions: { id: string; version: number }[];
  activeVersion: number | null;
  experimentVersion: number | null;
  experimentSplit: number | null;
}) {
  const updateTemplate = useUpdateWorkflowTemplate(templateId);
  const [expVer, setExpVer] = useState<number | null>(experimentVersion);
  const [split, setSplit] = useState<number>(experimentSplit ?? 10);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const nonActive = versions.filter((v) => v.version !== activeVersion);

  const handleSave = async () => {
    setError(null);
    try {
      await updateTemplate.mutateAsync({
        experimentSplit: expVer ? split : null,
        experimentVersion: expVer,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    }
  };

  const handleClear = async () => {
    setError(null);
    setExpVer(null);
    setSplit(10);
    try {
      await updateTemplate.mutateAsync({ experimentSplit: null, experimentVersion: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'clear failed');
    }
  };

  if (nonActive.length === 0) {
    return null;
  }

  return (
    <Card variant="inset">
      <SectionHeader hint="A/B" number="03" title="Experiment" />
      {error && <Alert className="mb-3 text-xs">{error}</Alert>}
      <div className="space-y-3">
        <Select
          className="h-9 px-2 font-mono text-xs"
          label="Experiment version"
          onChange={(e) => setExpVer(e.target.value ? Number(e.target.value) : null)}
          value={expVer ?? ''}
        >
          <option value="">— none —</option>
          {nonActive.map((v) => (
            <option key={v.id} value={v.version}>
              v{v.version}
            </option>
          ))}
        </Select>
        {expVer && (
          <div className="space-y-1">
            <label
              className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
              htmlFor="exp-split"
            >
              Traffic split (% to experiment)
            </label>
            <div className="flex items-center gap-3">
              <input
                className="h-1.5 flex-1 cursor-pointer accent-ember-400"
                id="exp-split"
                max={50}
                min={1}
                onChange={(e) => setSplit(Number(e.target.value))}
                type="range"
                value={split}
              />
              <span className="w-10 text-right font-mono text-sm text-paper-100">{split}%</span>
            </div>
            <div className="font-mono text-[10px] text-paper-500">
              v{activeVersion} gets {100 - split}% · v{expVer} gets {split}%
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <Button
            disabled={updateTemplate.isPending}
            onClick={handleSave}
            size="sm"
            variant="primary"
          >
            {saved ? 'Saved ✓' : updateTemplate.isPending ? 'Saving…' : 'Save'}
          </Button>
          {(experimentVersion || expVer) && (
            <Button onClick={handleClear} size="sm" variant="secondary">
              Clear
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function TemplateDetailPage({ params }: PageProps) {
  const router = useRouter();
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
  const [pendingShellSpec, setPendingShellSpec] = useState<WorkflowSpec | null>(null);
  const [editMetaOpen, setEditMetaOpen] = useState(false);
  const [editSchemaOpen, setEditSchemaOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);

  useEffect(() => {
    if (versionDetail) {
      setEditorSpec(versionDetail.spec as WorkflowSpec);
      setEditorJson(JSON.stringify(versionDetail.spec, null, 2));
      setSaveError(null);
    }
  }, [versionDetail]);

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
    if (!visualSpec || !stepRegistryByName) {
      return null;
    }
    return estimateSpecCost(visualSpec, { stepLookup: (name) => stepRegistryByName.get(name) });
  }, [visualSpec, stepRegistryByName]);

  if (isLoading || !template) {
    return <LoadingState message="loading template…" />;
  }

  const commitSave = async (spec: WorkflowSpec) => {
    try {
      const result = await createVersion.mutateAsync(spec);
      const newVersion = (result as { data: { version: number } }).data.version;
      setSelectedVersion(newVersion);
      setMode('view');
      setSaveError(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'save failed');
    }
  };

  const handleSave = async () => {
    const specToSave = mode === 'json' ? (jsonParsed?.ok ? jsonParsed.spec : null) : editorSpec;
    if (!specToSave) {
      setSaveError(jsonParsed?.ok === false ? jsonParsed.error : 'no spec to save');
      return;
    }
    const shellCount = Object.values(specToSave.nodes).filter((n) => n.type === 'shell').length;
    if (shellCount > 0) {
      setPendingShellSpec(specToSave);
      return;
    }
    await commitSave(specToSave);
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
    if (effectiveVersion === null) {
      return;
    }
    await promoteVersion.mutateAsync(effectiveVersion);
  };

  const handleSpecChange = (next: WorkflowSpec) => {
    setEditorSpec(next);
    setEditorJson(JSON.stringify(next, null, 2));
    if (mode !== 'edit') {
      setMode('edit');
    }
  };

  const handleJsonChange = (text: string) => {
    setEditorJson(text);
    const parsed = tryParseSpec(text);
    if (parsed.ok) {
      setEditorSpec(parsed.spec);
    }
  };

  const isDirty =
    mode === 'edit' ||
    (mode === 'json' &&
      versionDetail !== undefined &&
      editorJson !== JSON.stringify(versionDetail.spec, null, 2));

  const editorActions = (
    <>
      {mode === 'view' && (
        <Button onClick={() => setMode('edit')} size="sm" variant="secondary">
          Edit
        </Button>
      )}
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
    <div className="space-y-8">
      <RunTemplateModal onClose={() => setRunOpen(false)} open={runOpen} template={template} />

      {/* Back + header */}
      <div className="fade-up">
        <Link
          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500 transition-colors hover:text-ember-400"
          href="/templates"
        >
          <span>←</span> workflows
        </Link>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div className="flex-1">
            <PageHeader
              chapter={`§ Workflows · v${effectiveVersion ?? '?'}`}
              subtitle={template.description ?? undefined}
              title={template.name}
            />
          </div>
          <div className="flex items-center gap-2">
            {template.status === 'ACTIVE' && template.activeVersion !== null && (
              <Button onClick={() => setRunOpen(true)} size="sm" variant="primary">
                Run →
              </Button>
            )}
            <Button onClick={() => setEditMetaOpen(true)} size="sm" variant="secondary">
              Edit metadata
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <StatusBadge status={template.status} />
          {template.isDefault && (
            <span className="rounded border border-ember-400/40 bg-ember-400/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ember-400">
              default
            </span>
          )}
          {effectiveVersion === template.activeVersion && (
            <span className="rounded border border-moss-400/40 bg-moss-400/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-moss-400">
              active
            </span>
          )}
          {template.experimentVersion && (
            <span className="rounded border border-violet-400/40 bg-violet-400/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-violet-400">
              A/B: v{template.experimentVersion} ({template.experimentSplit ?? 0}%)
            </span>
          )}
        </div>
      </div>

      {/* Sub-page tab bar */}
      <TabBar
        active="editor"
        className="fade-up"
        onChange={(tab: SubTab) => {
          if (tab === 'editor') {
            return;
          }
          router.push(
            `/templates/${id}/${tab === 'analytics' ? 'analytics' : tab === 'runs' ? 'runs' : 'diff'}`
          );
        }}
        tabs={SUB_TABS}
      />

      {saveError && <Alert>{saveError}</Alert>}

      {/* Edit mode: full-bleed canvas */}
      {mode === 'edit' && editorSpec && stepRegistry && (
        <div className="fade-up stagger-1 -mx-10">
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
        </div>
      )}

      {/* View / JSON mode with versions + analytics rail */}
      {mode !== 'edit' && (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_280px]">
          <div className="fade-up stagger-1 min-w-0 space-y-4">
            {mode === 'view' && visualSpec && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
                    Spec — read-only
                  </div>
                  <div className="flex items-center gap-2">{editorActions}</div>
                </div>
                <WorkflowDag
                  height="calc(100vh - 360px)"
                  onSelect={setSelectedNodeId}
                  selectedNodeId={selectedNodeId}
                  spec={visualSpec}
                />
              </div>
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
                  className="h-[520px] w-full rounded-[9px] border border-ink-500 bg-ink-900 p-4 font-mono text-xs text-paper-100 outline-none focus:border-ember-400"
                  onChange={(e) => handleJsonChange(e.target.value)}
                  spellCheck={false}
                  value={editorJson}
                />
                {jsonParsed?.ok === false && <Alert>JSON parse error — {jsonParsed.error}</Alert>}
              </div>
            )}
          </div>

          {/* Right rail */}
          <aside className="fade-up stagger-2 space-y-4">
            {/* Versions */}
            {template.versions.length === 1 ? (
              <Card variant="inset">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
                  Version
                </div>
                <div className="mt-2 flex items-baseline justify-between gap-2">
                  <span className="tabular font-mono text-sm text-paper-100">
                    v{template.versions[0]?.version}
                  </span>
                  {template.versions[0] && (
                    <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
                      {formatRelativeTime(template.versions[0].createdAt)}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {template.versions[0]?.version === template.activeVersion && (
                    <span className="rounded border border-moss-400/40 bg-moss-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-moss-400">
                      active
                    </span>
                  )}
                </div>
                <p className="mt-3 text-[11px] leading-snug text-paper-500">
                  Save changes to create a second version and unlock A/B testing.
                </p>
              </Card>
            ) : (
              <Card variant="inset">
                <SectionHeader hint={`${template.versions.length}`} number="01" title="Versions" />
                <ul className="space-y-1">
                  {template.versions.map((v) => (
                    <li key={v.id}>
                      <button
                        className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
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
                            <span className="rounded border border-moss-400/40 bg-moss-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-moss-400">
                              active
                            </span>
                          )}
                          {v.version === template.experimentVersion && (
                            <span className="rounded border border-violet-400/40 bg-violet-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-violet-400">
                              experiment
                            </span>
                          )}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {/* Observed analytics summary */}
            {analytics && analytics.totalRuns > 0 && (
              <Card variant="inset">
                <SectionHeader hint="30d" number="02" title="Observed" />
                <dl className="space-y-3 text-sm">
                  <VersionStat label="Runs" value={analytics.totalRuns} />
                  <VersionStat label="Success rate" value={formatPercent(analytics.successRate)} />
                  {analytics.avgCostPerRun != null && (
                    <VersionStat
                      label="Avg cost / run"
                      value={`$${analytics.avgCostPerRun.toFixed(2)}`}
                    />
                  )}
                  {analytics.p50DurationMs != null && (
                    <VersionStat
                      label="p50 duration"
                      value={`${Math.round(analytics.p50DurationMs / 1000)}s`}
                    />
                  )}
                </dl>
              </Card>
            )}

            {/* Run schema */}
            <Card variant="inset">
              <div className="flex items-center justify-between">
                <SectionHeader number="03" title="Run schema" />
                <Button onClick={() => setEditSchemaOpen(true)} size="sm" variant="ghost">
                  Edit
                </Button>
              </div>
              {template.inputSchema &&
              typeof template.inputSchema === 'object' &&
              'properties' in (template.inputSchema as object) ? (
                <ul className="mt-2 space-y-1">
                  {Object.entries(
                    (template.inputSchema as InputSchema).properties
                  ).map(([key, prop]) => (
                    <li key={key} className="flex items-baseline gap-2 text-xs">
                      <span className="font-mono text-paper-200">{key}</span>
                      <span className="text-paper-500">{prop.type}</span>
                      {(template.inputSchema as InputSchema).required?.includes(key) && (
                        <span className="text-brick-400">required</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-paper-500">No schema — runs accept any input</p>
              )}
            </Card>

            {/* A/B experiment config */}
            {template.versions.length > 1 && (
              <ExperimentCard
                activeVersion={template.activeVersion}
                experimentSplit={template.experimentSplit ?? null}
                experimentVersion={template.experimentVersion ?? null}
                templateId={id}
                versions={template.versions}
              />
            )}
          </aside>
        </div>
      )}

      <EditMetadataModal
        initialDescription={template.description ?? ''}
        initialName={template.name}
        isDefault={template.isDefault}
        onClose={() => setEditMetaOpen(false)}
        open={editMetaOpen}
        templateId={id}
      />

      <EditSchemaModal
        initialSchema={template.inputSchema as InputSchema | null | undefined}
        onClose={() => setEditSchemaOpen(false)}
        open={editSchemaOpen}
        templateId={id}
      />

      <ConfirmModal
        confirmLabel="Save"
        message={`This version contains ${Object.values(pendingShellSpec?.nodes ?? {}).filter((n) => n.type === 'shell').length} shell step(s). Shell steps run user-authored commands in an ephemeral container and require team-admin authoring. Save?`}
        onClose={() => setPendingShellSpec(null)}
        onConfirm={() => {
          if (pendingShellSpec) {
            void commitSave(pendingShellSpec);
          }
        }}
        open={pendingShellSpec !== null}
        title="Shell steps detected"
      />
    </div>
  );
}

function VersionStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline justify-between border-t border-ink-600 pt-2 first:border-t-0 first:pt-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-paper-500">{label}</dt>
      <dd className="tabular font-mono text-sm text-paper-100">{value}</dd>
    </div>
  );
}
