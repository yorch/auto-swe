// @vitest-environment jsdom

import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ValidateWorkflowResult } from '@/hooks/useValidateWorkflow';
import { ApiError } from '@/lib/api';
import { schemaIssues } from '@/lib/specSchemaIssues';
import { TemplateEditor } from './TemplateEditor';

// React Flow measures its container; jsdom has no layout engine.
beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO);
  vi.stubGlobal(
    'DOMMatrixReadOnly',
    class {
      m22 = 1;
    }
  );
  window.matchMedia =
    window.matchMedia ??
    ((q: string) =>
      ({
        addEventListener() {},
        matches: true,
        media: q,
        removeEventListener() {},
      }) as unknown as MediaQueryList);
});
afterEach(cleanup);

// The network is the hook's concern (useValidateWorkflow.test.tsx); here it answers on demand.
const validate = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useValidateWorkflow', () => ({
  useValidateWorkflow: () => ({ mutateAsync: validate }),
}));

const CLEAN: ValidateWorkflowResult = { issues: [], ok: true };
beforeEach(() => {
  validate.mockReset();
  validate.mockResolvedValue(CLEAN);
});

/** Click and let the server answer settle. */
async function check() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check workflow' }));
  });
}

const GOOD: WorkflowSpec = {
  description: 'good',
  entry: 'end',
  name: 'good',
  nodes: { end: { status: 'SUCCESS', type: 'terminate' } },
  schemaVersion: 1,
};

// A cond that routes to a node that does not exist, and no terminate node: errors.
const BAD: WorkflowSpec = {
  description: 'bad',
  entry: 'c',
  name: 'bad',
  nodes: { c: { expr: 'true', onFalse: 'nowhere', onTrue: 'nowhere', type: 'cond' } },
  schemaVersion: 1,
};

function renderEditor(spec: WorkflowSpec) {
  const props = {
    onChange: vi.fn(),
    onSelect: vi.fn(),
    selectedNodeId: null,
    spec,
    stepRegistry: [],
  };
  const view = render(<TemplateEditor {...props} />);
  return { ...view, props };
}

const MISSING_AGENT = {
  code: 'AGENT_NOT_FOUND',
  field: 'agentRef',
  message: "agent 'ghost' not found",
  nodeId: 'a',
  severity: 'warning' as const,
  source: 'refs' as const,
};

const WITH_AGENT: WorkflowSpec = {
  description: 'x',
  entry: 'a',
  name: 'x',
  nodes: {
    a: { agentRef: 'ghost', next: 'end', type: 'agent' },
    end: { status: 'SUCCESS', type: 'terminate' },
  },
  schemaVersion: 1,
};

const EMPTY_AGENT_REF: WorkflowSpec = {
  description: 'x',
  entry: 'a',
  name: 'x',
  nodes: {
    a: { agentRef: '', next: 'end', type: 'agent' },
    end: { status: 'SUCCESS', type: 'terminate' },
  },
  schemaVersion: 1,
};

function deferred() {
  let resolve: (r: ValidateWorkflowResult) => void = () => {};
  const promise = new Promise<ValidateWorkflowResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Check workflow', () => {
  it('says nothing until asked, then reports clean only after the server also answered clean', async () => {
    renderEditor(GOOD);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    expect(validate).not.toHaveBeenCalled();
    await check();
    expect(status.textContent).toBe(
      "No problems found by the editor's checks or the server's save checks. This does not run the workflow."
    );
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('sends the spec with the template and team, and only after the click', async () => {
    const props = {
      onChange: vi.fn(),
      onSelect: vi.fn(),
      selectedNodeId: null,
      spec: GOOD,
      stepRegistry: [],
    };
    render(<TemplateEditor {...props} teamId="team-1" templateId="tpl-1" />);
    expect(validate).not.toHaveBeenCalled();
    await check();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith({ spec: GOOD, teamId: 'team-1', templateId: 'tpl-1' });
  });

  it('omits scope ids the page does not have (a platform-wide template has no team)', async () => {
    renderEditor(GOOD);
    await check();
    expect(validate).toHaveBeenCalledWith({ spec: GOOD });
  });

  it('shows a pending message in the live region while the server is asked', async () => {
    const d = deferred();
    validate.mockReturnValue(d.promise);
    renderEditor(GOOD);
    fireEvent.click(screen.getByRole('button', { name: 'Check workflow' }));
    expect(screen.getByRole('status').textContent).toBe('Checking with the server…');
    expect(screen.getByRole('button', { name: 'Check workflow' }).getAttribute('aria-busy')).toBe(
      'true'
    );
    await act(async () => d.resolve(CLEAN));
    expect(screen.getByRole('status').textContent).toMatch(/^No problems found by the editor/);
  });

  it('counts errors and warnings, opens the issues panel and moves focus into it', async () => {
    const { container } = renderEditor(BAD);
    const details = container.querySelector('details') as HTMLDetailsElement;
    details.open = false;
    await check();
    expect(screen.getByRole('status').textContent).toMatch(/^\d+ errors?, \d+ warnings?\./);
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(details.querySelector('summary'));
  });

  it('merges a server-only finding into the same panel, marked "server" in text, and counts it', async () => {
    validate.mockResolvedValue({ issues: [MISSING_AGENT], ok: true });
    const { container } = renderEditor(WITH_AGENT);
    await check();
    expect(screen.getByRole('status').textContent).toMatch(/^0 errors, 1 warning\./);
    expect(screen.getByRole('status').textContent).not.toMatch(/No problems found/);
    const item = screen.getByRole('button', { name: /server: refs\s+AGENT_NOT_FOUND/ });
    expect(item.textContent).toContain("agent 'ghost' not found");
    expect(container.querySelector('details')?.contains(item)).toBe(true);
  });

  it('opens the panel and focuses it for a server-only finding when the editor found nothing', async () => {
    validate.mockResolvedValue({ issues: [MISSING_AGENT], ok: true });
    const { container } = renderEditor(WITH_AGENT);
    await check();
    const details = container.querySelector('details') as HTMLDetailsElement;
    // The panel opens once the server answer lands, which a fixed delay raced on a loaded runner.
    await waitFor(() => expect(details.open).toBe(true));
    expect(document.activeElement).toBe(details.querySelector('summary'));
  });

  it('selects the node when a server finding is clicked', async () => {
    validate.mockResolvedValue({ issues: [MISSING_AGENT], ok: true });
    const { props } = renderEditor(WITH_AGENT);
    await check();
    fireEvent.click(screen.getByRole('button', { name: /server: refs/ }));
    expect(props.onSelect).toHaveBeenCalledWith('a');
  });

  it('disables a server finding that names no node, or one that is gone', async () => {
    validate.mockResolvedValue({
      issues: [
        {
          code: 'SHELL_NOT_ALLOWED',
          message: 'not allowed',
          severity: 'error',
          source: 'authoring',
        },
        { ...MISSING_AGENT, nodeId: 'deleted' },
      ],
      ok: false,
    });
    const { props } = renderEditor(GOOD);
    await check();
    const items = screen.getAllByRole('button', { name: /server: / }) as HTMLButtonElement[];
    expect(items).toHaveLength(2);
    expect(items.every((b) => b.disabled)).toBe(true);
    fireEvent.click(items[0] as HTMLElement);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toMatch(/^1 error, 1 warning\./);
  });

  // The server's findings for each spec, with the codes/fields/nodeIds it really sends
  // (pinned by workflowTemplates.validate.test.ts "schema contract"). Each is also something the
  // editor finds itself, so adding the server's answer must change neither the list nor the count.
  const DONE = { status: 'SUCCESS', type: 'terminate' } as const;
  const specOf = (nodes: Record<string, unknown>, entry: string, extra = {}): WorkflowSpec =>
    ({ description: '', entry, name: 'x', nodes, schemaVersion: 1, ...extra }) as WorkflowSpec;
  const srv = (code: string, nodeId: string | undefined, field: string | undefined) => ({
    code,
    ...(field ? { field } : {}),
    message: 'worded differently by the server',
    ...(nodeId ? { nodeId } : {}),
    severity: 'error' as const,
    source: 'schema' as const,
  });
  const BOTH_REPORT: [string, WorkflowSpec, ReturnType<typeof srv>][] = [
    [
      'an internal step',
      specOf({ end: DONE, s: { next: 'end', step: 'runAgentTask', type: 'step' } }, 's'),
      srv('INTERNAL_STEP', 's', 'step'),
    ],
    [
      'an empty top-level name',
      specOf({ end: DONE }, 'end', { name: '' }),
      srv('SCHEMA_INVALID', undefined, 'name'),
    ],
    [
      'a missing entry',
      (() => {
        const sp = specOf({ end: DONE }, 'end') as unknown as Record<string, unknown>;
        delete sp.entry;
        return sp as unknown as WorkflowSpec;
      })(),
      srv('SCHEMA_INVALID', undefined, 'entry'),
    ],
    ['an empty agentRef', EMPTY_AGENT_REF, srv('SCHEMA_INVALID', 'a', 'agentRef')],
    [
      'a blank title',
      specOf({ end: { ...DONE, title: '  ' } }, 'end'),
      srv('INVALID_PRESENTATION', 'end', 'title'),
    ],
    [
      'a wrong schemaVersion',
      specOf({ end: DONE }, 'end', { schemaVersion: 0 }),
      srv('SCHEMA_VERSION', undefined, 'schemaVersion'),
    ],
    [
      'an unknown node type',
      specOf({ b: { next: 'end', type: 'bogus' }, end: DONE }, 'b'),
      srv('SCHEMA_INVALID', 'b', 'type'),
    ],
    [
      'a missing node type',
      specOf({ b: { next: 'end' }, end: DONE }, 'b'),
      srv('SCHEMA_INVALID', 'b', 'type'),
    ],
    [
      'an empty shell image',
      specOf({ end: DONE, sh: { command: 'x', image: '', next: 'end', type: 'shell' } }, 'sh'),
      srv('SCHEMA_INVALID', 'sh', 'image'),
    ],
  ];

  it.each(BOTH_REPORT)(
    'shows %s once, with the same count as the editor alone',
    async (_n, sp, serverIssue) => {
      const alone = renderEditor(sp);
      await check();
      const aloneCount = screen.getByRole('status').textContent;
      const aloneItems = screen.getAllByRole('listitem').length;
      expect(aloneCount).toMatch(/[1-9]\d* errors?/);
      alone.unmount();

      validate.mockResolvedValue({ issues: [serverIssue], ok: false });
      renderEditor(sp);
      await check();
      expect(screen.queryByRole('button', { name: /server: / })).toBeNull();
      expect(screen.getByRole('status').textContent).toBe(aloneCount);
      expect(screen.getAllByRole('listitem')).toHaveLength(aloneItems);
    }
  );

  it('keeps two distinct top-level server findings apart', async () => {
    validate.mockResolvedValue({
      issues: [srv('SCHEMA_INVALID', undefined, 'name'), srv('SCHEMA_INVALID', undefined, 'foo')],
      ok: false,
    });
    renderEditor(GOOD);
    await check();
    expect(screen.getAllByRole('button', { name: /server: / })).toHaveLength(2);
  });

  it('keeps client findings and says plainly that the server check could not run', async () => {
    validate.mockRejectedValue(new Error('Network down'));
    renderEditor(BAD);
    await check();
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toMatch(
      /^The server check could not run \(Network down\); showing the editor check only\. \d+ errors?/
    );
    expect(text).not.toMatch(/No problems found/);
    expect(screen.queryByRole('button', { name: /server: / })).toBeNull();
  });

  it('never reports a clean result when the server check could not run (403)', async () => {
    validate.mockRejectedValue(new ApiError('Forbidden', 403, 'FORBIDDEN'));
    renderEditor(GOOD);
    await check();
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toBe(
      'The server check could not run (you are not permitted to run it); showing the editor check only. The editor check found no problems. This does not run the workflow.'
    );
    expect(text).not.toMatch(/save checks/);
  });

  it('treats a malformed server answer as a failed check, not a clean one', async () => {
    validate.mockResolvedValue({});
    renderEditor(GOOD);
    await check();
    expect(screen.getByRole('status').textContent).toMatch(/^The server check could not run/);
  });

  it('does not call the server twice for two clicks on one spec while a check is running', async () => {
    const d = deferred();
    validate.mockReturnValue(d.promise);
    renderEditor(GOOD);
    const button = screen.getByRole('button', { name: 'Check workflow' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(validate).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve(CLEAN));
    // Once it has settled, a new click asks again.
    validate.mockResolvedValue(CLEAN);
    await check();
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('does not call the server on edits, only on the click', () => {
    const { rerender, props } = renderEditor(GOOD);
    act(() => {
      rerender(<TemplateEditor {...props} spec={{ ...GOOD, name: 'renamed' }} />);
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it('hides a stale result after an edit, and ignores the answer that arrives later', async () => {
    const d = deferred();
    validate.mockReturnValue(d.promise);
    const { rerender, props } = renderEditor(GOOD);
    fireEvent.click(screen.getByRole('button', { name: 'Check workflow' }));
    expect(screen.getByRole('status').textContent).toMatch(/Checking/);
    act(() => {
      rerender(<TemplateEditor {...props} spec={{ ...GOOD }} />);
    });
    expect(screen.getByRole('status').textContent).toBe('');
    await act(async () => d.resolve({ issues: [{ ...MISSING_AGENT, nodeId: 'end' }], ok: true }));
    expect(screen.getByRole('status').textContent).toBe('');
    expect(screen.queryByRole('button', { name: /server: / })).toBeNull();
  });

  it('hides a settled result once the spec has changed', async () => {
    const { rerender, props } = renderEditor(GOOD);
    await check();
    expect(screen.getByRole('status').textContent).toMatch(/No problems found/);
    act(() => {
      rerender(<TemplateEditor {...props} spec={{ ...GOOD }} />);
    });
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('asks again for an edited spec even while the earlier call is still pending', () => {
    validate.mockReturnValue(new Promise<ValidateWorkflowResult>(() => {}));
    const { rerender, props } = renderEditor(GOOD);
    fireEvent.click(screen.getByRole('button', { name: 'Check workflow' }));
    act(() => {
      rerender(<TemplateEditor {...props} spec={{ ...GOOD }} />);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check workflow' }));
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('reports a freshly dropped humanApproval node (blank title) as an error, not a clean result', async () => {
    const spec: WorkflowSpec = {
      description: 'x',
      entry: 'ask',
      name: 'x',
      nodes: {
        ask: {
          onApprove: 'end',
          onReject: 'end',
          onTimeout: 'end',
          timeout: '24h',
          title: '',
          type: 'humanApproval',
        },
        end: { status: 'SUCCESS', type: 'terminate' },
      },
      schemaVersion: 1,
    };
    expect(schemaIssues(spec).some((i) => i.nodeId === 'ask' && i.field === 'title')).toBe(true);
    const { props } = renderEditor(spec);
    await check();
    expect(screen.getByRole('status').textContent).toMatch(/^[1-9]\d* errors?,/);
    expect(screen.getByRole('status').textContent).not.toMatch(/No problems found/);
    // The issue is click-to-select.
    fireEvent.click(screen.getByRole('button', { name: /SCHEMA\s+ask\.title/ }));
    expect(props.onSelect).toHaveBeenCalledWith('ask');
  });

  it('reports an empty agentRef as an error', async () => {
    expect(
      schemaIssues(EMPTY_AGENT_REF).some((i) => i.nodeId === 'a' && i.field === 'agentRef')
    ).toBe(true);
    renderEditor(EMPTY_AGENT_REF);
    await check();
    expect(screen.getByRole('status').textContent).not.toMatch(/No problems found/);
  });

  it('a valid spec yields no schema issues', () => {
    expect(schemaIssues(GOOD)).toEqual([]);
  });

  it('re-announces on a repeated click by replacing the status text node', async () => {
    renderEditor(GOOD);
    await check();
    const first = screen.getByRole('status').firstElementChild;
    expect(first).not.toBeNull();
    await check();
    expect(screen.getByRole('status').firstElementChild).not.toBe(first);
  });
});
