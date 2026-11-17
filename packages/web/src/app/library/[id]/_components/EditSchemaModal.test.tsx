// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';
import { EditSchemaModal } from './EditSchemaModal';

const { save } = vi.hoisted(() => ({ save: vi.fn(async (_body: unknown) => ({})) }));
vi.mock('@/hooks/useTemplates', () => ({
  useUpdateWorkflowTemplate: () => ({ isPending: false, mutateAsync: save }),
}));
beforeEach(stubDialogPrototype);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(onClose = vi.fn()) {
  render(<EditSchemaModal initialSchema={null} onClose={onClose} open templateId="t1" />);
  return onClose;
}

describe('EditSchemaModal', () => {
  it('disables Save with a reason while a key is blank', () => {
    setup();
    fireEvent.click(screen.getAllByRole('button', { name: 'Add field' })[0] as HTMLElement);
    expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(
      true
    );
    expect(screen.getByText('Every field needs a key.')).toBeTruthy();
  });

  it('explains why Save is disabled in preview and keeps rows across the round trip', () => {
    setup();
    fireEvent.click(screen.getAllByRole('button', { name: 'Add field' })[0] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Preview form' }));
    expect(screen.getByText('Switch to Fields to save.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fields' }));
    expect(screen.getAllByLabelText('Field key')).toHaveLength(1);
  });

  it('asks before discarding edits and closes straight away when clean', () => {
    const onClose = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Add field' })[0] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('states that changes apply to the active version', () => {
    setup();
    expect(screen.getByText(/apply to the active version immediately/)).toBeTruthy();
  });
});
