'use client';

import type { StepMetadata } from '@auto-swe/shared/workflow';
import { useState } from 'react';
import { PageHelp } from '@/components/help/PageHelp';
import { KnowledgeBaseLinksPanel } from '@/components/knowledgeBases/KnowledgeBaseLinksSection';
import { PAGE_CONTAINER_CLASS } from '@/components/layout/PageContainer';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonDetail } from '@/components/ui/LoadingState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { Textarea } from '@/components/ui/Textarea';
import {
  CONTAINER_AUTHORING_RULE,
  describeAuthoredCode,
} from '@/components/workflow/containerNodes';
import { PromoteVersionModal } from '@/components/workflow/PromoteVersionModal';
import { RefineChatPanel } from '@/components/workflow/RefineChatPanel';
import { TemplateEditor } from '@/components/workflow/TemplateEditor';
import { TemplateNotFound } from '@/components/workflow/templateNav';
import { WorkflowViewer } from '@/components/workflow/WorkflowViewer';
import { errMsg } from '@/lib/errors';
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
import { ACTION_ERROR_TITLES, useWorkflowDetailState } from './_components/useWorkflowDetailState';
import { VersionsCard } from './_components/VersionsCard';
import { WebhookCard } from './_components/WebhookCard';

interface PageProps {
  params: Promise<{ id: string }>;
}

type Section = 'definition' | 'settings' | 'versions';

const SECTION_TABS: { id: Section; label: string }[] = [
  { id: 'definition', label: 'Definition' },
  { id: 'settings', label: 'Settings' },
  { id: 'versions', label: 'Versions' },
];

const TABS_ID = 'workflow-workspace';

/** The shell gives a full-screen route no padding or scroll; the states without an editor want both. */
function PagePad({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={PAGE_CONTAINER_CLASS}>{children}</div>
    </div>
  );
}

export default function TemplateDetailPage({ params }: PageProps) {
  const [section, setSection] = useState<Section>('definition');
  // Settings and Versions mount on first visit (their queries fire then), and stay mounted after:
  // a webhook token or secret shown once lives in Settings.
  const [visited, setVisited] = useState<ReadonlySet<Section>>(new Set<Section>(['definition']));
  const {
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
    refetchStepRegistry,
    refetchVersion,
    refineOpen,
    requestCancel,
    reviewVersion,
    saveError,
    saveWarnings,
    reviewBlockedReason,
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
      onCancel={requestCancel}
      onPromote={() => setPromoteOpen(true)}
      onReview={handleReview}
      onSave={handleSave}
      promoteBlocked={promoteBlocked}
      promoteReason={promoteReason}
      promoteVariant={promoteVariant}
      reviewBlockedReason={reviewBlockedReason}
      reviewPending={reviewVersion.isPending}
      savePending={createVersion.isPending}
      selectedNeedsReview={selectedNeedsReview}
      setMode={setMode}
    />
  );

  // Stands in for the definition while the selected version loads, or says why it did not.
  const versionPlaceholder =
    effectiveVersion === null ? (
      <EmptyState icon="warning" title="This workflow has no version yet." />
    ) : versionIsError ? (
      <Alert
        action={
          <Button disabled={versionFetching} onClick={() => void refetchVersion()} size="sm">
            {versionFetching ? 'Retrying…' : 'Retry'}
          </Button>
        }
        title={`Could not load v${effectiveVersion}`}
      >
        {errMsg(versionError, 'request failed')}
      </Alert>
    ) : (
      <SkeletonDetail label="the definition" />
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

        <div className="flex flex-wrap items-center gap-2">
          <TabBar
            active={section}
            ariaLabel="Workflow workspace"
            idPrefix={TABS_ID}
            onChange={(next) => {
              setSection(next);
              setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
            }}
            tabs={SECTION_TABS}
          />
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
          <span className="text-xs text-paper-500" role="status">
            {isDirty
              ? 'Unsaved changes'
              : mode === 'edit' || (mode === 'json' && canManage)
                ? `Editing v${effectiveVersion} — saves as a new version`
                : template.team
                  ? `Read only: leads and admins of ${template.team.name} edit this workflow`
                  : 'Read only: platform admins edit global workflows'}
          </span>
          <nav aria-label="Workflow reports" className="flex flex-wrap items-center gap-1">
            <ButtonLink href={`/library/${id}/analytics`} size="sm" variant="ghost">
              Analytics
            </ButtonLink>
            <ButtonLink href={`/library/${id}/runs`} size="sm" variant="ghost">
              Run history
            </ButtonLink>
            <ButtonLink href={`/library/${id}/diff`} size="sm" variant="ghost">
              Compare versions
            </ButtonLink>
          </nav>
        </div>
        <PageHelp>
          <p>
            Saving creates a new immutable version. Promote changes the active version used by new
            runs; in-flight runs keep their launch version. Draft workflows cannot be launched. Node
            selection is available in read-only mode.
          </p>
        </PageHelp>
        {/* The visual editor lists a refused save as its own issues; everything else shows here. */}
        {actionError && !(mode === 'edit' && actionError.source === 'rejected') && (
          <Alert className="whitespace-pre-line" title={ACTION_ERROR_TITLES[actionError.source]}>
            {actionError.message}
          </Alert>
        )}
        {saveWarnings.length > 0 && (
          <Alert title="Saved with warnings" variant="warning">
            <ul className="list-disc space-y-0.5 pl-4 text-xs">
              {saveWarnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Alert>
        )}

        {/* The visual editor lists its own lint; every other mode shows it here. */}
        {mode !== 'edit' && lintErrors.length > 0 && <LintErrorsAlert lintErrors={lintErrors} />}
      </div>

      <div
        {...tabPanelProps(TABS_ID, 'definition')}
        className={cn('min-h-0 flex-1 flex-col', section === 'definition' ? 'flex' : 'hidden')}
      >
        {/* Edit mode: full-bleed canvas */}
        {mode === 'edit' &&
          (editorSpec && stepRegistry ? (
            <div className="flex min-h-0 flex-1 flex-col">
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
          ) : (
            <div className="space-y-3 px-4 py-2">
              <div className="flex flex-wrap items-center gap-2">{editorActions}</div>
              {!editorSpec ? (
                versionDetail ? (
                  <EmptyState
                    hint="Its stored definition does not parse. Cancel, then switch to JSON to inspect it."
                    icon="warning"
                    title="This version cannot be edited visually"
                  />
                ) : (
                  versionPlaceholder
                )
              ) : stepRegistryIsError ? (
                <Alert
                  action={
                    <Button
                      disabled={stepRegistryFetching}
                      onClick={() => void refetchStepRegistry()}
                      size="sm"
                    >
                      {stepRegistryFetching ? 'Retrying…' : 'Retry'}
                    </Button>
                  }
                  title="Could not load the step catalog"
                >
                  {errMsg(stepRegistryError, 'request failed')}
                </Alert>
              ) : (
                <SkeletonDetail label="the step catalog" />
              )}
            </div>
          ))}

        {mode !== 'edit' && (
          <section className="flex min-h-0 flex-1 flex-col">
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
            {mode === 'view' && visualSpec && versionDetail && (
              <WorkflowViewer
                onSelect={setSelectedNodeId}
                selectedNodeId={selectedNodeId}
                spec={visualSpec}
              />
            )}
            {mode === 'view' && !(visualSpec && versionDetail) && (
              <Card variant="inset">
                {versionDetail ? (
                  <EmptyState
                    hint="Switch to JSON to inspect the stored definition."
                    icon="warning"
                    title="This version cannot be drawn"
                  />
                ) : (
                  versionPlaceholder
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
      </div>

      {/* Kept mounted while another tab shows: a webhook token or secret shown once lives here. */}
      <div
        {...tabPanelProps(TABS_ID, 'settings')}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto p-4 md:p-6',
          section !== 'settings' && 'hidden'
        )}
      >
        {visited.has('settings') && (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Card variant="inset">
              <h2 className="mb-2 text-sm font-semibold text-paper-100">Description</h2>
              <p className="whitespace-pre-wrap break-words text-sm text-paper-400">
                {template.description || 'No description provided.'}
              </p>
            </Card>
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
                key={`${template.activeVersion}-${template.experimentVersion}-${template.experimentSplit}`}
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
              webhookSigned={template.webhookSigning.configured}
            />

            {/* Webhook trigger */}
            <WebhookCard canManage={canManage} template={template} />
          </div>
        )}
      </div>

      <div
        {...tabPanelProps(TABS_ID, 'versions')}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto p-4 md:p-6',
          section !== 'versions' && 'hidden'
        )}
      >
        {visited.has('versions') && (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <VersionsCard
              effectiveVersion={effectiveVersion}
              isDirty={isDirty}
              onAskDiscard={setPendingVersion}
              onSelectVersion={(v) => {
                setMode('view');
                setSelectedVersion(v);
              }}
              template={template}
            />
          </div>
        )}
      </div>

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
        message="You have unsaved edits to this version. Cancelling discards them."
        onClose={() => setCancelConfirmOpen(false)}
        onConfirm={handleCancel}
        open={cancelConfirmOpen}
        title="Discard your edits?"
      />

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
