import { describe, expect, it } from 'vitest';
import type { Readiness, ReadinessGap, ReadinessItem } from '@/hooks/useReadiness';
import { readinessSummary } from './readinessSummary';

const item: ReadinessItem = {
  detail: 'A long list of agents.',
  href: '/models?tab=credentials',
  id: 'credentials',
  label: 'Model provider credentials',
  ok: false,
};
const gap = (
  subject: string,
  provider: string | null = 'anthropic',
  problem = 'no-credential',
  blocking = true
): ReadinessGap => ({
  blocking,
  detail: '',
  orgId: null,
  problem,
  provider,
  scope: 'GLOBAL',
  subject,
  teamId: null,
});
const data = (gaps: ReadinessGap[]): Readiness => ({
  gaps,
  items: [item],
  providers: [],
  ready: false,
});

describe('readiness summaries', () => {
  it('summarizes agents by provider without listing agent names', () => {
    const gaps = Array.from({ length: 23 }, (_, index) => gap(`agent-${index}`));
    gaps.push(gap('google-agent', 'google'), gap('openai-agent', 'openai'));
    expect(readinessSummary(item, data(gaps))).toEqual([
      '23 agents need an Anthropic credential',
      '1 agent needs a Google credential',
      '1 agent needs an OpenAI credential',
    ]);
  });
  it('ignores embeddings and advisory gaps and counts each affected agent once', () => {
    expect(
      readinessSummary(
        item,
        data([
          gap('reviewer'),
          gap('reviewer'),
          gap('embeddings'),
          gap('advisory', 'google', 'no-credential', false),
        ])
      )
    ).toEqual(['1 agent needs an Anthropic credential']);
  });
  it('handles custom providers, API base errors and missing or invalid models accurately', () => {
    expect(
      readinessSummary(
        item,
        data([
          gap('one', 'acme'),
          gap('two', 'private-llm', 'no-api-base'),
          gap('three', null, 'no-model'),
          gap('four', null, 'invalid-spec'),
        ])
      )
    ).toEqual([
      '2 agents need a valid model configuration',
      '1 agent needs an acme credential',
      '1 agent needs an API base URL for private-llm',
    ]);
  });
  it('uses a concise fallback when no structured agent gaps exist', () => {
    expect(readinessSummary(item, data([]))).toEqual(['Model provider credentials need attention']);
  });
  it('preserves the details of other items and completed steps', () => {
    expect(
      readinessSummary({ ...item, detail: 'Connect a repository.', id: 'connections' }, data([]))
    ).toEqual(['Connect a repository.']);
    expect(readinessSummary({ ...item, ok: true }, data([]))).toEqual([item.detail]);
  });
});
