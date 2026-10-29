'use client';

import type { StepMetadata } from '@auto-swe/shared/workflow';
import { Alert } from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonDetail } from '@/components/ui/LoadingState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Textarea } from '@/components/ui/Textarea';
import {
  CONTAINER_AUTHORING_RULE,
  describeAuthoredCode,
} from '@/components/workflow/containerNodes';
import { PromoteVersionModal } from '@/components/workflow/PromoteVersionModal';
import { RefineChatPanel } from '@/components/workflow/RefineChatPanel';
import { TemplateEditor } from '@/components/workflow/TemplateEditor';
import { TemplateNotFound, TemplateSubNav } from '@/components/workflow/templateNav';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
import { cn } from '@/lib/utils';
import { EditMetadataModal } from './_components/EditMetadataModal';
import { EditorActions } from './_components/EditorActions';
import { EditSchemaModal } from './_components/EditSchemaModal';
import { ExperimentCard } from './_components/ExperimentCard';
import { ExplainModal } from './_components/ExplainModal';
import { LaunchInputsCard } from './_components/LaunchInputsCard';
import { LintErrorsAlert } from './_components/LintErrorsAlert';
import { ObservedCard } from './_components/ObservedCard';
import { TemplateHeader } from './_components/TemplateHeader';
import { useWorkflowDetailState } from './_components/useWorkflowDetailState';
import { VersionsCard } from './_components/VersionsCard';
import { WebhookCard } from './_components/WebhookCard';

interface PageProps {
  params: Promise<{ id: string }>;
}

/** The shell gives a full-screen route no padding or scroll; the states without an editor want both. */
function PagePad({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-4 pt-6 pb-16 md:px-10 md:pt-10">{children}</div>
    </div>
  );
}

export default function TemplateDetailPage({ params }: PageProps) {
  const {
    analytics,
    canManage,
    canPromote,
    commitSave,
    continueSave,
    costEstimate,
    costExclusions,
    createVersion,
    editMetaOpen,
    editSchemaOpen,
    editorJson,
    editorSpec,
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
  } = useWorkflowDetailState(params);

  if (!id) {
    return (
      <PagePad>
        <TemplateNotFound />
      </PagePad>
    );
  }
  // Before the not-found branch, so a 403 or 500 is not reported as "not found".
  if (isLoading || isError) {
    return (
      <PagePad>
        <QueryBoundary
          error={error}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="workflow"
          onRetry={() => void refetch()}
          shape="detail"
        />
      </PagePad>
    );
  }
  if (!template) {
    return (
      <PagePad>
        <TemplateNotFound />
      </PagePad>
    );
  }

  const editorActions = (
    <EditorActions
      canManage={canManage}
      canPromote={canPromote}
      isActiveVersion={isActiveVersion}
      isDirty={isDirty}
      jsonInvalid={jsonInvalid}
      mode={mode}
      onCancel={handleCancel}
      onPromote={() => setPromoteOpen(true)}
      onReview={handleReview}
      onSave={handleSave}
      promoteBlocked={promoteBlocked}
      promoteReason={promoteReason}
      promoteVariant={promoteVariant}
      reviewPending={reviewVersion.isPending}
      savePending={createVersion.isPending}
      selectedNeedsReview={selectedNeedsReview}
      setMode={setMode}
    />
  );

  return (
    // Full-screen route (see `isFullscreenRoute`): this root owns the scrolling. In edit mode the
    // editor takes the height left under the header from `md` up; below `md` the whole page scrolls
    // and the editor keeps a 560px canvas, because a phone cannot fit canvas, rails and header at once.
    <div
      className={cn(
        'flex h-full flex-col overflow-y-auto overflow-x-hidden',
        mode === 'edit' && 'md:overflow-hidden'
      )}
    >
      <div
        className={cn(
          'mx-auto w-full max-w-[1280px] shrink-0 space-y-6 px-4 pt-6 md:px-10 md:pt-10',
          mode === 'edit' ? 'pb-4' : 'pb-6'
        )}
      >
        <ExplainModal
          activeVersion={template.activeVersion}
          onClose={() => setExplainOpen(false)}
          open={explainOpen}
          templateId={id}
        />

        <RefineChatPanel onClose={() => setRefineOpen(false)} open={refineOpen} templateId={id} />

        <TemplateHeader
          canManage={canManage}
          onEditDetails={() => setEditMetaOpen(true)}
          onEditInputs={() => setEditSchemaOpen(true)}
          onExplain={() => setExplainOpen(true)}
          onRefine={() => setRefineOpen(true)}
          template={template}
        />

        <TemplateSubNav active="editor" templateId={id} />

        <p className="max-w-3xl text-sm leading-relaxed text-paper-400" id="versioning-note">
          Saving creates a new immutable version; it never edits an old one, and runs already in
          flight stay on the version they started with.{' '}
          <strong className="text-paper-200">Draft</strong> means the template cannot be launched
          yet. <strong className="text-paper-200">Active</strong> means it can be launched, using
          its active version. <strong className="text-paper-200">Promote</strong> makes a version
          the active one, so new runs use it.
        </p>

        {saveError && mode !== 'edit' && (
          <Alert className="whitespace-pre-line" title="Could not save">
            {saveError}
          </Alert>
        )}

        {/* The visual editor lists its own lint; every other mode shows it here. */}
        {mode !== 'edit' && lintErrors.length > 0 && <LintErrorsAlert lintErrors={lintErrors} />}
      </div>

      {/* Edit mode: full-bleed canvas */}
      {mode === 'edit' && editorSpec && stepRegistry && (
        <div className="flex min-h-0 flex-col md:flex-1">
          <TemplateEditor
            actions={editorActions}
            baseVersion={effectiveVersion ?? undefined}
            costEstimateExclusions={costExclusions}
            costEstimateUsd={costEstimate?.totalUsd}
            observedCostUsd={analytics?.avgCostPerRun ?? null}
            onChange={handleSpecChange}
            onSelect={setSelectedNodeId}
            parseError={null}
            selectedNodeId={selectedNodeId}
            serverError={saveError}
            spec={editorSpec}
            stepRegistry={stepRegistry as StepMetadata[]}
            teamId={template?.team?.id}
            templateId={id}
          />
        </div>
      )}

      {/* View / JSON mode with versions + analytics rail */}
      {mode !== 'edit' && (
        <div className="mx-auto grid w-full max-w-[1280px] grid-cols-1 gap-6 px-4 pb-16 md:px-10 lg:grid-cols-[minmax(0,1fr)_300px]">
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
                  <span className="text-sm text-paper-500 tabular-nums">
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
                  <SkeletonDetail label="the definition" />
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
            <VersionsCard
              effectiveVersion={effectiveVersion}
              isDirty={isDirty}
              onAskDiscard={setPendingVersion}
              onSelectVersion={setSelectedVersion}
              template={template}
            />

            {/* Observed analytics summary */}
            {analytics && analytics.totalRuns > 0 && (
              <ObservedCard
                analytics={analytics}
                estimatedHumanTimeSavedMinutes={template.estimatedHumanTimeSavedMinutes}
                templateId={id}
              />
            )}

            {/* Run schema */}
            <LaunchInputsCard
              canManage={canManage}
              inputSchema={inputSchema}
              onEdit={() => setEditSchemaOpen(true)}
            />

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
        message={`This workflow has ${lintErrorCount} error${lintErrorCount === 1 ? '' : 's'}. It is saved as an inactive draft: nothing runs it, and it cannot be promoted, activated or used in an experiment until the errors are fixed. The server refuses a save whose structure is broken, such as a blank title or an empty agent reference, until that is fixed.`}
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
        confirmLabel="Save with authored code"
        message={`${describeAuthoredCode(pendingShellSpec)} Shell and container steps run in an isolated container; a step's own command runs in the run's workspace. Each is recorded in the shell audit log. ${CONTAINER_AUTHORING_RULE}`}
        onClose={() => setPendingShellSpec(null)}
        onConfirm={() => {
          if (pendingShellSpec) {
            void commitSave(pendingShellSpec);
          }
        }}
        open={pendingShellSpec !== null}
        title="Authored code detected"
      />
    </div>
  );
}
