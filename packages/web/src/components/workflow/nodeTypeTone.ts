import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import type { IconName } from '@/components/ui/Icon';

/**
 * The four families a node belongs to. Colour says the family; the header icon (`NODE_TYPE_ICON`)
 * and label say the specific kind, so a canvas reads as four colours rather than fifteen.
 */
export type NodeCategory = 'agent' | 'human' | 'control' | 'execution';

export const NODE_CATEGORY_LABEL: Record<NodeCategory, string> = {
  agent: 'Agent and AI work',
  control: 'Control flow',
  execution: 'Execution and infrastructure',
  human: 'Human gate',
};

/** Which family each type is in. `Record` over the known union: a new node type fails to compile until placed. */
export const NODE_TYPE_CATEGORY: Record<SpecNode['type'], NodeCategory> = {
  agent: 'agent',
  cond: 'control',
  containerStep: 'execution',
  eval: 'agent',
  fanOut: 'control',
  humanApproval: 'human',
  humanDecision: 'human',
  humanInput: 'human',
  humanReview: 'human',
  mcp: 'execution',
  set: 'control',
  shell: 'execution',
  signal: 'control',
  step: 'agent',
  terminate: 'control',
};

/** One colour per category, shared by the canvas node's left stripe and the palette swatch. Full literal class strings so Tailwind's scanner sees every one. */
export const CATEGORY_TONE: Record<NodeCategory, { border: string; swatch: string }> = {
  agent: { border: 'border-l-ember-400', swatch: 'bg-ember-400' },
  control: { border: 'border-l-violet-400', swatch: 'bg-violet-400' },
  execution: { border: 'border-l-dust-400', swatch: 'bg-dust-400' },
  human: { border: 'border-l-amber-600', swatch: 'bg-amber-600' },
};

/** The specific kind, drawn small in the node header. */
export const NODE_TYPE_ICON: Record<SpecNode['type'], IconName> = {
  agent: 'agents',
  cond: 'branch',
  containerStep: 'package',
  eval: 'flask',
  fanOut: 'layers',
  humanApproval: 'checkCircle',
  humanDecision: 'gavel',
  humanInput: 'edit',
  humanReview: 'search',
  mcp: 'plug',
  set: 'sliders',
  shell: 'terminal',
  signal: 'inbox',
  step: 'puzzle',
  terminate: 'stop',
};

/** Tone per type, derived from its category so the two cannot drift. */
export const NODE_TYPE_TONE: Record<SpecNode['type'], { border: string; swatch: string }> =
  Object.fromEntries(
    Object.entries(NODE_TYPE_CATEGORY).map(([type, cat]) => [type, CATEGORY_TONE[cat]])
  ) as Record<SpecNode['type'], { border: string; swatch: string }>;

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

/** Icon for a node type; an unknown type gets a warning glyph. */
export function nodeTypeIcon(type: unknown): IconName {
  return isKnownNodeType(type) ? NODE_TYPE_ICON[type] : 'warning';
}
