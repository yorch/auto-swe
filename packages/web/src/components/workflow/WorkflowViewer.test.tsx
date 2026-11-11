// @vitest-environment jsdom

import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowViewer } from './WorkflowViewer';

vi.mock('./WorkflowDag', () => ({
  WorkflowDag: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <button onClick={() => onSelect('start')} type="button">
      Select graph node
    </button>
  ),
}));
const spec: WorkflowSpec = {
  description: 'Read-only inspection fixture',
  entry: 'start',
  name: 'test',
  nodes: {
    done: { status: 'SUCCESS', type: 'terminate' },
    start: { command: 'echo hello', image: 'alpine:3.22', next: 'done', type: 'shell' },
  },
  schemaVersion: 1,
};
function Harness() {
  const [selected, setSelected] = useState<string | null>(null);
  return <WorkflowViewer onSelect={setSelected} selectedNodeId={selected} spec={spec} />;
}
afterEach(cleanup);
describe('read-only workflow inspection', () => {
  it('reveals configuration without edit controls and closes without changing the definition', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Select graph node' }));
    expect(screen.getByRole('complementary', { name: 'Node details' })).toBeTruthy();
    expect(screen.getByText('echo hello')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove node' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary', { name: 'Node details' })).toBeNull();
    expect(spec.nodes.start.type).toBe('shell');
  });
  it('returns mobile focus to the node trigger after Escape', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Select graph node' });
    trigger.focus();
    fireEvent.click(trigger);
    const details = screen.getByRole('complementary', { name: 'Node details' });
    expect(document.activeElement).toBe(details);
    fireEvent.keyDown(details, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });
});
