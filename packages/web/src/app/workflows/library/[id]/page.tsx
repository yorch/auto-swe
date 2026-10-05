'use client';

import { type InputSchema, isInputSchema } from '@auto-swe/shared/lib/inputSchema';
import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import type { StepMetadata, WorkflowSpec } from '@auto-swe/shared/workflow';
import { estimateSpecCost, parseWorkflowSpec } from '@auto-swe/shared/workflow';
import { use, useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { SparkleIcon, SparkleTextIcon } from '@/components/ui/icons';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Slider } from '@/components/ui/Slider';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Textarea } from '@/components/ui/Textarea';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { InputSchemaBuilder } from '@/components/workflow/InputSchemaBuilder';
import { KeyValueRow } from '@/components/workflow/KeyValueRow';
import { RefineChatPanel } from '@/components/workflow/RefineChatPanel';
import { SchemaFormPreview } from '@/components/workflow/SchemaFormPreview';
import { TemplateEditor } from '@/components/workflow/TemplateEditor';
import {
  TemplateBackLink,
  TemplateNotFound,
  TemplateSubNav,
} from '@/components/workflow/templateNav';
import { VersionTags } from '@/components/workflow/VersionTags';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
import { useRolePricing } from '@/hooks/useModelCatalog';
import { useLedTeamIds } from '@/hooks/useTeams';
import {
  useCreateWorkflowVersion,
  useExplainWorkflowTemplate,
  usePromoteWorkflowVersion,
  useRegenerateWebhook,
  useReviewWorkflowVersion,
  useRevokeWebhook,
  useStepRegistry,
  useUpdateWorkflowTemplate,
  useWorkflowTemplate,
  useWorkflowTemplateAnalytics,
  useWorkflowTemplateVersion,
} from '@/hooks/useTemplates';
import { useTransientFlag } from '@/hooks/useTransientFlag';
import { errMsg } from '@/lib/errors';
import { estimatorPricing } from '@/lib/modelCatalog';
import { validateRouteParam } from '@/lib/routeParams';
import { canWriteTeamResource } from '@/lib/teamPermissions';
import { formatCost, formatDuration, formatPercent, formatRelativeTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

interface PageProps {
  params: Promise<{ id: string }>;
}

type ViewMode = 'view' | 'edit' | 'json';

function formatSpecError(err: unknown): string {
  if (err instanceof Error && 'issues' in err) {
    const issues = (err as { issues?: Array<{ message?: string }> }).issues ?? [];
    const first = issues[0]?.message ?? err.message;
    return issues.length > 1 ? `${first} (+${issues.length - 1} more issues)` : first;
  }
  return errMsg(err, 'invalid spec');
}

function tryParseSpec(
  json: string
): { ok: true; spec: WorkflowSpec } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { error: errMsg(err, 'invalid JSON'), ok: false };
  }
  try {
    return { ok: true, spec: parseWorkflowSpec(parsed) };
  } catch (err) {
    return { error: formatSpecError(err), ok: false };
  }
}

function EditMetadataModal({
  open,
  onClose,
  templateId,
  initialName,
  initialDescription,
  isDefault,
  initialEstimatedHumanTimeSavedMinutes,
}: {
  open: boolean;
  onClose: () => void;
  templateId: string;
  initialName: string;
  initialDescription: string;
  isDefault: boolean;
  initialEstimatedHumanTimeSavedMinutes: number | null;
}) {
  const updateTemplate = useUpdateWorkflowTemplate(templateId);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [defaultChecked, setDefaultChecked] = useState(isDefault);
  const [estimatedMinutes, setEstimatedMinutes] = useState<number | null>(
    initialEstimatedHumanTimeSavedMinutes
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setDescription(initialDescription);
      setDefaultChecked(isDefault);
      setEstimatedMinutes(initialEstimatedHumanTimeSavedMinutes);
      setError(null);
    }
  }, [open, initialName, initialDescription, isDefault, initialEstimatedHumanTimeSavedMinutes]);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    if (estimatedMinutes != null && estimatedMinutes < 0) {
      setError('Estimated human time saved cannot be negative');
      return;
    }
    setError(null);
    try {
      await updateTemplate.mutateAsync({
        description: description.trim() || undefined,
        estimatedHumanTimeSavedMinutes: estimatedMinutes,
        isDefault: defaultChecked,
        name: trimmed,
      });
      onClose();
    } catch (err) {
      setError(errMsg(err, 'save failed'));
    }
  };

  return (
    <Modal eyebrow="§ Workflow" onClose={onClose} open={open} title="Edit metadata">
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
        <Input
          hint="Optional — minutes saved per run"
          label="Estimated human time saved"
          min={0}
          onChange={(e) => {
            const v = e.target.value;
            setEstimatedMinutes(v === '' ? null : Number(v));
          }}
          step={0.1}
          type="number"
          value={estimatedMinutes ?? ''}
        />
        <ToggleSwitch
          checked={defaultChecked}
          label="Set as default workflow"
          onChange={() => setDefaultChecked((v) => !v)}
        />
        <ModalFooter
          isPending={updateTemplate.isPending}
          onCancel={onClose}
          onSubmit={handleSave}
          pendingLabel="Saving…"
          submitLabel="Save changes"
        />
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
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    if (open) {
      setSchema(initialSchema ?? null);
      setBuilderKey((k) => k + 1);
      setError(null);
      setPreview(false);
    }
  }, [open, initialSchema]);

  const handleSave = async () => {
    setError(null);
    try {
      await updateTemplate.mutateAsync({ inputSchema: schema ?? null });
      onClose();
    } catch (err) {
      setError(errMsg(err, 'save failed'));
    }
  };

  return (
    <Modal
      eyebrow="§ Workflow"
      onClose={onClose}
      open={open}
      size="lg"
      subtitle="Define the fields people fill in when they run this workflow. Leave empty for no required inputs."
      title="Launch inputs"
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="flex items-center justify-end">
          <Button
            onClick={() => setPreview((p) => !p)}
            size="sm"
            variant={preview ? 'primary' : 'ghost'}
          >
            {preview ? 'Back to editor' : 'Preview form'}
          </Button>
        </div>
        {preview ? (
          <SchemaFormPreview schema={schema} />
        ) : (
          <InputSchemaBuilder key={builderKey} onChange={setSchema} value={schema ?? undefined} />
        )}
        <ModalFooter
          disabled={preview}
          isPending={updateTemplate.isPending}
          onCancel={onClose}
          onSubmit={handleSave}
          pendingLabel="Saving…"
          submitLabel="Save changes"
        />
      </div>
    </Modal>
  );
}

function ExperimentCard({
  number,
  templateId,
  versions,
  activeVersion,
  experimentVersion,
  experimentSplit,
}: {
  number: string;
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
  const [saved, markSaved] = useTransientFlag();

  const nonActive = versions.filter((v) => v.version !== activeVersion);

  const handleSave = async () => {
    setError(null);
    try {
      await updateTemplate.mutateAsync({
        experimentSplit: expVer ? split : null,
        experimentVersion: expVer,
      });
      markSaved();
    } catch (err) {
      setError(errMsg(err, 'save failed'));
    }
  };

  const handleClear = async () => {
    setError(null);
    setExpVer(null);
    setSplit(10);
    try {
      await updateTemplate.mutateAsync({ experimentSplit: null, experimentVersion: null });
    } catch (err) {
      setError(errMsg(err, 'clear failed'));
    }
  };

  if (nonActive.length === 0) {
    return null;
  }

  return (
    <Card variant="inset">
      <SectionHeader hint="A/B" number={number} title="Experiment" />
      {error && <Alert className="mb-3 text-xs">{error}</Alert>}
      <div className="space-y-3">
        <Select
          compact
          label="Experiment version"
          onChange={(v) => setExpVer(v ? Number(v) : null)}
          options={[
            { label: '— none —', value: '' },
            ...nonActive.map((v) => ({ label: `v${v.version}`, value: String(v.version) })),
          ]}
          value={expVer == null ? '' : String(expVer)}
        />
        {expVer && (
          <div className="space-y-1">
            <Slider
              formatValue={(v) => `${v}%`}
              id="exp-split"
              label="Traffic split (% to experiment)"
              max={50}
              min={1}
              onChange={setSplit}
              value={split}
            />
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
            {saved ? 'Saved ✓' : updateTemplate.isPending ? 'Saving…' : 'Save changes'}
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

function ExplainModal({
  open,
  onClose,
  templateId,
}: {
  open: boolean;
  onClose: () => void;
  templateId: string;
}) {
  const explain = useExplainWorkflowTemplate(templateId);
  const { mutate, reset, isPending, data, error } = explain;

  // Kick off the explanation when the modal opens; reset when it closes so the
  // next open re-fetches (the active version may have changed).
  useEffect(() => {
    if (open) {
      mutate();
    } else {
      reset();
    }
  }, [open, mutate, reset]);

  return (
    <Modal eyebrow="§ Workflow" onClose={onClose} open={open} title="What this workflow does">
      <div className="space-y-4">
        {isPending && <LoadingState />}
        {error && <Alert>{errMsg(error, 'Could not explain')}</Alert>}
        {data?.explanation && (
          <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-paper-200">
            {data.explanation}
          </div>
        )}
        <div className="flex justify-end">
          <Button onClick={onClose} variant="ghost">
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Regenerate / Revoke for an existing webhook URL. Both invalidate the
 *  current URL, so each goes through a confirmation. */
function WebhookActions({
  onRegenerate,
  onRevoke,
}: {
  onRegenerate: () => Promise<void>;
  onRevoke: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<'regenerate' | 'revoke' | null>(null);
  return (
    <div className="flex gap-2">
      <Button onClick={() => setConfirming('regenerate')} size="sm" variant="secondary">
        Regenerate
      </Button>
      <Button onClick={() => setConfirming('revoke')} size="sm" variant="danger">
        Revoke
      </Button>
      <ConfirmModal
        confirmLabel="Regenerate"
        dangerous
        message="A new webhook URL is issued and the current URL stops working immediately. Anything calling the old URL must be updated."
        onClose={() => setConfirming(null)}
        onConfirm={onRegenerate}
        open={confirming === 'regenerate'}
        title="Regenerate webhook URL?"
      />
      <ConfirmModal
        confirmLabel="Revoke"
        dangerous
        message="The current webhook URL stops working immediately. You can generate a new one later, but the old URL cannot be restored."
        onClose={() => setConfirming(null)}
        onConfirm={onRevoke}
        open={confirming === 'revoke'}
        title="Revoke webhook URL?"
      />
    </div>
  );
}

function WebhookCard({
  number,
  template,
  canManage,
}: {
  number: string;
  template: WorkflowTemplateSummary;
  canManage: boolean;
}) {
  const regenerate = useRegenerateWebhook(template.id);
  const revoke = useRevokeWebhook(template.id);
  const [error, setError] = useState<string | null>(null);
  // The token is a trigger credential: the API returns it exactly once, from
  // the regenerate call, so it only lives in this component's state until the
  // page is left. Afterwards the template only reports that one is configured.
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const webhookUrl = freshToken
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/api/v1/webhooks/${freshToken}`
    : null;

  const handleRegenerate = async () => {
    setError(null);
    try {
      const { webhookToken } = await regenerate.mutateAsync();
      setFreshToken(webhookToken);
    } catch (err) {
      setError(errMsg(err, 'regenerate failed'));
    }
  };

  // Confirmed from WebhookActions: errors propagate so the ConfirmModal shows them.
  const confirmRegenerate = async () => {
    setError(null);
    const { webhookToken } = await regenerate.mutateAsync();
    setFreshToken(webhookToken);
  };

  const confirmRevoke = async () => {
    setError(null);
    await revoke.mutateAsync();
    setFreshToken(null);
  };

  return (
    <Card variant="inset">
      <SectionHeader hint="HTTP" number={number} title="Webhook trigger" />
      {error && <Alert className="mb-3 text-xs">{error}</Alert>}
      {webhookUrl ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-ink-900 px-2 py-1 font-mono text-[10px] text-paper-300">
              {webhookUrl}
            </code>
            <CopyButton value={webhookUrl} />
          </div>
          {canManage && (
            <WebhookActions onRegenerate={confirmRegenerate} onRevoke={confirmRevoke} />
          )}
        </div>
      ) : template.webhookConfigured ? (
        <div className="space-y-3">
          <p className="text-xs text-paper-500">
            A webhook URL is configured. The token is shown only once, when it is generated —
            regenerate to issue a new one (the previous URL stops working) or revoke it.
          </p>
          {canManage && (
            <WebhookActions onRegenerate={confirmRegenerate} onRevoke={confirmRevoke} />
          )}
        </div>
      ) : (
        <EmptyState
          action={
            canManage && (
              <Button
                disabled={regenerate.isPending}
                onClick={handleRegenerate}
                size="sm"
                variant="secondary"
              >
                {regenerate.isPending ? 'Generating…' : 'Generate webhook URL'}
              </Button>
            )
          }
          className="py-0 text-left text-xs"
          title="No webhook configured."
        />
      )}
    </Card>
  );
}

export default function TemplateDetailPage({ params }: PageProps) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const {
    data: template,
    isLoading,
    isError,
    isFetching,
    refetch,
    error,
  } = useWorkflowTemplate(id ?? '');
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const effectiveVersion = selectedVersion ?? template?.activeVersion ?? null;
  const { data: versionDetail } = useWorkflowTemplateVersion(id ?? '', effectiveVersion);
  const { data: stepRegistry } = useStepRegistry();
  const { data: analytics } = useWorkflowTemplateAnalytics(id ?? '', 30);
  const createVersion = useCreateWorkflowVersion(id ?? '');
  const promoteVersion = usePromoteWorkflowVersion(id ?? '');
  const reviewVersion = useReviewWorkflowVersion(id ?? '');
  // Every write here (new version, promote, review, refine, metadata, webhook)
  // is a LEAD route on the gateway that also requires LEAD membership on the
  // template's owning team (templateWriteFilter) — a GLOBAL template is
  // ADMIN-only. Anyone else gets a read-only view.
  const platformRole = useAuthStore((s) => s.user?.role);
  const ledTeamIds = useLedTeamIds();
  const canManage = canWriteTeamResource(platformRole, template?.team?.id, ledTeamIds);

  const [mode, setMode] = useState<ViewMode>('view');
  const [editorSpec, setEditorSpec] = useState<WorkflowSpec | null>(null);
  const [editorJson, setEditorJson] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingShellSpec, setPendingShellSpec] = useState<WorkflowSpec | null>(null);
  const [editMetaOpen, setEditMetaOpen] = useState(false);
  const [editSchemaOpen, setEditSchemaOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);

  useEffect(() => {
    if (versionDetail) {
      try {
        setEditorSpec(parseWorkflowSpec(versionDetail.spec));
        setSaveError(null);
      } catch (err) {
        setEditorSpec(null);
        setSaveError(formatSpecError(err));
      }
      setEditorJson(JSON.stringify(versionDetail.spec, null, 2));
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
  // Each role at the price of the model its GLOBAL agent runs today; a role
  // the catalog cannot price keeps the estimator's built-in default.
  const { data: rolePrices } = useRolePricing();
  const costEstimate = useMemo(() => {
    if (!visualSpec || !stepRegistryByName) {
      return null;
    }
    return estimateSpecCost(visualSpec, {
      pricing: rolePrices ? estimatorPricing(rolePrices) : undefined,
      stepLookup: (name) => stepRegistryByName.get(name),
    });
  }, [visualSpec, stepRegistryByName, rolePrices]);

  if (!id) {
    return <TemplateNotFound />;
  }
  // Before the not-found branch, so a 403 or 500 is not reported as "not found".
  if (isLoading || isError) {
    return (
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="workflow"
        loadingMessage="loading workflow…"
        onRetry={() => void refetch()}
      />
    );
  }
  if (!template) {
    return <TemplateNotFound />;
  }

  const commitSave = async (spec: WorkflowSpec) => {
    try {
      const result = await createVersion.mutateAsync(spec);
      setSelectedVersion(result.data.version);
      setMode('view');
      setSaveError(null);
    } catch (err) {
      setSaveError(errMsg(err, 'save failed'));
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
    setSaveError(null);
    if (versionDetail) {
      try {
        setEditorSpec(parseWorkflowSpec(versionDetail.spec));
      } catch (err) {
        setEditorSpec(null);
        setSaveError(formatSpecError(err));
      }
      setEditorJson(JSON.stringify(versionDetail.spec, null, 2));
    }
    setMode('view');
  };

  const handlePromote = async () => {
    if (effectiveVersion === null) {
      return;
    }
    try {
      await promoteVersion.mutateAsync(effectiveVersion);
      setSaveError(null);
    } catch (err) {
      setSaveError(errMsg(err, 'promote failed'));
    }
  };

  const handleReview = async () => {
    if (effectiveVersion === null) {
      return;
    }
    try {
      await reviewVersion.mutateAsync(effectiveVersion);
      setSaveError(null);
    } catch (err) {
      setSaveError(errMsg(err, 'review failed'));
    }
  };

  // Right-rail sections, in render order — numbered from this one list so a
  // conditional section never leaves a gap or a duplicate.
  const railSections = [
    template.versions.length > 1 && 'versions',
    analytics && analytics.totalRuns > 0 && 'observed',
    'schema',
    template.versions.length > 1 && 'experiment',
    'webhook',
  ].filter(Boolean);
  const railNumber = (key: string) => String(railSections.indexOf(key) + 1).padStart(2, '0');

  const selectedNeedsReview =
    canManage &&
    effectiveVersion !== null &&
    effectiveVersion !== template.activeVersion &&
    versionDetail?.generatedBy != null &&
    versionDetail?.reviewedAt == null;

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
      {mode === 'view' && canManage && (
        <Button onClick={() => setMode('edit')} size="sm" variant="secondary">
          Edit
        </Button>
      )}
      <Button
        onClick={() => setMode(mode === 'json' ? (canManage ? 'edit' : 'view') : 'json')}
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
      {!isDirty &&
        canManage &&
        effectiveVersion !== null &&
        effectiveVersion !== template.activeVersion &&
        (selectedNeedsReview ? (
          <Button
            disabled={reviewVersion.isPending}
            onClick={handleReview}
            size="sm"
            variant="primary"
          >
            {reviewVersion.isPending ? 'Reviewing…' : 'Review & approve'}
          </Button>
        ) : (
          <Button
            disabled={promoteVersion.isPending}
            onClick={handlePromote}
            size="sm"
            variant="primary"
          >
            {promoteVersion.isPending ? 'Promoting…' : 'Promote to active'}
          </Button>
        ))}
    </>
  );

  return (
    <div className="space-y-8">
      <ExplainModal onClose={() => setExplainOpen(false)} open={explainOpen} templateId={id} />

      <RefineChatPanel onClose={() => setRefineOpen(false)} open={refineOpen} templateId={id} />

      <div>
        <TemplateBackLink href="/workflows/library" label="Workflow library" />
        <PageHeader
          actions={
            <>
              {template.status === 'ACTIVE' && template.activeVersion !== null && (
                <ButtonLink
                  href={`/start?template=${encodeURIComponent(template.id)}`}
                  size="sm"
                  variant="primary"
                >
                  Run →
                </ButtonLink>
              )}
              {template.activeVersion !== null && (
                <Button onClick={() => setExplainOpen(true)} size="sm" variant="secondary">
                  <SparkleTextIcon />
                  Explain
                </Button>
              )}
              {canManage && (
                <Button onClick={() => setRefineOpen(true)} size="sm" variant="secondary">
                  <SparkleIcon />
                  Refine with AI
                </Button>
              )}
              {canManage && (
                <Button onClick={() => setEditMetaOpen(true)} size="sm" variant="secondary">
                  Edit metadata
                </Button>
              )}
            </>
          }
          chapter="§ Workflows"
          className="mb-0 mt-4"
          subtitle={
            template.description ||
            'A workflow: its versions, launch inputs, experiment and triggers.'
          }
          title={template.name}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <StatusBadge status={template.status} />
          {effectiveVersion !== null && (
            <Badge tone="neutral" variant="outline">
              v{effectiveVersion}
            </Badge>
          )}
          <VersionTags
            active={effectiveVersion === template.activeVersion}
            isDefault={template.isDefault}
          />
          {template.experimentVersion && (
            <Badge tone="violet" uppercase variant="outline">
              A/B: v{template.experimentVersion} ({template.experimentSplit ?? 0}%)
            </Badge>
          )}
        </div>
      </div>

      <TemplateSubNav active="editor" templateId={id} />

      {saveError && <Alert>{saveError}</Alert>}

      {/* Edit mode: full-bleed canvas */}
      {mode === 'edit' && editorSpec && stepRegistry && (
        <div className="-mx-4 md:-mx-10">
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
          <div className="min-w-0 space-y-4">
            {mode === 'view' && visualSpec && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="label-mono">Definition (read only)</div>
                  <div className="flex items-center gap-2">{editorActions}</div>
                </div>
                <WorkflowDag
                  height="calc(100vh - 360px)"
                  onSelect={setSelectedNodeId}
                  outline
                  selectedNodeId={selectedNodeId}
                  spec={visualSpec}
                />
              </div>
            )}

            {mode === 'json' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="label-mono" htmlFor="spec-json">
                    Raw JSON
                  </label>
                  <div className="flex items-center gap-2">{editorActions}</div>
                </div>
                <Textarea
                  className="h-[520px] p-4"
                  compact
                  id="spec-json"
                  onChange={(e) => handleJsonChange(e.target.value)}
                  readOnly={!canManage}
                  spellCheck={false}
                  value={editorJson}
                />
                {jsonParsed?.ok === false && <Alert>JSON parse error — {jsonParsed.error}</Alert>}
              </div>
            )}
          </div>

          {/* Right rail */}
          <aside className="space-y-4">
            {/* Versions */}
            {template.versions.length === 1 ? (
              <Card variant="inset">
                <div className="label-mono">Version</div>
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
                  <VersionTags
                    active={template.versions[0]?.version === template.activeVersion}
                    needsReview={
                      !!template.versions[0]?.generatedBy && !template.versions[0]?.reviewedAt
                    }
                  />
                </div>
                <p className="mt-3 text-[11px] leading-snug text-paper-500">
                  Save changes to create a second version and unlock A/B testing.
                </p>
              </Card>
            ) : (
              <Card variant="inset">
                <SectionHeader
                  hint={`${template.versions.length}`}
                  number={railNumber('versions')}
                  title="Versions"
                />
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
                          <VersionTags
                            active={v.version === template.activeVersion}
                            experiment={v.version === template.experimentVersion}
                            needsReview={!!v.generatedBy && !v.reviewedAt}
                          />
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
                <SectionHeader hint="30d" number={railNumber('observed')} title="Observed" />
                <dl className="space-y-2">
                  <KeyValueRow label="Runs">{analytics.totalRuns}</KeyValueRow>
                  <KeyValueRow label="Success rate">
                    {formatPercent(analytics.successRate)}
                  </KeyValueRow>
                  {template.estimatedHumanTimeSavedMinutes != null && (
                    <KeyValueRow label="Est. time saved">
                      {formatDuration(template.estimatedHumanTimeSavedMinutes * 60_000)}/run
                    </KeyValueRow>
                  )}
                  {analytics.agentErrorRate != null && (
                    <KeyValueRow label="Agent error rate">
                      {formatPercent(analytics.agentErrorRate)}
                    </KeyValueRow>
                  )}
                  {analytics.autonomyRate != null && (
                    <KeyValueRow label="Autonomy rate">
                      {formatPercent(analytics.autonomyRate)}
                    </KeyValueRow>
                  )}
                  {analytics.humanReviewRate != null && (
                    <KeyValueRow label="Human review rate">
                      {formatPercent(analytics.humanReviewRate)}
                    </KeyValueRow>
                  )}
                  {analytics.avgCostPerRun != null && (
                    <KeyValueRow label="Avg cost / run">
                      {formatCost(analytics.avgCostPerRun)}
                    </KeyValueRow>
                  )}
                  {analytics.p50DurationMs != null && (
                    <KeyValueRow label="p50 duration">
                      {formatDuration(analytics.p50DurationMs)}
                    </KeyValueRow>
                  )}
                </dl>
              </Card>
            )}

            {/* Run schema */}
            <Card variant="inset">
              <SectionHeader
                actions={
                  canManage ? (
                    <Button onClick={() => setEditSchemaOpen(true)} size="sm" variant="ghost">
                      Edit
                    </Button>
                  ) : undefined
                }
                number={railNumber('schema')}
                title="Launch inputs"
              />
              {(() => {
                const inputSchema = template.inputSchema;
                if (!isInputSchema(inputSchema)) {
                  return (
                    <EmptyState
                      className="py-0 text-left text-xs"
                      title="No launch inputs — runs accept any input"
                    />
                  );
                }
                return (
                  <ul className="mt-2 space-y-1">
                    {Object.entries(inputSchema.properties).map(([key, prop]) => (
                      <li className="flex items-baseline gap-2 text-xs" key={key}>
                        <span className="font-mono text-paper-200">{key}</span>
                        <span className="text-paper-500">{prop.type}</span>
                        {inputSchema.required?.includes(key) && (
                          <Badge tone="brick" variant="text">
                            required
                          </Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </Card>

            {/* A/B experiment config */}
            {template.versions.length > 1 && (
              <ExperimentCard
                activeVersion={template.activeVersion}
                experimentSplit={template.experimentSplit ?? null}
                experimentVersion={template.experimentVersion ?? null}
                number={railNumber('experiment')}
                templateId={id}
                versions={template.versions}
              />
            )}

            {/* Webhook trigger */}
            <WebhookCard canManage={canManage} number={railNumber('webhook')} template={template} />
          </aside>
        </div>
      )}

      <EditMetadataModal
        initialDescription={template.description ?? ''}
        initialEstimatedHumanTimeSavedMinutes={template.estimatedHumanTimeSavedMinutes ?? null}
        initialName={template.name}
        isDefault={template.isDefault}
        onClose={() => setEditMetaOpen(false)}
        open={editMetaOpen}
        templateId={id}
      />

      <EditSchemaModal
        initialSchema={template.inputSchema}
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
