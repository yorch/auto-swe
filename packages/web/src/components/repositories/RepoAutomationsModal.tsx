'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { EventAutomationsPanel } from '@/components/automations/EventAutomationsPanel';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { connectionLabel } from '@/lib/connectionDisplay';

/** What the dialog needs of a repository: the list rows carry no more than this. */
export type AutomationRepository = Pick<
  RepositorySummary,
  'id' | 'name' | 'organizationName' | 'repoName' | 'type'
>;

/**
 * A repository's event automations (docs/automations.md), opened from Connections: when
 * something happens on the repository — a GitHub Actions run fails — and an automation matches,
 * the platform starts its template.
 */
export function RepoAutomationsModal({
  repo,
  onClose,
}: {
  repo: AutomationRepository;
  onClose: () => void;
}) {
  return (
    <Modal
      eyebrow="Automations"
      onClose={onClose}
      open
      size="lg"
      subtitle="When something happens on this repository and an automation matches, the platform starts its template — for a failed CI run, a diagnosis and, in fix mode, a draft fix."
      title={connectionLabel(repo)}
    >
      <EventAutomationsPanel connectionId={repo.id} />
      <ModalFooter cancelLabel="Close" onCancel={onClose} />
    </Modal>
  );
}
