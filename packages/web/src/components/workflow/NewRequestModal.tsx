'use client';

import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { useTeamStore } from '@/stores/teamStore';

export function NewRequestModal({
  onClose,
  onSelect,
  open,
}: {
  onClose: () => void;
  onSelect: (template: WorkflowTemplateSummary) => void;
  open: boolean;
}) {
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId);
  const { data: templates, isLoading } = useWorkflowTemplates(selectedTeamId);
  const [templateId, setTemplateId] = useState('');

  const selected = templates?.find((t) => t.id === templateId);

  function handleContinue() {
    if (!selected) {
      return;
    }
    onSelect(selected);
  }

  return (
    <Modal
      eyebrow="§ New request"
      onClose={onClose}
      open={open}
      subtitle="Pick a workflow template to launch. The next step fills the inputs the template expects."
      title="Start a request."
    >
      <div className="space-y-6">
        {isLoading ? (
          <LoadingState message="Loading templates…" />
        ) : (templates ?? []).length === 0 ? (
          <p className="text-sm text-paper-400">
            No active templates. Ask a lead or admin to create one in the{' '}
            <a className="text-ember-400 hover:underline" href="/workflows/library">
              library
            </a>
            .
          </p>
        ) : (
          <Select
            hint={selected?.description || 'Choose the workflow to run'}
            label="Template"
            onChange={(e) => setTemplateId(e.target.value)}
            value={templateId}
          >
            <option value="">Choose a template…</option>
            {(templates ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        )}

        <div className="flex items-center justify-end gap-3 border-t border-ink-600 pt-4">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={!selected} onClick={handleContinue} type="button" variant="primary">
            Continue →
          </Button>
        </div>
      </div>
    </Modal>
  );
}
