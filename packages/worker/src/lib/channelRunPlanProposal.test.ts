import { describe, expect, it } from 'vitest';
import { buildProposal, goalFromSlackMessage, quoteForSlack } from './channelRunPlanProposal.js';

describe('goalFromSlackMessage', () => {
  it('trims and removes mention tokens, and nothing else', () => {
    expect(goalFromSlackMessage('  <@U1ABC> do <b>this</b> ')).toBe('do <b>this</b>');
  });
});

describe('quoteForSlack', () => {
  it('escapes markup and quotes every line', () => {
    expect(quoteForSlack('a <!here>\nb & c')).toBe('> a &lt;!here&gt;\n> b &amp; c');
  });
});

describe('buildProposal', () => {
  const facts = {
    agentKey: null,
    goal: 'do it',
    mode: 'delivering' as const,
    repoLabel: 'acme/<x>',
    token: 't'.repeat(100),
  };

  it('carries the token as the button value and nothing else in it', () => {
    const out = buildProposal(facts);
    expect(out).not.toBeNull();
    const actions = (
      (out as { blocks: unknown[] }).blocks as Array<{
        type: string;
        elements?: unknown[];
      }>
    ).find((b) => b.type === 'actions');
    expect(actions?.elements).toEqual([
      expect.objectContaining({ action_id: 'run_plan_generate', value: facts.token }),
    ]);
    expect(JSON.stringify(out?.blocks)).toContain('acme/&lt;x&gt;');
  });

  it('is null rather than trimmed when it does not fit Slack', () => {
    expect(buildProposal({ ...facts, token: 't'.repeat(2001) })).toBeNull();
    expect(buildProposal({ ...facts, goal: '<'.repeat(700) })).toBeNull();
  });
});
