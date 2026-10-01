import type { AgentRow, UpdateAgentBody } from '@/hooks/useAgentLibrary';

type NullableTextKey = 'description' | 'modelSpec' | 'inheritsModelFrom' | 'systemPrompt';
const NULLABLE_TEXT_KEYS: readonly NullableTextKey[] = [
  'description',
  'modelSpec',
  'inheritsModelFrom',
  'systemPrompt',
];

function sameList(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The PUT body for an edited Agent: only the fields that changed. Resending an
 * unchanged `systemPrompt` is not harmless — the gateway treats any prompt in
 * the body as an edit, rescans it and resets `isVerified`, so renaming a
 * verified built-in used to strip its verification. An emptied optional text
 * field is sent as `null` so it actually clears.
 */
export function buildAgentUpdate(original: AgentRow, draft: AgentRow): UpdateAgentBody {
  const body: UpdateAgentBody = {};
  const name = draft.name.trim();
  if (name !== original.name) {
    body.name = name;
  }
  for (const key of NULLABLE_TEXT_KEYS) {
    const before = original[key] ?? '';
    const after = draft[key] ?? '';
    // The prompt is compared verbatim; the short fields ignore stray whitespace.
    const next = key === 'systemPrompt' ? after : after.trim();
    if (next !== before) {
      body[key] = next === '' ? null : next;
    }
  }
  if (!sameList(original.toolKeys, draft.toolKeys)) {
    body.toolKeys = draft.toolKeys;
  }
  if ((draft.mcpConnectionId ?? null) !== (original.mcpConnectionId ?? null)) {
    body.mcpConnectionId = draft.mcpConnectionId ?? null;
  }
  if ((draft.credentialId ?? null) !== (original.credentialId ?? null)) {
    body.credentialId = draft.credentialId ?? null;
  }
  const beforeSkills = original.skillRefs.map((r) => r.skillId);
  const afterSkills = draft.skillRefs.map((r) => r.skillId);
  if (!sameList(beforeSkills, afterSkills)) {
    body.skillRefs = afterSkills.map((skillId, sortOrder) => ({ skillId, sortOrder }));
  }
  return body;
}
