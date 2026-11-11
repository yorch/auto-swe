// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DagNode } from './dagNode';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const props: NodeProps = {
  data: { node: { next: 'done', step: 'runTests', type: 'step' } },
  deletable: false,
  draggable: false,
  dragging: false,
  id: 'tests',
  isConnectable: false,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
  selectable: true,
  selected: false,
  type: 'dag',
  zIndex: 0,
};

it('omits absent optional notes without rendering empty unkeyed chips', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { container } = render(<DagNode {...props} />);
  expect(container.querySelectorAll('.leading-4')).toHaveLength(0);
  expect(errors).not.toHaveBeenCalled();
});

it('retains configured flow notes', () => {
  render(
    <DagNode
      {...props}
      data={{
        node: {
          ...(props.data.node as object),
          maxVisits: 2,
          onFailure: { status: 'FAILED' },
          status: 'TESTING',
        },
      }}
    />
  );
  expect(screen.getByText('TESTING')).toBeTruthy();
  expect(screen.getByText('max 2 visits')).toBeTruthy();
  expect(screen.getByText('on failure: stop FAILED')).toBeTruthy();
});
