import { isInputSchema } from '@auto-swe/shared/lib/inputSchema';
import type { StepMetadata, WorkflowSpec } from '@auto-swe/shared/workflow';
import { estimateSpecCost, parseWorkflowSpec, validateSpec } from '@auto-swe/shared/workflow';
import { use, useEffect, useMemo, useState } from 'react';
import { countContainerNodes } from '@/components/workflow/containerNodes';
import { useRolePricing } from '@/hooks/useModelCatalog';
import { useLedTeamIds } from '@/hooks/useTeams';
import {
  useCreateWorkflowVersion,
  useReviewWorkflowVersion,
  useStepRegistry,
  useWorkflowTemplate,
  useWorkflowTemplateAnalytics,
  useWorkflowTemplateVersion,
} from '@/hooks/useTemplates';
import { errMsg } from '@/lib/errors';
import { estimatorPricing } from '@/lib/modelCatalog';
import { validateRouteParam } from '@/lib/routeParams';
import { schemaIssues } from '@/lib/specSchemaIssues';
import { canWriteTeamResource } from '@/lib/teamPermissions';
import { useAuthStore } from '@/stores/authStore';
import type { ViewMode } from './EditorActions';

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

/**
 * All of the workflow detail page's state: the queries and mutations, the editor's local UI
 * state, the values derived from them, and the save / cancel / review handlers. The page keeps
 * the early returns (no id, loading, not found), so every hook here runs on every render.
 */
export function useWorkflowDetailState(params: Promise<{ id: string }>) {
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
    () => (visualSpec ? [...schemaIssues(visualSpec), ...validateSpec(visualSpec).errors] : []),
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

  const continueSave = async (specToSave: WorkflowSpec) => {
    const shellCount = countContainerNodes(specToSave);
    if (shellCount > 0) {
      setPendingShellSpec(specToSave);
      return;
    }
    await commitSave(specToSave);
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
      if (template?.status === 'DRAFT' && effectiveVersion === template.activeVersion) {
        setPromoteOpen(true);
      }
    } catch (err) {
      setSaveError(errMsg(err, 'review failed'));
    }
  };

  const selectedNeedsReview =
    canManage &&
    effectiveVersion !== null &&
    (effectiveVersion !== template?.activeVersion || template?.status === 'DRAFT') &&
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
    (effectiveVersion !== template?.activeVersion || template?.status === 'DRAFT');
  // The header already offers Run on an active workflow, so promotion there is secondary.
  const promoteVariant =
    template?.status === 'ACTIVE' ? ('secondary' as const) : ('primary' as const);
  const isActiveVersion = effectiveVersion === template?.activeVersion;

  const templateInputSchema = template?.inputSchema;
  const inputSchema = isInputSchema(templateInputSchema) ? templateInputSchema : null;

  return {
    analytics,
    canManage,
    canPromote,
    commitSave,
    continueSave,
    costEstimate,
    createVersion,
    editMetaOpen,
    editorJson,
    editorSpec,
    editSchemaOpen,
    effectiveVersion,
    error,
    explainOpen,
    handleCancel,
    handleJsonChange,
    handleReview,
    handleSave,
    handleSpecChange,
    id,
    inputSchema,
    isActiveVersion,
    isDirty,
    isError,
    isFetching,
    isLoading,
    jsonInvalid,
    jsonParsed,
    lintErrorCount,
    lintErrors,
    mode,
    pendingErrorSpec,
    pendingShellSpec,
    pendingVersion,
    promoteBlocked,
    promoteOpen,
    promoteReason,
    promoteVariant,
    refetch,
    refineOpen,
    reviewVersion,
    saveError,
    selectedNeedsReview,
    selectedNodeId,
    setEditMetaOpen,
    setEditSchemaOpen,
    setExplainOpen,
    setMode,
    setPendingErrorSpec,
    setPendingShellSpec,
    setPendingVersion,
    setPromoteOpen,
    setRefineOpen,
    setSelectedNodeId,
    setSelectedVersion,
    stepRegistry,
    template,
    versionDetail,
    visualSpec,
  };
}
