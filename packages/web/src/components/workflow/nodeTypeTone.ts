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

/** The human name of each node type, shared by the palette, the inspector and the outline. */
export const NODE_TYPE_LABEL: Record<SpecNode['type'], string> = {
  agent: 'Agent',
  cond: 'Condition',
  containerStep: 'Container step',
  eval: 'Eval',
  fanOut: 'Fan-out',
  humanApproval: 'Approval',
  humanDecision: 'Decision',
  humanInput: 'Input',
  humanReview: 'Review',
  mcp: 'MCP tool',
  set: 'Set',
  shell: 'Shell',
  signal: 'Signal',
  step: 'Step',
  terminate: 'Terminate',
};

/**
 * Whether `type` is a node type this build knows. A spec can carry one it does not (hand-edited
 * JSON, a typo, a version authored by another release), and every table in this file is indexed by
 * the known union: an unguarded lookup yields `undefined` and the first property read on it throws
 * during render.
 */
export function isKnownNodeType(type: unknown): type is SpecNode['type'] {
  return typeof type === 'string' && Object.hasOwn(NODE_TYPE_TONE, type);
}

/** Tone for a node whose type is not known: red, so it reads as "not a real kind". */
export const UNKNOWN_NODE_TONE = { border: 'border-l-brick-400', swatch: 'bg-brick-400' };

/** `NODE_TYPE_TONE[type]`, safe for a type this build does not know. */
export function nodeTypeTone(type: unknown): { border: string; swatch: string } {
  return isKnownNodeType(type) ? NODE_TYPE_TONE[type] : UNKNOWN_NODE_TONE;
}

/** The type's human name; an unknown type is named as such, with the raw text quoted. */
export function nodeTypeLabel(type: unknown): string {
  if (isKnownNodeType(type)) {
    return NODE_TYPE_LABEL[type];
  }
  return typeof type === 'string' && type !== '' ? `Unknown type "${type}"` : 'Unknown type';
}
