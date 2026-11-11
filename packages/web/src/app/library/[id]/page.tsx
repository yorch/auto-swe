'use client';

import type { StepMetadata } from '@auto-swe/shared/workflow';
import { useState } from 'react';
import { PageHelp } from '@/components/help/PageHelp';
import { KnowledgeBaseLinksPanel } from '@/components/knowledgeBases/KnowledgeBaseLinksSection';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonDetail } from '@/components/ui/LoadingState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import {
  CONTAINER_AUTHORING_RULE,
  describeAuthoredCode,
} from '@/components/workflow/containerNodes';
import { PromoteVersionModal } from '@/components/workflow/PromoteVersionModal';
import { RefineChatPanel } from '@/components/workflow/RefineChatPanel';
import { TemplateEditor } from '@/components/workflow/TemplateEditor';
import { TemplateNotFound, TemplateSubNav } from '@/components/workflow/templateNav';
import { WorkflowViewer } from '@/components/workflow/WorkflowViewer';
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
import { TriggersCard } from './_components/TriggersCard';
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
  const [section, setSection] = useState('definition');
  const {
    analytics,
    baseVersion,
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
    noteOwnVersion,
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 space-y-2 border-b border-ink-600 px-4 py-3 md:px-6">
        <ExplainModal
          activeVersion={template.activeVersion}
          onClose={() => setExplainOpen(false)}
          open={explainOpen}
          templateId={id}
        />

        <RefineChatPanel
          onClose={() => setRefineOpen(false)}
          onSaved={noteOwnVersion}
          onViewVersion={(v) => {
            setMode('view');
            setSelectedVersion(v);
          }}
          open={refineOpen}
          templateId={id}
        />

        <TemplateHeader
          canManage={canManage}
          compact
          onEditDetails={() => setEditMetaOpen(true)}
          onEditInputs={() => setEditSchemaOpen(true)}
          onExplain={() => setExplainOpen(true)}
          onRefine={() => setRefineOpen(true)}
          refineBlockedReason={
            isDirty
              ? 'Save or cancel your unsaved edits first: refining works on the last saved version.'
              : null
          }
          template={template}
        />

        <nav aria-label="Workflow workspace" className="flex flex-wrap items-center gap-2">
          {['definition', 'settings', 'versions'].map((tab) => (
            <Button
              aria-pressed={section === tab}
              key={tab}
              onClick={() => setSection(tab)}
              size="sm"
              variant={section === tab ? 'secondary' : 'ghost'}
            >
              {tab === 'definition' ? 'Definition' : tab === 'settings' ? 'Settings' : 'Versions'}
            </Button>
          ))}
          <div className="ml-auto min-w-0 max-w-[180px]">
            <Select
              aria-label="Viewed version"
              compact
              onChange={(v) => {
                if (isDirty) {
                  setPendingVersion(Number(v));
                } else {
                  setMode('view');
                  setSelectedVersion(Number(v));
                }
              }}
              options={template.versions.map((v) => ({
                label: `v${v.version}${v.version === template.activeVersion ? ' · active' : ' · saved'}`,
                value: String(v.version),
              }))}
              value={String(effectiveVersion ?? '')}
            />
          </div>
          <span className="text-xs text-paper-500">
            {isDirty ? 'Unsaved changes' : mode === 'edit' ? 'Editing draft' : 'Read only'}
          </span>
        </nav>
        <PageHelp>
          <p>
            Saving creates a new immutable version. Promote changes the active version used by new
            runs; in-flight runs keep their launch version. Draft workflows cannot be launched. Node
            selection is available in read-only mode.
          </p>
        </PageHelp>
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
        <div
          className={cn('min-h-0 flex-1 flex-col', section === 'definition' ? 'flex' : 'hidden')}
        >
          <TemplateEditor
            actions={editorActions}
            baseVersion={baseVersion}
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

      {mode !== 'edit' && (
        <section
          className={cn('min-h-0 flex-1 flex-col', section === 'definition' ? 'flex' : 'hidden')}
        >
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-2">
            <h2 className="text-sm font-semibold text-paper-100">
              {mode === 'json' ? 'Raw JSON' : 'Definition'}{' '}
              <span className="ml-2 font-normal text-paper-500">
                v{effectiveVersion}
                {isActiveVersion ? ' · active' : ' · not active'}
              </span>
            </h2>
            <div className="flex flex-wrap items-center gap-2">{editorActions}</div>
          </div>
          {mode === 'view' && visualSpec && (
            <WorkflowViewer
              onSelect={setSelectedNodeId}
              selectedNodeId={selectedNodeId}
              spec={visualSpec}
            />
          )}
          {mode === 'view' && !visualSpec && (
            <Card variant="inset">
              {versionDetail ? (
                <EmptyState
                  hint="Switch to JSON to inspect the stored definition."
                  icon="warning"
                  title="This version cannot be drawn"
                />
              ) : (
                <SkeletonDetail label="the definition" />
              )}
            </Card>
          )}
          {mode === 'json' && (
            <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
              {jsonParsed?.ok === false && (
                <div id="spec-json-error">
                  <Alert title="The JSON does not parse">{jsonParsed.error}</Alert>
                </div>
              )}
              <Textarea
                aria-describedby={jsonParsed?.ok === false ? 'spec-json-error' : undefined}
                aria-invalid={jsonParsed?.ok === false ? true : undefined}
                aria-label="Raw JSON"
                className="h-full min-h-64 p-4 font-mono text-xs leading-relaxed"
                compact
                id="spec-json"
                onChange={(e) => handleJsonChange(e.target.value)}
                readOnly={!canManage}
                spellCheck={false}
                value={editorJson}
              />
            </div>
          )}
        </section>
      )}
      {section !== 'definition' && (
        <section
          aria-label={section === 'settings' ? 'Workflow settings' : 'Workflow versions'}
          className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6"
        >
          <div className="mb-5">
            <TemplateSubNav active="editor" templateId={id} />
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {section === 'versions' ? (
              <div>
                {' '}
                <VersionsCard
                  effectiveVersion={effectiveVersion}
                  isDirty={isDirty}
                  onAskDiscard={setPendingVersion}
                  onSelectVersion={setSelectedVersion}
                  template={template}
                />
              </div>
            ) : (
              <>
                <KnowledgeBaseLinksPanel
                  canManage={canManage}
                  global={!template.team}
                  target={{ scope: 'TEMPLATE', templateId: id }}
                  teamId={template.team?.id}
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

                {/* What starts this template */}
                <TriggersCard
                  template={{
                    id: template.id,
                    name: template.name,
                    status: template.status,
                    team: template.team,
                  }}
                  webhookConfigured={template.webhookConfigured}
                />

                {/* Webhook trigger */}
                <WebhookCard canManage={canManage} template={template} />
              </>
            )}
          </div>
        </section>
      )}

      <EditMetadataModal
        initialDescription={template.description ?? ''}
        initialEstimatedHumanTimeSavedMinutes={template.estimatedHumanTimeSavedMinutes ?? null}
        initialKind={template.kind}
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
