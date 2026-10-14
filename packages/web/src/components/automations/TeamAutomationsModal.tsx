'use client';

import { EventAutomationsPanel } from '@/components/automations/EventAutomationsPanel';
import { Modal, ModalFooter } from '@/components/ui/Modal';

/**
 * A team's event automations (docs/automations.md): those of sources whose automations belong
 * to a team rather than a repository. Opened from the Automations page.
 */
export function TeamAutomationsModal({
  team,
  onClose,
}: {
  team: { id: string; name: string };
  onClose: () => void;
}) {
  return (
    <Modal
      eyebrow="Automations"
      onClose={onClose}
      open
      size="lg"
      subtitle="When an event arrives for this team and an automation matches, the platform starts its template. These automations belong to the team, not to a repository."
      title={team.name}
    >
      <EventAutomationsPanel owner={{ teamId: team.id }} />
      <ModalFooter cancelLabel="Close" onCancel={onClose} />
    </Modal>
  );
}
