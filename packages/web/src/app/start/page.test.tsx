import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import StartWorkPage from './page';

async function propsFor(search: { mode?: string; template?: string }) {
  const element = (await StartWorkPage({ searchParams: Promise.resolve(search) })) as ReactElement<{
    initialMode?: string;
    initialTemplateId?: string;
  }>;
  return { key: element.key, ...element.props };
}

describe('/start parameters', () => {
  it('reads a known mode and ignores an unknown one', async () => {
    expect((await propsFor({ mode: 'agent' })).initialMode).toBe('agent');
    expect((await propsFor({ mode: 'epic' })).initialMode).toBe('epic');
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
});
