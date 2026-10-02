// @vitest-environment jsdom

import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeInspector } from './NodeInspector';

afterEach(cleanup);

/**
 * `title` and `group` are presentation-only. Editing them must touch nothing
 * else on the node — including the fields the inspector has no form for
 * (`retry`, `startToCloseTimeout`, an `{ expr }` binding), which only the raw
 * JSON shows.
 */

const STEP: SpecNode = {
  group: 'review loop',
  inputs: { codeResult: { expr: 'context.a ?? context.b' }, flag: { literal: true } },
  next: 'a',
  onError: 'continue',
  onFail: { retry: 2 },
  retry: { maximumAttempts: 3 },
  startToCloseTimeout: '10m',
  step: 'runReviewNetwork',
  title: 'Review network',
  type: 'step',
};

const APPROVAL: SpecNode = {
  group: 'approval',
  onApprove: 'a',
  onReject: 'a',
  onTimeout: 'a',
  timeout: '24h',
  title: 'Approve the change',
  type: 'humanApproval',
};

function renderInspector(node: SpecNode, onChangeNode = vi.fn()) {
  render(
    <NodeInspector
      allNodeIds={['n', 'a']}
      isEntry={false}
      knownGroups={['review loop', 'approval']}
      node={node}
      nodeId="n"
      onChangeNode={onChangeNode}
      onDelete={vi.fn()}
      onRename={vi.fn()}
      stepMeta={null}
      stepRegistry={[]}
    />
  );
  return onChangeNode;
}

const commit = (label: RegExp, value: string) => {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};

describe('NodeInspector title and group', () => {
  it('shows the current title and group', () => {
    renderInspector(STEP);
    expect((screen.getByLabelText(/^title/i) as HTMLInputElement).value).toBe('Review network');
    expect((screen.getByLabelText(/^group/i) as HTMLInputElement).value).toBe('review loop');
  });

  it('sets a new title and leaves every other field exactly as it was', () => {
    const onChangeNode = renderInspector(STEP);
    commit(/^title/i, 'Run the reviewers');
    expect(onChangeNode).toHaveBeenCalledTimes(1);
    expect(onChangeNode.mock.calls[0]?.[0]).toEqual({ ...STEP, title: 'Run the reviewers' });
  });

  it('sets a group on a node that had none', () => {
    const onChangeNode = renderInspector({ next: 'a', step: 'runLint', type: 'step' });
    commit(/^group/i, 'verify');
    expect(onChangeNode.mock.calls[0]?.[0]).toEqual({
      group: 'verify',
      next: 'a',
      step: 'runLint',
      type: 'step',
    });
  });

  it('removes the key when a title or group is cleared, rather than saving an empty string', () => {
    const onChangeNode = renderInspector(STEP);
    commit(/^title/i, '   ');
    const afterTitle = onChangeNode.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('title' in afterTitle).toBe(false);
    expect(afterTitle.group).toBe('review loop');

    commit(/^group/i, '');
    const afterGroup = onChangeNode.mock.calls[1]?.[0] as Record<string, unknown>;
    expect('group' in afterGroup).toBe(false);
  });

  it('trims what it saves, and saves nothing when nothing changed', () => {
    const onChangeNode = renderInspector(STEP);
    commit(/^title/i, '  Review network  ');
    expect(onChangeNode).not.toHaveBeenCalled();
    commit(/^group/i, '  CI loop ');
    expect(onChangeNode.mock.calls[0]?.[0]).toMatchObject({ group: 'CI loop' });
  });

  it('bounds both fields to the schema lengths', () => {
    renderInspector(STEP);
    expect((screen.getByLabelText(/^title/i) as HTMLInputElement).maxLength).toBe(80);
    expect((screen.getByLabelText(/^group/i) as HTMLInputElement).maxLength).toBe(40);
  });

  it('offers the groups already in the spec as suggestions', () => {
    renderInspector(STEP);
    const options = [...document.querySelectorAll('datalist option')].map((o) =>
      o.getAttribute('value')
    );
    expect(options).toEqual(['review loop', 'approval']);
  });

  it('keeps the inbox title of a human node REQUIRED: it can change but never be cleared', () => {
    const onChangeNode = renderInspector(APPROVAL);
    commit(/^title/i, '');
    expect(onChangeNode).not.toHaveBeenCalled();
    // The field snaps back to what the node still has.
    expect((screen.getByLabelText(/^title/i) as HTMLInputElement).value).toBe('Approve the change');

    commit(/^title/i, 'Sign off');
    expect(onChangeNode.mock.calls[0]?.[0]).toEqual({ ...APPROVAL, title: 'Sign off' });
  });

  it('gives a human node a longer title bound, since it is the inbox heading', () => {
    renderInspector(APPROVAL);
    expect((screen.getByLabelText(/^title/i) as HTMLInputElement).maxLength).toBe(200);
  });

  it('round-trips every field in the raw JSON, the ones with no form included', () => {
    renderInspector(STEP);
    fireEvent.click(screen.getByText('Raw JSON'));
    const shown = document.querySelector('details pre')?.textContent ?? '';
    expect(JSON.parse(shown)).toEqual(STEP);
  });
});
