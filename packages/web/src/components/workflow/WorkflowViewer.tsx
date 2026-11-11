'use client';

import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { nodeEdges } from '@auto-swe/shared/workflow';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils';
import { nodeDisplayName } from './nodeDisplay';
import { nodeTypeLabel } from './nodeTypeTone';
import { WorkflowDag } from './WorkflowDag';
import { WorkflowOutline } from './WorkflowOutline';

export function WorkflowViewer({
  spec,
  selectedNodeId,
  onSelect,
}: {
  spec: WorkflowSpec;
  selectedNodeId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [outline, setOutline] = useState(true);
  const inspector = useRef<HTMLElement>(null);
  const inspectorTrigger = useRef<HTMLElement | null>(null);
  const node = selectedNodeId ? spec.nodes[selectedNodeId] : undefined;
  useEffect(() => {
    if (selectedNodeId) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && !inspector.current?.contains(active)) {
        inspectorTrigger.current = active;
      }
      if (!window.matchMedia('(min-width: 1024px)').matches) {
        inspector.current?.focus();
      }
    } else {
      if (inspectorTrigger.current?.isConnected) {
        inspectorTrigger.current.focus({ preventScroll: true });
      }
      inspectorTrigger.current = null;
    }
  }, [selectedNodeId]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-y border-ink-600 px-4 py-2 text-xs text-paper-400">
        <Button
          aria-pressed={outline}
          onClick={() => setOutline((v) => !v)}
          size="sm"
          variant="ghost"
        >
          <Icon name="list" size={13} />
          Outline
        </Button>
        <span>{Object.keys(spec.nodes).length} nodes · Read only</span>
        <span className="ml-auto hidden sm:inline">Select a node to inspect its configuration</span>
      </div>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {outline && (
          <aside
            aria-label="Workflow outline"
            className="absolute inset-0 z-10 w-full border-r border-ink-600 bg-ink-900 lg:static lg:w-52 lg:shrink-0"
          >
            <WorkflowOutline
              height="100%"
              onSelect={onSelect}
              selectedNodeId={selectedNodeId}
              spec={spec}
            />
          </aside>
        )}
        <div className={cn('min-w-0 flex-1', outline && 'max-lg:hidden')}>
          <WorkflowDag
            height="100%"
            onSelect={onSelect}
            selectedNodeId={selectedNodeId}
            spec={spec}
          />
        </div>
        {node && selectedNodeId && (
          <aside
            aria-label="Node details"
            className="absolute inset-0 z-20 flex min-h-0 w-full flex-col border-l border-ink-600 bg-ink-950 outline-none lg:static lg:w-72 lg:shrink-0"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onSelect(null);
              }
            }}
            ref={inspector}
            tabIndex={-1}
          >
            <header className="flex items-center justify-between gap-2 border-b border-ink-600 px-4 py-3">
              <h2 className="text-sm font-semibold text-paper-100">Node details</h2>
              <Button onClick={() => onSelect(null)} size="sm" variant="ghost">
                <Icon name="close" size={13} />
                Close
              </Button>
            </header>
            <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4 text-sm">
              <div>
                <p className="text-xs text-paper-500">{nodeTypeLabel(node.type)} · Read only</p>
                <h3 className="mt-2 font-semibold text-paper-100">
                  {nodeDisplayName(node, selectedNodeId)}
                </h3>
                <p className="mt-1 break-all font-mono text-xs text-paper-400">
                  {selectedNodeId}
                  {spec.entry === selectedNodeId ? ' · entry' : ''}
                </p>
              </div>
              <div>
                <h4 className="mb-2 text-xs font-medium text-paper-400">Connections</h4>
                {nodeEdges(node).length ? (
                  nodeEdges(node).map(([field, target]) => (
                    <div className="break-all font-mono text-xs text-paper-200" key={field}>
                      {field}: {target}
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-paper-500">No outgoing connections</p>
                )}
              </div>
              <div>
                <dl className="space-y-3">
                  {Object.entries(node)
                    .filter(
                      ([field]) =>
                        ![
                          'type',
                          'title',
                          'next',
                          'onFail',
                          'onTimeout',
                          'onError',
                          'onTrue',
                          'onFalse',
                          'join',
                          'subgraph',
                        ].includes(field)
                    )
                    .map(([field, value]) => (
                      <div key={field}>
                        <dt className="mb-1 text-xs font-medium text-paper-500">
                          {field.replace(/([A-Z])/g, ' $1')}
                        </dt>
                        <dd className="whitespace-pre-wrap break-words font-mono text-xs text-paper-200">
                          {typeof value === 'object'
                            ? JSON.stringify(value, null, 2)
                            : String(value)}
                        </dd>
                      </div>
                    ))}
                </dl>
              </div>
              <details>
                <summary className="cursor-pointer text-xs text-paper-400">
                  Raw configuration
                </summary>
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-xs font-medium text-paper-400">Configuration</h4>
                  <CopyButton value={JSON.stringify(node, null, 2)} />
                </div>
                <pre className="whitespace-pre-wrap break-words rounded-lg border border-ink-600 bg-ink-900 p-3 font-mono text-xs leading-relaxed text-paper-300">
                  {JSON.stringify(node, null, 2)}
                </pre>
              </details>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
