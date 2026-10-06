'use client';

import { type InputSchema, isInputSchema } from '@auto-swe/shared/lib/inputSchema';
import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import type { StepMetadata, WorkflowSpec } from '@auto-swe/shared/workflow';
import {
  estimateSpecCost,
  formatValidationIssue,
  parseWorkflowSpec,
  validateSpec,
} from '@auto-swe/shared/workflow';
import { use, useEffect, useMemo, useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SparkleIcon, SparkleTextIcon } from '@/components/ui/icons';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Slider } from '@/components/ui/Slider';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Textarea } from '@/components/ui/Textarea';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { InputSchemaBuilder } from '@/components/workflow/InputSchemaBuilder';
import { KeyValueRow } from '@/components/workflow/KeyValueRow';
import { PromoteVersionModal } from '@/components/workflow/PromoteVersionModal';
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
import {
  cn,
  FOCUS_RING,
  formatCost,
  formatDate,
  formatDuration,
  formatPercent,
  formatRelativeTime,
} from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

interface PageProps {
  params: Promise<{ id: string }>;
}

type ViewMode = 'view' | 'edit' | 'json';

function formatSpecError(err: unknown): string {
  if (err instanceof Error && 'issues' in err) {
    const issues = (err as { issues?: Array<{ message?: string }> }).issues ?? [];
    const all = issues.map((i) => i.message).filter((m): m is string => !!m);
    return all.length > 0 ? all.join('\n') : err.message;
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
        <SegmentedControl
          ariaLabel="Launch inputs view"
          onChange={(v) => setPreview(v === 'preview')}
          options={[
            { label: 'Fields', value: 'edit' },
            { label: 'Preview form', value: 'preview' },
          ]}
          value={preview ? 'preview' : 'edit'}
        />
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

/** One card of the right rail: a small heading, an optional hint and action, then the body. */
function RailCard({
  action,
  children,
  hint,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  hint?: string;
  title: string;
}) {
  return (
    <Card className="p-4" variant="inset">
      <div className="mb-3 flex min-h-7 items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-paper-100">
          {title}
          {hint && <span className="ml-2 font-normal text-paper-500">{hint}</span>}
        </h2>
        {action}
      </div>
      {children}
    </Card>
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
  const [saved, markSaved] = useTransientFlag();

  const nonActive = versions.filter((v) => v.version !== activeVersion);

  // A version with lint errors can be saved as a draft but cannot serve traffic, so it cannot be
  // an experiment arm. Only the chosen version's spec is loaded, so the check runs on selection.
  const { data: armDetail } = useWorkflowTemplateVersion(templateId, expVer);
  const armErrorCount = useMemo(() => {
    if (!armDetail || expVer == null) {
      return 0;
    }
    try {
      return validateSpec(parseWorkflowSpec(armDetail.spec)).errors.length;
    } catch {
      return 1;
    }
  }, [armDetail, expVer]);

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
    <RailCard hint="A/B test" title="Experiment">
      {error && <Alert className="mb-3 text-xs">{error}</Alert>}
      <div className="space-y-3">
        <Select
          compact
          hint="Send a share of new runs to another version"
          label="Experiment version"
          onChange={(v) => setExpVer(v ? Number(v) : null)}
          options={[
            { label: 'None', value: '' },
            ...nonActive.map((v) => ({ label: `v${v.version}`, value: String(v.version) })),
          ]}
          value={expVer == null ? '' : String(expVer)}
        />
        {expVer && armErrorCount > 0 && (
          <Alert className="text-xs">
            v{expVer} has {armErrorCount} error{armErrorCount === 1 ? '' : 's'}, so it cannot be
            used in an experiment until they are fixed.
          </Alert>
        )}
        {expVer && (
          <div className="space-y-1.5">
            <Slider
              formatValue={(v) => `${v}%`}
              id="exp-split"
              label="Traffic to the experiment"
              max={50}
              min={1}
              onChange={setSplit}
              value={split}
            />
            <p className="text-xs text-paper-500 tabular-nums">
              v{activeVersion} gets {100 - split}% · v{expVer} gets {split}%
            </p>
          </div>
        )}
        <div className="flex gap-2">
          <Button
            disabled={updateTemplate.isPending || armErrorCount > 0}
            onClick={handleSave}
            size="sm"
            variant="secondary"
          >
            {saved ? (
              <>
                <Icon name="check" size={13} />
                Saved
              </>
            ) : updateTemplate.isPending ? (
              'Saving…'
            ) : (
              'Save experiment'
            )}
          </Button>
          {(experimentVersion || expVer) && (
            <Button onClick={handleClear} size="sm" variant="ghost">
              Clear
            </Button>
          )}
        </div>
      </div>
    </RailCard>
  );
}

function ExplainModal({
  activeVersion,
  open,
  onClose,
  templateId,
}: {
  activeVersion: number | null;
  open: boolean;
  onClose: () => void;
  templateId: string;
}) {
  const { data, error, isFetching } = useExplainWorkflowTemplate(templateId, activeVersion, open);

  return (
    <Modal eyebrow="§ Workflow" onClose={onClose} open={open} title="What this workflow does">
      <div className="space-y-4">
        {isFetching && !data && <LoadingState message="Explaining…" />}
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
  template,
  canManage,
}: {
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
    <RailCard hint="HTTP" title="Webhook trigger">
      {error && <Alert className="mb-3 text-xs">{error}</Alert>}
      {webhookUrl ? (
        <div className="space-y-3">
          <Alert className="text-xs" variant="warning">
            Copy this URL now. It is shown only once.
          </Alert>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-[11px] text-paper-300">
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
          <p className="flex items-center gap-2 text-[13px] text-paper-200">
            <Badge dot tone="moss">
              Configured
            </Badge>
          </p>
          <p className="text-xs leading-relaxed text-paper-500">
            The URL is shown only once, when it is generated. Regenerate to issue a new one (the
            current URL stops working) or revoke it.
          </p>
          {canManage && (
            <WebhookActions onRegenerate={confirmRegenerate} onRevoke={confirmRevoke} />
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-paper-500">
            No webhook yet. Generate a URL to let another system start this workflow with an HTTP
            request.
          </p>
          {canManage && (
            <Button
              disabled={regenerate.isPending}
              onClick={handleRegenerate}
              size="sm"
              variant="secondary"
            >
              {regenerate.isPending ? 'Generating…' : 'Generate webhook URL'}
            </Button>
          )}
        </div>
      )}
    </RailCard>
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
  const [pendingErrorSpec, setPendingErrorSpec] = useState<WorkflowSpec | null>(null);
  const [editMetaOpen, setEditMetaOpen] = useState(false);
  const [editSchemaOpen, setEditSchemaOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  // A version the user clicked in the rail while there were unsaved edits.
  const [pendingVersion, setPendingVersion] = useState<number | null>(null);

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

  const isDirty =
    mode === 'edit' ||
    (mode === 'json' &&
      versionDetail !== undefined &&
      editorJson !== JSON.stringify(versionDetail.spec, null, 2));

  // Leaving the page (reload, close, outside link) with unsaved edits loses them.
  useEffect(() => {
    if (!isDirty) {
      return;
    }
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  const jsonParsed = useMemo(
    () => (mode === 'json' && editorJson ? tryParseSpec(editorJson) : null),
    [mode, editorJson]
  );
  const visualSpec: WorkflowSpec | null =
    mode === 'json' ? (jsonParsed?.ok ? jsonParsed.spec : null) : editorSpec;

  // The selected version's own lint, dirty or not: a draft saved with errors keeps them, and
  // promoting or activating it stays blocked until they are fixed.
  const lintErrors = useMemo(
    () => (visualSpec ? validateSpec(visualSpec).errors : []),
    [visualSpec]
  );
  const lintErrorCount = lintErrors.length;

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
    // Errors do not stop a save, which keeps work in progress; they ask first, and the version
    // is saved inactive. Promote and Activate stay blocked until the errors are gone.
    if (lintErrorCount > 0) {
      setPendingErrorSpec(specToSave);
      return;
    }
    await continueSave(specToSave);
  };

  const continueSave = async (specToSave: WorkflowSpec) => {
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

  const handleReview = async () => {
    if (effectiveVersion === null) {
      return;
    }
    try {
      await reviewVersion.mutateAsync(effectiveVersion);
      setSaveError(null);
      // A draft's only version has nothing else to promote, so approving it
      // leads straight to activating it.
      if (template.status === 'DRAFT' && effectiveVersion === template.activeVersion) {
        setPromoteOpen(true);
      }
    } catch (err) {
      setSaveError(errMsg(err, 'review failed'));
    }
  };

  const selectedNeedsReview =
    canManage &&
    effectiveVersion !== null &&
    (effectiveVersion !== template.activeVersion || template.status === 'DRAFT') &&
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

  const jsonInvalid = mode === 'json' && jsonParsed?.ok === false;
  const promoteBlocked = lintErrorCount > 0;
  const promoteReason = promoteBlocked
    ? `Fix ${lintErrorCount} error${lintErrorCount === 1 ? '' : 's'} before promoting`
    : null;

  const canPromote =
    !isDirty &&
    canManage &&
    effectiveVersion !== null &&
    (effectiveVersion !== template.activeVersion || template.status === 'DRAFT');
  // The header already offers Run on an active workflow, so promotion there is secondary.
  const promoteVariant = template.status === 'ACTIVE' ? 'secondary' : 'primary';
  const isActiveVersion = effectiveVersion === template.activeVersion;

  const editorActions = (
    <>
      <SegmentedControl
        ariaLabel="Editor view"
        onChange={(next) => {
          if ((next === 'json') !== (mode === 'json')) {
            setMode(mode === 'json' ? (canManage ? 'edit' : 'view') : 'json');
          }
        }}
        options={[
          { label: 'Visual', value: 'visual' },
          { label: 'JSON', value: 'json' },
        ]}
        value={mode === 'json' ? 'json' : 'visual'}
      />
      {mode === 'view' && canManage && (
        <Button onClick={() => setMode('edit')} size="sm" variant="secondary">
          <Icon name="edit" size={13} />
          Edit
        </Button>
      )}
      {isDirty && (
        <Button onClick={handleCancel} size="sm" variant="ghost">
          Cancel
        </Button>
      )}
      {isDirty && jsonInvalid && (
        <span className="text-xs text-brick-400" id="save-blocked-reason">
          Fix the JSON to save
        </span>
      )}
      {isDirty && (
        <Button
          aria-describedby={jsonInvalid ? 'save-blocked-reason' : undefined}
          disabled={createVersion.isPending || jsonInvalid}
          onClick={handleSave}
          size="sm"
          variant="primary"
        >
          {createVersion.isPending ? 'Saving…' : 'Save new version'}
        </Button>
      )}
      {canPromote && promoteReason && (
        <span className="text-xs text-brick-400" id="promote-blocked-reason">
          {promoteReason}
        </span>
      )}
      {canPromote &&
        (selectedNeedsReview ? (
          <Button
            aria-describedby={
              promoteBlocked && isActiveVersion ? 'promote-blocked-reason' : undefined
            }
            disabled={reviewVersion.isPending || (promoteBlocked && isActiveVersion)}
            onClick={handleReview}
            size="sm"
            variant={promoteVariant}
          >
            {reviewVersion.isPending
              ? 'Reviewing…'
              : isActiveVersion
                ? 'Review & activate'
                : 'Review & approve'}
          </Button>
        ) : (
          <Button
            aria-describedby={promoteBlocked ? 'promote-blocked-reason' : undefined}
            disabled={promoteBlocked}
            onClick={() => setPromoteOpen(true)}
            size="sm"
            variant={promoteVariant}
          >
            {isActiveVersion ? 'Activate' : 'Promote to active'}
          </Button>
        ))}
    </>
  );

  const inputSchema = isInputSchema(template.inputSchema) ? template.inputSchema : null;
  const runnable = template.status === 'ACTIVE' && template.activeVersion !== null;

  return (
    <div className="space-y-6">
      <ExplainModal
        activeVersion={template.activeVersion}
        onClose={() => setExplainOpen(false)}
        open={explainOpen}
        templateId={id}
      />

      <RefineChatPanel onClose={() => setRefineOpen(false)} open={refineOpen} templateId={id} />

      <div>
        <TemplateBackLink href="/workflows/library" label="Workflow library" />
        <PageHeader
          actions={
            <>
              {template.activeVersion !== null && (
                <Button onClick={() => setExplainOpen(true)} size="sm" variant="ghost">
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
              {runnable && (
                <ButtonLink
                  href={`/start?template=${encodeURIComponent(template.id)}`}
                  size="sm"
                  variant="primary"
                >
                  Run
                  <Icon name="arrowRight" size={13} />
                </ButtonLink>
              )}
              {canManage && (
                <ActionMenu
                  items={[
                    {
                      icon: 'edit',
                      id: 'details',
                      label: 'Edit details',
                      onAction: () => setEditMetaOpen(true),
                    },
                    {
                      icon: 'sliders',
                      id: 'inputs',
                      label: 'Edit launch inputs',
                      onAction: () => setEditSchemaOpen(true),
                    },
                  ]}
                  label={`More actions for ${template.name}`}
                />
              )}
            </>
          }
          className="mt-3 mb-0"
          subtitle={
            template.description ||
            'A workflow: its versions, launch inputs, experiment and triggers.'
          }
          title={template.name}
        />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusBadge status={template.status} />
          <Badge tone="neutral" variant="outline">
            {template.team?.name ?? 'Platform-wide'}
          </Badge>
          <VersionTags isDefault={template.isDefault} />
          {template.webhookConfigured && (
            <Badge title="A webhook URL can start this workflow" tone="violet" variant="outline">
              Webhook
            </Badge>
          )}
          {template.experimentVersion && (
            <Badge tone="violet" variant="outline">
              A/B test: v{template.experimentVersion} at {template.experimentSplit ?? 0}%
            </Badge>
          )}
        </div>
      </div>

      <TemplateSubNav active="editor" templateId={id} />

      {saveError && mode !== 'edit' && (
        <Alert className="whitespace-pre-line" title="Could not save">
          {saveError}
        </Alert>
      )}

      {/* The visual editor lists its own lint; every other mode shows it here. */}
      {mode !== 'edit' && lintErrors.length > 0 && (
        <Alert
          title={`${lintErrors.length} error${lintErrors.length === 1 ? '' : 's'} in this workflow`}
        >
          <ul className="list-disc space-y-0.5 pl-5" data-testid="spec-errors">
            {lintErrors.map((issue) => (
              <li key={`${issue.code}:${issue.nodeId ?? ''}:${issue.field ?? ''}:${issue.message}`}>
                {formatValidationIssue(issue)}
              </li>
            ))}
          </ul>
        </Alert>
      )}

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
            serverError={saveError}
            spec={editorSpec}
            stepRegistry={stepRegistry as StepMetadata[]}
          />
        </div>
      )}

      {/* View / JSON mode with versions + analytics rail */}
      {mode !== 'edit' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="flex min-w-0 items-baseline gap-2">
                {mode === 'json' ? (
                  <label
                    className="text-sm font-semibold text-paper-100"
                    htmlFor="spec-json"
                    id="definition-heading"
                  >
                    Raw JSON
                  </label>
                ) : (
                  <h2 className="text-sm font-semibold text-paper-100" id="definition-heading">
                    Definition
                  </h2>
                )}
                {effectiveVersion !== null && (
                  <span className="text-[13px] text-paper-500 tabular-nums">
                    v{effectiveVersion}
                    {isActiveVersion ? ' · active' : ' · not active'}
                    {mode === 'view' || !canManage ? ' · read only' : ''}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">{editorActions}</div>
            </div>

            {mode === 'view' && visualSpec && (
              <WorkflowDag
                height="calc(100vh - 360px)"
                onSelect={setSelectedNodeId}
                outline
                selectedNodeId={selectedNodeId}
                spec={visualSpec}
              />
            )}
            {mode === 'view' && !visualSpec && (
              <Card variant="inset">
                {versionDetail ? (
                  <EmptyState
                    hint="Switch to JSON to see and fix the stored definition."
                    icon="warning"
                    title="This version cannot be drawn"
                  />
                ) : (
                  <LoadingState message="Loading the definition…" />
                )}
              </Card>
            )}

            {mode === 'json' && (
              <>
                <Textarea
                  className="h-[520px] p-4 font-mono text-xs leading-relaxed"
                  compact
                  id="spec-json"
                  onChange={(e) => handleJsonChange(e.target.value)}
                  readOnly={!canManage}
                  spellCheck={false}
                  value={editorJson}
                />
                {jsonParsed?.ok === false && (
                  <Alert className="whitespace-pre-line" title="The JSON does not parse">
                    {jsonParsed.error}
                  </Alert>
                )}
              </>
            )}
          </section>

          {/* Right rail */}
          <aside aria-label="Workflow settings" className="space-y-4">
            <RailCard
              hint={template.versions.length > 1 ? String(template.versions.length) : undefined}
              title={template.versions.length > 1 ? 'Versions' : 'Version'}
            >
              <ul className="-mx-1.5 space-y-0.5">
                {template.versions.map((v) => {
                  const selected = effectiveVersion === v.version;
                  return (
                    <li key={v.id}>
                      <button
                        aria-current={selected ? 'true' : undefined}
                        className={cn(
                          'w-full rounded-md px-2.5 py-2 text-left transition-colors',
                          FOCUS_RING,
                          selected
                            ? 'bg-ink-600/70 text-paper-50'
                            : 'text-paper-300 hover:bg-ink-700/60 hover:text-paper-100'
                        )}
                        disabled={template.versions.length === 1}
                        onClick={() =>
                          isDirty ? setPendingVersion(v.version) : setSelectedVersion(v.version)
                        }
                        type="button"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium tabular-nums">v{v.version}</span>
                            <VersionTags
                              active={v.version === template.activeVersion}
                              experiment={v.version === template.experimentVersion}
                              needsReview={!!v.generatedBy && !v.reviewedAt}
                            />
                          </span>
                          <span
                            className="shrink-0 text-xs text-paper-500"
                            title={formatDate(v.createdAt)}
                          >
                            {formatRelativeTime(v.createdAt)}
                          </span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {template.versions.length === 1 && (
                <p className="mt-2 text-xs leading-relaxed text-paper-500">
                  Saving a change creates a second version and unlocks comparing and A/B testing.
                </p>
              )}
            </RailCard>

            {/* Observed analytics summary */}
            {analytics && analytics.totalRuns > 0 && (
              <RailCard
                action={
                  <ButtonLink href={`/workflows/library/${id}/analytics`} size="sm" variant="ghost">
                    Details
                  </ButtonLink>
                }
                hint="Last 30 days"
                title="Observed"
              >
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
              </RailCard>
            )}

            {/* Run schema */}
            <RailCard
              action={
                canManage ? (
                  <Button
                    aria-label="Edit launch inputs"
                    onClick={() => setEditSchemaOpen(true)}
                    size="sm"
                    variant="ghost"
                  >
                    Edit
                  </Button>
                ) : undefined
              }
              title="Launch inputs"
            >
              {inputSchema ? (
                <ul className="divide-y divide-ink-600">
                  {Object.entries(inputSchema.properties).map(([key, prop]) => (
                    <li
                      className="flex items-baseline justify-between gap-2 py-1.5 first:pt-0 last:pb-0"
                      key={key}
                    >
                      <span className="min-w-0 truncate font-mono text-xs text-paper-200">
                        {key}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-paper-500">
                        {prop.type}
                        {inputSchema.required?.includes(key) && (
                          <Badge tone="amber" variant="outline">
                            Required
                          </Badge>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs leading-relaxed text-paper-500">
                  No launch inputs, so a run accepts any input.
                </p>
              )}
            </RailCard>

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

            {/* Webhook trigger */}
            <WebhookCard canManage={canManage} template={template} />
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

      {effectiveVersion !== null && (
        <PromoteVersionModal
          activeVersion={template.activeVersion}
          onClose={() => setPromoteOpen(false)}
          open={promoteOpen}
          templateId={id}
          version={effectiveVersion}
        />
      )}

      <ConfirmModal
        confirmLabel="Discard changes"
        dangerous
        message="You have unsaved edits to this version. Switching versions discards them."
        onClose={() => setPendingVersion(null)}
        onConfirm={() => {
          if (pendingVersion !== null) {
            setMode('view');
            setSelectedVersion(pendingVersion);
          }
        }}
        open={pendingVersion !== null}
        title="Discard unsaved changes?"
      />

      <ConfirmModal
        confirmLabel="Save draft"
        message={`This workflow has ${lintErrorCount} error${lintErrorCount === 1 ? '' : 's'}. It is saved as an inactive draft: nothing runs it, and it cannot be promoted, activated or used in an experiment until the errors are fixed.`}
        onClose={() => setPendingErrorSpec(null)}
        onConfirm={() => {
          if (pendingErrorSpec) {
            const spec = pendingErrorSpec;
            setPendingErrorSpec(null);
            void continueSave(spec);
          }
        }}
        open={pendingErrorSpec !== null}
        title={`Save draft with ${lintErrorCount} error${lintErrorCount === 1 ? '' : 's'}?`}
      />

      <ConfirmModal
        confirmLabel="Save with shell steps"
        message={`This version contains ${Object.values(pendingShellSpec?.nodes ?? {}).filter((n) => n.type === 'shell').length} shell step(s). Shell steps run commands in an isolated container, so only team leads and admins can author or approve a version that contains them.`}
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
