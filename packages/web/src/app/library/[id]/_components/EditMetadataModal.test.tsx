// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';
import { EditMetadataModal } from './EditMetadataModal';

const { save } = vi.hoisted(() => ({ save: vi.fn(async (_body: unknown) => ({})) }));
vi.mock('@/hooks/useTemplates', () => ({
  useUpdateWorkflowTemplate: () => ({ isPending: false, mutateAsync: save }),
}));
beforeEach(stubDialogPrototype);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('review template metadata', () => {
  it('preserves automation kind when editing its name', async () => {
    render(
      <EditMetadataModal
        initialDescription=""
        initialEstimatedHumanTimeSavedMinutes={null}
        initialKind="automation"
        initialName="CI triage"
        isDefault={false}
        onClose={vi.fn()}
        open
        templateId="template-1"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'automation' }))
    );
  });
  it.each([null, 'review'] as const)(
    'saves changes to the review kind from %s',
    async (initialKind) => {
      render(
        <EditMetadataModal
          initialDescription=""
          initialEstimatedHumanTimeSavedMinutes={null}
          initialKind={initialKind}
          initialName="Review"
          isDefault={false}
          onClose={vi.fn()}
          open
          templateId="template-1"
        />
      );
      fireEvent.click(
        screen.getByRole('switch', { name: 'Review template (requires a source run)' })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() =>
        expect(save).toHaveBeenCalledWith(
          expect.objectContaining({ kind: initialKind === 'review' ? null : 'review' })
        )
      );
    }
  );
});
