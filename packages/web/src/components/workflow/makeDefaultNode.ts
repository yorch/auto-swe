/**
 * Defaults for nodes newly created via palette drag-and-drop in the
 * TemplateEditor. Extracted from TemplateEditor.tsx.
 */

import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import type { PaletteDragKind } from './NodePalette';

export function makeDefaultNodeFor(payload: PaletteDragKind): SpecNode {
  if (payload.kind === 'step') {
    return { step: payload.step, type: 'step' } as SpecNode;
  }
  switch (payload.nodeType) {
    case 'step':
      return { step: '', type: 'step' } as SpecNode;
    case 'cond':
      return { expr: 'true', onFalse: '', onTrue: '', type: 'cond' } as SpecNode;
    case 'signal':
      return {
        name: '',
        onReceive: '',
        onTimeout: '',
        timeout: '1h',
        type: 'signal',
      } as SpecNode;
    case 'fanOut':
      return {
        itemKey: 'subtask',
        join: '',
        onBranchFail: 'block',
        over: { from: '' },
        subgraph: '',
        type: 'fanOut',
      } as SpecNode;
    case 'set':
      return { type: 'set', values: {} } as SpecNode;
    case 'shell':
      return { command: '', image: 'node:24-alpine', type: 'shell' } as SpecNode;
    case 'terminate':
      return { status: 'SUCCESS', type: 'terminate' } as SpecNode;
    case 'humanApproval':
      return {
        onApprove: '',
        onReject: '',
        onTimeout: '',
        timeout: '24h',
        title: '',
        type: 'humanApproval',
      } as SpecNode;
    case 'humanDecision':
      return {
        onTimeout: '',
        options: [
          { label: 'Option A', next: '', value: 'a' },
          { label: 'Option B', next: '', value: 'b' },
        ],
        timeout: '24h',
        title: '',
        type: 'humanDecision',
      } as SpecNode;
    case 'humanInput':
      return {
        fields: [{ key: 'value', label: 'Value', type: 'text' }],
        onSubmit: '',
        onTimeout: '',
        timeout: '24h',
        title: '',
        type: 'humanInput',
      } as SpecNode;
    case 'humanReview':
      return {
        contentFrom: '',
        onSubmit: '',
        onTimeout: '',
        timeout: '24h',
        title: '',
        type: 'humanReview',
      } as SpecNode;
  }
}
