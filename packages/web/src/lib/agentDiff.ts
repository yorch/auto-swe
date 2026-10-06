import type { AgentRow } from '@/hooks/useAgentLibrary';

/**
 * What changed between two versions of an agent, in terms a person reads: the prompt as a
 * line diff, the model, the skills and tools as added/removed lists.
 */

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };

/** Above this many line pairs the LCS table is too large; the whole text is shown as replaced. */
const MAX_LCS_CELLS = 4_000_000;

/** A line-level diff (longest common subsequence). Pure, so it is unit-tested directly. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [
      ...a.map((text) => ({ kind: 'removed' as const, text })),
      ...b.map((text) => ({ kind: 'added' as const, text })),
    ];
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'removed', text: a[i++] });
    } else {
      out.push({ kind: 'added', text: b[j++] });
    }
  }
  while (i < a.length) {
    out.push({ kind: 'removed', text: a[i++] });
  }
  while (j < b.length) {
    out.push({ kind: 'added', text: b[j++] });
  }
  return out;
}

export type FieldChange =
  | { kind: 'text'; label: string; before: string; after: string }
  | { kind: 'prompt'; label: string; lines: DiffLine[] }
  | { kind: 'list'; label: string; added: string[]; removed: string[]; reordered: boolean };

type VersionContent = Pick<
  AgentRow,
  | 'name'
  | 'description'
  | 'modelSpec'
  | 'inheritsModelFrom'
  | 'systemPrompt'
  | 'toolKeys'
  | 'mcpConnectionId'
  | 'credentialId'
  | 'runtime'
  | 'skillRefs'
>;

export interface DiffLookups {
  mcp?: ReadonlyMap<string, string>;
  credentials?: ReadonlyMap<string, string>;
}

function modelText(v: VersionContent): string {
  if (v.modelSpec) {
    return v.modelSpec;
  }
  return v.inheritsModelFrom ? `Inherits from ${v.inheritsModelFrom}` : 'Role default';
}

function toolsText(keys: string[] | null): string[] {
  return keys === null ? ['All tools'] : keys;
}

/** The changes from `before` to `after`; empty when the two carry the same settings. */
export function diffAgentVersions(
  before: VersionContent,
  after: VersionContent,
  lookups: DiffLookups = {}
): FieldChange[] {
  const changes: FieldChange[] = [];
  const text = (label: string, b: string, a: string) => {
    if (b !== a) {
      changes.push({ after: a, before: b, kind: 'text', label });
    }
  };
  text('Name', before.name, after.name);
  text('Description', before.description ?? '', after.description ?? '');
  text('Model', modelText(before), modelText(after));
  if ((before.systemPrompt ?? '') !== (after.systemPrompt ?? '')) {
    changes.push({
      kind: 'prompt',
      label: 'System prompt',
      lines: lineDiff(before.systemPrompt ?? '', after.systemPrompt ?? ''),
    });
  }
  const list = (label: string, b: string[], a: string[]) => {
    const added = a.filter((x) => !b.includes(x));
    const removed = b.filter((x) => !a.includes(x));
    const reordered = added.length === 0 && removed.length === 0 && b.join('\n') !== a.join('\n');
    if (added.length > 0 || removed.length > 0 || reordered) {
      changes.push({ added, kind: 'list', label, removed, reordered });
    }
  };
  const skillNames = (v: VersionContent) =>
    [...v.skillRefs].sort((x, y) => x.sortOrder - y.sortOrder).map((r) => r.skill.name);
  list('Skills', skillNames(before), skillNames(after));
  list('Tools', toolsText(before.toolKeys), toolsText(after.toolKeys));
  const named = (id: string | null, map?: ReadonlyMap<string, string>) =>
    id ? (map?.get(id) ?? 'Selected') : 'None';
  text(
    'MCP connection',
    named(before.mcpConnectionId, lookups.mcp),
    named(after.mcpConnectionId, lookups.mcp)
  );
  text(
    'Credential override',
    named(before.credentialId, lookups.credentials),
    named(after.credentialId, lookups.credentials)
  );
  text('Runtime', before.runtime ?? 'Default', after.runtime ?? 'Default');
  return changes;
}
