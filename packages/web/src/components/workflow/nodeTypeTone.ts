import type { Node as SpecNode } from '@auto-swe/shared/workflow';

/**
 * One colour per node type, shared by the canvas node's left stripe and the
 * palette swatch so the two cannot drift. Full literal class strings so
 * Tailwind's scanner sees every one.
 */
export const NODE_TYPE_TONE: Record<SpecNode['type'], { border: string; swatch: string }> = {
  agent: { border: 'border-l-ember-300', swatch: 'bg-ember-300' },
  cond: { border: 'border-l-violet-400', swatch: 'bg-violet-400' },
  containerStep: { border: 'border-l-brick-400', swatch: 'bg-brick-400' },
  eval: { border: 'border-l-moss-400', swatch: 'bg-moss-400' },
  fanOut: { border: 'border-l-moss-400', swatch: 'bg-moss-400' },
  humanApproval: { border: 'border-l-amber-600', swatch: 'bg-amber-600' },
  humanDecision: { border: 'border-l-amber-600', swatch: 'bg-amber-600' },
  humanInput: { border: 'border-l-amber-600', swatch: 'bg-amber-600' },
  humanReview: { border: 'border-l-amber-600', swatch: 'bg-amber-600' },
  mcp: { border: 'border-l-dust-400', swatch: 'bg-dust-400' },
  set: { border: 'border-l-amber-400', swatch: 'bg-amber-400' },
  shell: { border: 'border-l-brick-400', swatch: 'bg-brick-400' },
  signal: { border: 'border-l-dust-400', swatch: 'bg-dust-400' },
  step: { border: 'border-l-ember-400', swatch: 'bg-ember-400' },
  terminate: { border: 'border-l-paper-500', swatch: 'bg-paper-500' },
};
