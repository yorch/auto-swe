'use client';

import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
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
  const { data: templates, error, isError, isLoading } = useWorkflowTemplates(selectedTeamId);
  const [templateId, setTemplateId] = useState('');

  const runnable = (templates ?? []).filter(
    (t) => t.status === 'ACTIVE' && t.activeVersion !== null
  );
  const selected = runnable.find((t) => t.id === templateId);
  const canContinue = selected !== undefined;

  function handleContinue() {
    if (!canContinue) {
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
      title="Start a request"
    >
      <div className="space-y-6">
        <QueryBoundary
          error={error}
          isError={isError}
          isLoading={isLoading}
          label="templates"
          loadingMessage="loading templates…"
        >
          {runnable.length === 0 ? (
            <EmptyState
              hint={
                <>
                  Ask a lead or admin to create one in the{' '}
                  <Link className="text-ember-400 hover:underline" href="/workflows/library">
                    library
                  </Link>
                  .
                </>
              }
              title="No active templates."
            />
          ) : (
            <Select
              hint={selected?.description || 'Choose the workflow to run'}
              label="Template"
              onChange={(e) => setTemplateId(e.target.value)}
              value={templateId}
            >
              <option value="">Choose a template…</option>
              {runnable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          )}
        </QueryBoundary>

        <ModalFooter
          disabled={!canContinue}
          onCancel={onClose}
          onSubmit={handleContinue}
          submitLabel="Continue →"
        />
      </div>
    </Modal>
  );
}
