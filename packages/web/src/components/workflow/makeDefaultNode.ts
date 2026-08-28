/**
 * Defaults for nodes newly created via palette drag-and-drop in the
 * TemplateEditor. Extracted from TemplateEditor.tsx.
 */

import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import type { PaletteDragKind } from './NodePalette';

export function makeDefaultNodeFor(payload: PaletteDragKind): SpecNode {
  if (payload.kind === 'step') {
    return { step: payload.step, type: 'step' };
  }
  switch (payload.nodeType) {
    case 'step':
      return { step: '', type: 'step' };
    case 'agent':
      return { agentRef: '', type: 'agent' };
    case 'mcp':
      return { connectionRef: '', tool: '', type: 'mcp' };
    case 'eval':
      return {
        scorers: [{ gate: 'runTests', kind: 'gate' }],
        target: { from: '' },
        type: 'eval',
      };
    case 'containerStep':
      return { command: '', image: 'node:24-alpine', type: 'containerStep' };
    case 'cond':
      return { expr: 'true', onFalse: '', onTrue: '', type: 'cond' };
    case 'signal':
      return {
        name: '',
        onReceive: '',
        onTimeout: '',
        timeout: '1h',
        type: 'signal',
      };
    case 'fanOut':
      return {
        itemKey: 'subtask',
        join: '',
        onBranchFail: 'block',
        over: { from: '' },
        subgraph: '',
        type: 'fanOut',
      };
    case 'set':
      return { type: 'set', values: {} };
    case 'shell':
      return { command: '', image: 'node:24-alpine', type: 'shell' };
    case 'terminate':
      return { status: 'SUCCESS', type: 'terminate' };
    case 'humanApproval':
      return {
        onApprove: '',
        onReject: '',
        onTimeout: '',
        timeout: '24h',
        title: '',
        type: 'humanApproval',
      };
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
      };
    case 'humanInput':
      return {
        fields: [{ key: 'value', label: 'Value', type: 'text' }],
        onSubmit: '',
        onTimeout: '',
        timeout: '24h',
        title: '',
        type: 'humanInput',
      };
    case 'humanReview':
      return {
        contentFrom: '',
        onSubmit: '',
        onTimeout: '',
        timeout: '24h',
        title: '',
        type: 'humanReview',
      };
    default:
      throw new Error(`Unknown node type: ${payload.nodeType}`);
  }
}
