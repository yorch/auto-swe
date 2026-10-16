'use client';

/**
 * TemplateEditor — visual workflow spec editor.
 *
 * Wraps React Flow with:
 *  - Left rail: <NodePalette> with primitives + step registry (drag onto canvas)
 *  - Centre:   ReactFlow canvas with drag-to-create + drag-to-connect
 *  - Right rail: schema-aware <NodeInspector> for the selected node
 *
 * The single source of truth is the `spec` prop. Edits emit through `onChange`
 * — the parent controls validation, save flow, and version management.
 * Initial node positions come from `layoutSpec`; the user can drag to refine
 * for the session but positions are not persisted in the spec (no schema
 * change required).
 *
 * State and handlers live in `templateEditor/useTemplateEditorState`; the action bar, issue list,
 * side rails and inspector are components beside it.
 */

import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Alert } from '@/components/ui/Alert';
import { DagNode } from './dagNode';
import { FlowChrome } from './flowChrome';
import { CheckStatus } from './templateEditor/CheckStatus';
import { EditorActionBar } from './templateEditor/EditorActionBar';
import { EditorInspectorPanel } from './templateEditor/EditorInspectorPanel';
import { OutlineRail, PaletteRail } from './templateEditor/EditorSideRails';
import { EditorStatusBar } from './templateEditor/EditorStatusBar';
import { IssuesPanel } from './templateEditor/IssuesPanel';
import type { TemplateEditorProps as Props } from './templateEditor/types';
import { useTemplateEditorState } from './templateEditor/useTemplateEditorState';

const NODE_TYPES = { dag: DagNode };

export function TemplateEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}

function EditorInner({
  spec,
  stepRegistry,
  selectedNodeId,
  onSelect,
  onChange,
  costEstimateUsd,
  costEstimateExclusions,
  observedCostUsd,
  parseError,
  serverError,
  templateId,
  teamId,
  actions,
}: Props) {
  const {
    canvasRef,
    checkResult,
    edges,
    fit,
    framed,
    handleConnect,
    handleDeleteNode,
    handleDragOver,
    handleDrop,
    handleEdgesChange,
    handleOverlayKeyDown,
    handlePaletteAdd,
    handleRename,
    inspectorRef,
    issues,
    issuesRef,
    issuesSummaryRef,
    knownGroups,
    nodesWithSelection,
    onNodesChange,
    outlineRef,
    outlineVisible,
    paletteOpen,
    paletteRef,
    runCheck,
    selectedNode,
    selectedStepMeta,
    serverExtra,
    serverIssues,
    setOutlineVisible,
    setPaletteOpen,
    shownErrors,
    shownWarnings,
    wrapperRef,
  } = useTemplateEditorState({
    onChange,
    onSelect,
    selectedNodeId,
    serverError,
    spec,
    stepRegistry,
    teamId,
    templateId,
  });

  return (
    <div className="flex flex-1 min-h-[560px] flex-col overflow-hidden md:min-h-0 border-y border-ink-600 bg-ink-900">
      <EditorActionBar
        actions={actions}
        checkPending={checkResult?.server.state === 'pending'}
        onCheck={runCheck}
        paletteOpen={paletteOpen}
        setPaletteOpen={setPaletteOpen}
        setShowOutline={setOutlineVisible}
        showOutline={outlineVisible}
      />

      <CheckStatus
        checkResult={checkResult}
        shownErrors={shownErrors}
        shownWarnings={shownWarnings}
      />

      {parseError && (
        <Alert className="rounded-none border-x-0 border-t-0 font-mono text-xs">{parseError}</Alert>
      )}

      <IssuesPanel
        issues={issues}
        issuesRef={issuesRef}
        issuesSummaryRef={issuesSummaryRef}
        onSelect={onSelect}
        serverExtra={serverExtra}
        serverIssues={serverIssues}
        shownErrors={shownErrors}
        shownWarnings={shownWarnings}
        spec={spec}
      />

      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape only closes the overlays inside */}
      <div
        className="relative flex min-h-0 flex-1 overflow-hidden"
        onKeyDown={handleOverlayKeyDown}
        ref={wrapperRef}
      >
        <PaletteRail
          onAdd={handlePaletteAdd}
          onClose={() => setPaletteOpen(false)}
          open={paletteOpen}
          paletteRef={paletteRef}
          steps={stepRegistry}
        />

        {outlineVisible && (
          <OutlineRail
            onSelect={onSelect}
            outlineRef={outlineRef}
            selectedNodeId={selectedNodeId}
            spec={spec}
          />
        )}

        {/* Canvas — this wrapper is the HTML5 drag-and-drop target; the React Flow
            canvas inside it is the interactive surface. */}
        <div
          aria-label="Workflow editor canvas. Left and right arrows follow the flow, up and down arrows switch between branches, Enter opens a node, Home jumps to the start, Delete removes the selected node."
          className={`relative min-w-0 flex-1 bg-ink-900 ${framed ? '' : 'opacity-0'}`}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          ref={canvasRef}
          role="application"
        >
          <ReactFlow
            connectionLineStyle={{ stroke: 'var(--color-accent-400)', strokeWidth: 2 }}
            deleteKeyCode="Delete"
            edges={edges}
            maxZoom={2.5}
            minZoom={0.15}
            nodes={nodesWithSelection}
            nodesConnectable
            nodesDraggable
            nodeTypes={NODE_TYPES}
            onConnect={handleConnect}
            onEdgesChange={handleEdgesChange}
            onNodeClick={(_, n) => onSelect(n.id === selectedNodeId ? null : n.id)}
            onNodesChange={onNodesChange}
            onPaneClick={() => onSelect(null)}
            proOptions={{ hideAttribution: true }}
            zoomOnDoubleClick={false}
          >
            <FlowChrome onFit={fit} />
          </ReactFlow>
        </div>

        <EditorInspectorPanel
          inspectorRef={inspectorRef}
          knownGroups={knownGroups}
          onChange={onChange}
          onDelete={handleDeleteNode}
          onRename={handleRename}
          onSelect={onSelect}
          selectedNode={selectedNode}
          selectedNodeId={selectedNodeId}
          selectedStepMeta={selectedStepMeta}
          spec={spec}
          stepRegistry={stepRegistry}
        />
      </div>

      <EditorStatusBar
        costEstimateExclusions={costEstimateExclusions}
        costEstimateUsd={costEstimateUsd}
        observedCostUsd={observedCostUsd}
        spec={spec}
      />
    </div>
  );
}
