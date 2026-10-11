// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock } from '@/test/rtl-helpers';
import { useValidateWorkflow } from './useValidateWorkflow';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useValidateWorkflow(), { wrapper });
}

describe('useValidateWorkflow', () => {
  it('posts the spec and scope to the validate endpoint and returns the unwrapped result', async () => {
    const issue = {
      code: 'AGENT_NOT_FOUND',
      message: 'missing',
      nodeId: 'a',
      severity: 'warning',
      source: 'refs',
    };
    const spy = setupFetchMock({
      'POST /api/v1/workflow-templates/validate': () => ({ data: { issues: [issue], ok: true } }),
    });
    const { result } = setup();
    let out: unknown;
    await act(async () => {
      out = await result.current.mutateAsync({ spec: { a: 1 }, teamId: 't', templateId: 'tpl' });
    });
    expect(out).toEqual({ issues: [issue], ok: true });
    expect(bodyOf(spy, '/api/v1/workflow-templates/validate')).toEqual({
      spec: { a: 1 },
      teamId: 't',
      templateId: 'tpl',
    });
  });

  it('rejects on a non-2xx answer so the caller can say the check could not run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }), {
            headers: { 'content-type': 'application/json' },
            status: 403,
          })
      )
    );
    const { result } = setup();
    await act(async () => {
      await expect(result.current.mutateAsync({ spec: {} })).rejects.toMatchObject({ status: 403 });
    });
  });
});
