import { isInputSchema } from '@auto-swe/shared/lib/inputSchema';
import type { StepMetadata, WorkflowSpec } from '@auto-swe/shared/workflow';
import {
  describeCostExclusions,
  estimateSpecCost,
  parseWorkflowSpec,
  validateSpec,
} from '@auto-swe/shared/workflow';
import { use, useCallback, useEffect, useMemo, useState } from 'react';
import {
  CONTAINER_AUTHORING_RULE,
  describeAuthoredCode,
} from '@/components/workflow/containerNodes';
import { useEntityTitle } from '@/hooks/useEntityTitle';
import { useRolePricing } from '@/hooks/useModelCatalog';
import { useAdminTeamIds, useLedTeamIds } from '@/hooks/useTeams';
import {
  useCreateWorkflowVersion,
  useReviewWorkflowVersion,
  useStepRegistry,
  useWorkflowTemplate,
  useWorkflowTemplateAnalytics,
  useWorkflowTemplateVersion,
} from '@/hooks/useTemplates';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { ApiError } from '@/lib/api';
import { errMsg } from '@/lib/errors';
import { estimatorPricing } from '@/lib/modelCatalog';
import { hasRole } from '@/lib/roles';
import { validateRouteParam } from '@/lib/routeParams';
import { schemaIssues } from '@/lib/specSchemaIssues';
import { canAuthorTeamCode, canWriteTeamResource } from '@/lib/teamPermissions';
import { useAuthStore } from '@/stores/authStore';
import type { ViewMode } from './EditorActions';

/**
 * Where the message in the page's error banner came from, so its title says what failed:
 * a save the gateway refused for its content (`rejected`, also fed to the editor's issue list),
 * a save that failed for another reason (`save`), one stopped before the request (`blocked`), a
 * review (`review`), or a stored definition that does not parse (`spec`).
 */
export type ActionErrorSource = 'blocked' | 'rejected' | 'review' | 'save' | 'spec';

export const ACTION_ERROR_TITLES: Record<ActionErrorSource, string> = {
  blocked: 'Cannot save',
  rejected: 'Save rejected',
  review: 'Could not approve this version',
  save: 'Could not save',
  spec: 'This version’s definition could not be read',
};

/** The gateway answers a spec it will not store with a 4xx validation status. */
function isRejection(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 400 || err.status === 422);
}

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
  useEntityTitle(template?.name);
  const [selectedVersion, setSelectedVersionRaw] = useState<number | null>(null);
  // Advisory notes the gateway attached to the version this page just saved.
  const [saveWarnings, setSaveWarnings] = useState<string[]>([]);
  // Notes belong to the version on screen: viewing another one drops them.
  const setSelectedVersion = useCallback((version: number | null) => {
    setSaveWarnings([]);
    setSelectedVersionRaw(version);
  }, []);
  const effectiveVersion = selectedVersion ?? template?.activeVersion ?? null;
  // The newest version this page knew of when it loaded the template. The server check compares it
  // with the template's newest version, so it reports versions saved since (another tab, another
  // person) and not drafts that were already above the active version, nor an old version the
  // author opened on purpose. Versions this page saves itself (a save, a refine) are folded in.
  const [loadedLatest, setLoadedLatest] = useState<{ id: string; latest: number } | null>(null);
  const templateLatest = template
    ? template.versions.reduce((max, v) => Math.max(max, v.version), 0)
    : null;
  useEffect(() => {
    if (id && templateLatest !== null && loadedLatest?.id !== id) {
      setLoadedLatest({ id, latest: templateLatest });
    }
  }, [id, templateLatest, loadedLatest]);
  const noteOwnVersion = useCallback(
    (version: number) =>
      setLoadedLatest((prev) =>
        prev && prev.id === id ? { ...prev, latest: Math.max(prev.latest, version) } : prev
      ),
    [id]
  );
  const baseVersion = loadedLatest && loadedLatest.id === id ? loadedLatest.latest : undefined;
  const {
    data: versionDetail,
    error: versionError,
    isError: versionIsError,
    isFetching: versionFetching,
    refetch: refetchVersion,
  } = useWorkflowTemplateVersion(id ?? '', effectiveVersion);
  const {
    data: stepRegistry,
    error: stepRegistryError,
    isError: stepRegistryIsError,
    isFetching: stepRegistryFetching,
    refetch: refetchStepRegistry,
  } = useStepRegistry();
  // Only the cost figure on the settings tab reads this, so it is not polled.
  const { data: analytics } = useWorkflowTemplateAnalytics(id ?? '', 30, { poll: false });
  const createVersion = useCreateWorkflowVersion(id ?? '');
  const reviewVersion = useReviewWorkflowVersion(id ?? '');
  // Every write here (new version, promote, review, refine, metadata, webhook)
  // asks the platform role for nothing beyond ENGINEER and requires LEAD
  // membership on the template's owning team (templateWriteFilter) — a GLOBAL
  // template is ADMIN-only. Anyone else gets a read-only view.
  const platformRole = useAuthStore((s) => s.user?.role);
  const ledTeamIds = useLedTeamIds();
  const canManage = canWriteTeamResource(platformRole, template?.team?.id, ledTeamIds);
  // Container code and authored commands take a team ADMIN on top (the gateway's
  // `workflow:write:shell`). Null while the memberships load: the save then asks the gateway.
  const adminTeamIds = useAdminTeamIds();
  const canAuthorCode =
    adminTeamIds === null && !hasRole(platformRole, 'ADMIN')
      ? null
      : canAuthorTeamCode(platformRole, template?.team?.id, adminTeamIds);

  const [mode, setMode] = useState<ViewMode>('view');
  const [editorSpec, setEditorSpec] = useState<WorkflowSpec | null>(null);
  const [editorJson, setEditorJson] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    source: ActionErrorSource;
    message: string;
  } | null>(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
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
        setActionError(null);
      } catch (err) {
        setEditorSpec(null);
        setActionError({ message: formatSpecError(err), source: 'spec' });
      }
      setEditorJson(JSON.stringify(versionDetail.spec, null, 2));
    } else {
      // A newly selected version has not loaded (or failed): never show the previous one's graph.
      setEditorSpec(null);
      setEditorJson('');
    }
  }, [versionDetail]);

  // Dirty means the draft differs from the version on screen. Opening Edit alone is not an edit,
  // so it arms no prompt and offers nothing to discard.
  const baselineSpecJson = useMemo(() => {
    if (!versionDetail) {
      return null;
    }
    try {
      return JSON.stringify(parseWorkflowSpec(versionDetail.spec));
    } catch {
      return JSON.stringify(versionDetail.spec);
    }
  }, [versionDetail]);
  const isDirty =
    (mode === 'edit' &&
      editorSpec !== null &&
      baselineSpecJson !== null &&
      JSON.stringify(editorSpec) !== baselineSpecJson) ||
    (mode === 'json' &&
      versionDetail !== undefined &&
      editorJson !== JSON.stringify(versionDetail.spec, null, 2));

  // Reload, close, an outside link and any in-app link click ask before losing the draft.
  useUnsavedChangesGuard(isDirty);

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

  // The estimate's caveat (container runtime, external calls, unpriced steps,
  // retries) travels with the number, so a partial sum never reads as the whole
  // cost. `visualSpec` is the not-yet-parsed canvas spec, so an unparseable
  // draft simply has no estimate to qualify.
  const costExclusions = useMemo(
    () => (costEstimate ? describeCostExclusions(costEstimate) : null),
    [costEstimate]
  );

  const commitSave = async (spec: WorkflowSpec) => {
    try {
      const result = await createVersion.mutateAsync(spec);
      noteOwnVersion(result.data.version);
      setSelectedVersionRaw(result.data.version);
      setMode('view');
      setActionError(null);
      setSaveWarnings(result.warnings ?? []);
    } catch (err) {
      setSaveWarnings([]);
      setActionError({
        message: errMsg(err, 'save failed'),
        source: isRejection(err) ? 'rejected' : 'save',
      });
    }
  };

  const continueSave = async (specToSave: WorkflowSpec) => {
    const authoredCode = describeAuthoredCode(specToSave);
    if (authoredCode) {
      // Say so before the round trip when the gateway would refuse the save: it refuses a
      // version holding authored code, including code an admin wrote into an earlier version.
      if (canAuthorCode === false) {
        setActionError({
          message: `${authoredCode} ${CONTAINER_AUTHORING_RULE}`,
          source: 'blocked',
        });
        return;
      }
      setPendingShellSpec(specToSave);
      return;
    }
    await commitSave(specToSave);
  };

  const handleSave = async () => {
    const specToSave = mode === 'json' ? (jsonParsed?.ok ? jsonParsed.spec : null) : editorSpec;
    if (!specToSave) {
      setActionError({
        message: jsonParsed?.ok === false ? jsonParsed.error : 'no spec to save',
        source: 'blocked',
      });
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
    setActionError(null);
    setSaveWarnings([]);
    if (versionDetail) {
      try {
        setEditorSpec(parseWorkflowSpec(versionDetail.spec));
      } catch (err) {
        setEditorSpec(null);
        setActionError({ message: formatSpecError(err), source: 'spec' });
      }
      setEditorJson(JSON.stringify(versionDetail.spec, null, 2));
    }
    setMode('view');
  };

  // Cancel throws the draft away, so it asks first when there is one.
  const requestCancel = () => {
    if (isDirty) {
      setCancelConfirmOpen(true);
    } else {
      handleCancel();
    }
  };

  const handleReview = async () => {
    if (effectiveVersion === null) {
      return;
    }
    try {
      await reviewVersion.mutateAsync(effectiveVersion);
      setActionError(null);
      // A draft's only version has nothing else to promote, so approving it
      // leads straight to activating it.
      if (template?.status === 'DRAFT' && effectiveVersion === template.activeVersion) {
        setPromoteOpen(true);
      }
    } catch (err) {
      setActionError({ message: errMsg(err, 'review failed'), source: 'review' });
    }
  };

  const selectedNeedsReview =
    canManage &&
    effectiveVersion !== null &&
    (effectiveVersion !== template?.activeVersion || template?.status === 'DRAFT') &&
    versionDetail?.generatedBy != null &&
    versionDetail?.reviewedAt == null;

  // An edit makes the last save's error and notes stale; a stored-spec parse error stays.
  const clearStaleSaveFeedback = () => {
    setActionError((prev) => (prev?.source === 'spec' ? prev : null));
    setSaveWarnings([]);
  };

  const handleSpecChange = (next: WorkflowSpec) => {
    clearStaleSaveFeedback();
    setEditorSpec(next);
    setEditorJson(JSON.stringify(next, null, 2));
    if (mode !== 'edit') {
      setMode('edit');
    }
  };

  const handleJsonChange = (text: string) => {
    clearStaleSaveFeedback();
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
    mode !== 'edit' &&
    canManage &&
    effectiveVersion !== null &&
    (effectiveVersion !== template?.activeVersion || template?.status === 'DRAFT');
  // The header already offers Run on an active workflow, so promotion there is secondary.
  const promoteVariant =
    template?.status === 'ACTIVE' ? ('secondary' as const) : ('primary' as const);
  const isActiveVersion = effectiveVersion === template?.activeVersion;

  // The editor lists the gateway's refusal as issues; every other failure shows in the banner only.
  const saveError = actionError?.source === 'rejected' ? actionError.message : null;

  const templateInputSchema = template?.inputSchema;
  const inputSchema = isInputSchema(templateInputSchema) ? templateInputSchema : null;

  return {
    actionError,
    analytics,
    baseVersion,
    cancelConfirmOpen,
    canManage,
    canPromote,
    commitSave,
    continueSave,
    costEstimate,
    costExclusions,
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
    noteOwnVersion,
    pendingErrorSpec,
    pendingShellSpec,
    pendingVersion,
    promoteBlocked,
    promoteOpen,
    promoteReason,
    promoteVariant,
    refetch,
    refetchStepRegistry,
    refetchVersion,
    refineOpen,
    requestCancel,
    reviewVersion,
    saveError,
    saveWarnings,
    selectedNeedsReview,
    selectedNodeId,
    setCancelConfirmOpen,
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
    stepRegistryError,
    stepRegistryFetching,
    stepRegistryIsError,
    template,
    versionDetail,
    versionError,
    versionFetching,
    versionIsError,
    visualSpec,
  };
}
