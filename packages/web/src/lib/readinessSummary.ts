import type { Readiness, ReadinessItem } from '@/hooks/useReadiness';

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  google: 'Google',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
};

export function readinessSummary(item: ReadinessItem, data: Readiness): string[] {
  if (item.id !== 'credentials' || item.ok) {
    return [item.detail];
  }
  const groups = new Map<
    string,
    { provider: string | null; problem: string; agents: Set<string> }
  >();
  for (const gap of data.gaps ?? []) {
    if (!gap.blocking || gap.subject === 'embeddings') {
      continue;
    }
    const credentialGap = gap.problem === 'no-credential' || gap.problem === 'no-api-base';
    const provider = credentialGap ? gap.provider?.trim().toLowerCase() || null : null;
    const problem = provider ? gap.problem : 'configuration';
    const key = `${provider ?? ''}:${problem}`;
    const group = groups.get(key) ?? { agents: new Set<string>(), problem, provider };
    group.agents.add(gap.subject);
    groups.set(key, group);
  }
  if (!groups.size) {
    return ['Model provider credentials need attention'];
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => {
      const count = group.agents.size;
      const subject = `${count} ${count === 1 ? 'agent needs' : 'agents need'}`;
      const provider = group.provider ? (PROVIDER_NAMES[group.provider] ?? group.provider) : null;
      if (provider && group.problem === 'no-credential') {
        return `${subject} ${/^[aeiou]/i.test(provider) ? 'an' : 'a'} ${provider} credential`;
      }
      if (provider && group.problem === 'no-api-base') {
        return `${subject} an API base URL for ${provider}`;
      }
      return `${subject} a valid model configuration`;
    });
}
