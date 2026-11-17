import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import StartWorkPage from './page';

async function propsFor(search: { mode?: string; template?: string; job?: string; plan?: string }) {
  const element = (await StartWorkPage({ searchParams: Promise.resolve(search) })) as ReactElement<{
    initialMode?: string;
    initialTemplateId?: string;
    initialJobId?: string;
    initialPlanId?: string;
  }>;
  return { key: element.key, ...element.props };
}

describe('/start parameters', () => {
  it('reads a known mode and ignores an unknown one', async () => {
    expect((await propsFor({ mode: 'agent' })).initialMode).toBe('agent');
    expect((await propsFor({ mode: 'epic' })).initialMode).toBe('epic');
    expect((await propsFor({ mode: 'prd' })).initialMode).toBe('prd');
    expect((await propsFor({ mode: 'orchestrate' })).initialMode).toBe('orchestrate');
    expect((await propsFor({ mode: 'bogus' })).initialMode).toBeUndefined();
  });

  it('defaults to workflow mode for a template link', async () => {
    const props = await propsFor({ template: 'abc' });
    expect(props.initialMode).toBe('workflow');
    expect(props.initialTemplateId).toBe('abc');
  });

  it('truncates an oversized template id', async () => {
    expect((await propsFor({ template: 'x'.repeat(200) })).initialTemplateId).toHaveLength(64);
  });

  it('keys the page on mode and template so a new link re-seeds it', async () => {
    const a = await propsFor({ mode: 'agent' });
    const b = await propsFor({});
    expect(a.key).not.toBe(b.key);
  });

  it('reads the plan mode', async () => {
    expect((await propsFor({ mode: 'plan' })).initialMode).toBe('plan');
  });

  it('resumes a valid generation job in plan mode', async () => {
    const job = 'runplan-0a1b2c3d-0123456789abcdef';
    const props = await propsFor({ job, mode: 'agent' });
    expect(props.initialMode).toBe('plan');
    expect(props.initialJobId).toBe(job);
  });

  it('falls back to the normal form for an invalid job id', async () => {
    const props = await propsFor({ job: 'runplan-../../x', mode: 'plan' });
    expect(props.initialJobId).toBeUndefined();
    expect(props.initialPlanId).toBeUndefined();
    expect(props.initialMode).toBe('plan');
    expect((await propsFor({ job: 'nope' })).initialMode).toBeUndefined();
  });

  it('opens an existing plan from a valid plan id only', async () => {
    const plan = '0b1c2d3e-0123-4abc-8def-0123456789ab';
    const props = await propsFor({ plan });
    expect(props.initialMode).toBe('plan');
    expect(props.initialPlanId).toBe(plan);
    expect((await propsFor({ plan: 'not-a-uuid' })).initialPlanId).toBeUndefined();
  });
});
