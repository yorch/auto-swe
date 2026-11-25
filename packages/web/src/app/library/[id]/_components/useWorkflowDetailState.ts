import { isInputSchema } from '@auto-swe/shared/lib/inputSchema';
import type { StepMetadata, WorkflowSpec } from '@auto-swe/shared/workflow';
import {
  describeCostExclusions,
  estimateSpecCost,
  parseWorkflowSpec,
  validateSpec,
} from '@auto-swe/shared/workflow';
import { use, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  CONTAINER_AUTHORING_RULE,
  describeAuthoredCode,
} from '@/components/workflow/containerNodes';
import { useCanOwned, usePlatformAdmin } from '@/hooks/useCan';
import { useEffectivePermissions } from '@/hooks/useEffectivePermissions';
import { useEntityTitle } from '@/hooks/useEntityTitle';
import { useRolePricing } from '@/hooks/useModelCatalog';
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
import { validateRouteParam } from '@/lib/routeParams';
import { schemaIssues } from '@/lib/specSchemaIssues';
import { useAuthStore } from '@/stores/authStore';
import type { ViewMode } from './EditorActions';

/**
 * Where the message in the page's error banner came from, so its title says what failed:
 * a save the gateway refused for its content (`rejected`, also fed to the editor's issue list),
 * a save that failed for another reason (`save`), one stopped before the request (`blocked`), a
 * review (`review`), or a stored definition that does not parse (`spec`).
 */
/** Why the review button is disabled for the person who generated the open version. */
export const REVIEW_BY_OTHER_REASON =
  'Someone other than the person who generated this version must review it';

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
  // Every write here (new version, promote, review, refine, metadata, webhook) is
  // `team.templates.write` on the template's owning team; a GLOBAL template belongs to the
  // platform, so only a platform admin writes it. Anyone else gets a read-only view.
  const canManage = useCanOwned('team.templates.write', template?.team?.id);
  // Container code and authored commands take `team.templates.shell.author` on top. Null while
  // the permissions load: the save then asks the gateway.
  const permissionsReady = useEffectivePermissions().data !== undefined;
  const canAuthorShell = useCanOwned('team.templates.shell.author', template?.team?.id);
  const canAuthorCode = permissionsReady ? canAuthorShell : null;

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
  // Serialized once per change, not on every render: the whole spec is stringified for the
  // comparison and a large one is rendered on each keystroke.
  const editorSpecJson = useMemo(
    () => (mode === 'edit' && editorSpec !== null ? JSON.stringify(editorSpec) : null),
    [mode, editorSpec]
  );
  const baselinePrettyJson = useMemo(
    () => (mode === 'json' && versionDetail ? JSON.stringify(versionDetail.spec, null, 2) : null),
    [mode, versionDetail]
  );
  const isDirty =
    (editorSpecJson !== null && baselineSpecJson !== null && editorSpecJson !== baselineSpecJson) ||
    (baselinePrettyJson !== null && editorJson !== baselinePrettyJson);

  // Reload, close, an outside link and any in-app link click ask before losing the draft.
  useUnsavedChangesGuard(isDirty);

  // The handler and this memo parse the same text; remember the last parse so each
  // keystroke in the JSON view costs one JSON.parse plus schema check, not two.
  const lastParse = useRef<{ text: string; result: ReturnType<typeof tryParseSpec> } | null>(null);
  const parseSpecText = useCallback((text: string) => {
    if (lastParse.current?.text !== text) {
      lastParse.current = { result: tryParseSpec(text), text };
    }
    return lastParse.current.result;
  }, []);
  const jsonParsed = useMemo(
    () => (mode === 'json' && editorJson ? parseSpecText(editorJson) : null),
    [mode, editorJson, parseSpecText]
  );
  const visualSpec: WorkflowSpec | null =
    mode === 'json' ? (jsonParsed?.ok ? jsonParsed.spec : null) : editorSpec;

  // The selected version's own lint, dirty or not: a draft saved with errors keeps them, and
  // promoting or activating it stays blocked until they are fixed.
  // Synchronous on purpose: this gates promote and activate, so it must never describe an
  // earlier spec than the one on screen.
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
  // The estimate is informational, so it trails the keystroke rather than blocking it.
  const deferredSpec = useDeferredValue(visualSpec);
  const costSpec = visualSpec ? deferredSpec : null;
  const costEstimate = useMemo(() => {
    if (!costSpec || !stepRegistryByName) {
      return null;
    }
    return estimateSpecCost(costSpec, {
      pricing: rolePrices ? estimatorPricing(rolePrices) : undefined,
      stepLookup: (name) => stepRegistryByName.get(name),
    });
  }, [costSpec, stepRegistryByName, rolePrices]);

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

  // The gateway refuses a generated version's review by the person who generated it, unless
  // that person is a platform admin; say so up front instead of after the click.
  const reviewerSub = useAuthStore((s) => s.user?.sub ?? null);
  const isPlatformAdmin = usePlatformAdmin();
  const reviewBlockedReason =
    selectedNeedsReview &&
    reviewerSub !== null &&
    versionDetail?.createdBy === reviewerSub &&
    !isPlatformAdmin
      ? REVIEW_BY_OTHER_REASON
      : null;

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
    const parsed = parseSpecText(text);
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
    reviewBlockedReason,
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
