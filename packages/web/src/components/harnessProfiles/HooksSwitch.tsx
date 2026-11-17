'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { usePatchProfile } from '@/hooks/useHarnessProfiles';
import { errMsg } from '@/lib/errors';
import { visibleText } from '@/lib/visibleText';

/**
 * A plugin's hook switch (platform ADMIN). Either direction asks first: hooks run commands in the
 * run container with the agent's authority, and turning them off does not remove the scripts.
 * The change is audited, needs no new version and applies to runs that start afterwards.
 */
export function HooksSwitch({ enabled, name }: { name: string; enabled: boolean }) {
  const patch = usePatchProfile();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = visibleText(name);
  return (
    <div className="space-y-2">
      <ToggleSwitch
        ariaLabel={`Hooks for ${label}`}
        checked={enabled}
        disabled={patch.isPending}
        label={enabled ? 'Hooks on' : 'Hooks off'}
        onChange={() => {
          setError(null);
          setConfirming(true);
        }}
        title={enabled ? 'Turn hooks off' : 'Turn hooks on'}
      />
      {error && <Alert variant="error">{error}</Alert>}
      <ConfirmModal
        confirmLabel={enabled ? 'Turn hooks off' : 'Turn hooks on'}
        dangerous={!enabled}
        message={
          <div className="space-y-2">
            <p>
              Hooks run commands in the run container with the agent’s authority. With hooks on, “
              {label}” writes its hook configs into the container of every new run that uses it;
              with hooks off it does not.
            </p>
            <p>
              Scripts and executable files in the plugin are still written when hooks are off, so
              the switch does not remove them. The change applies to runs that start afterwards and
              is recorded in the audit log.
            </p>
          </div>
        }
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          try {
            await patch.mutateAsync({ hooksEnabled: !enabled, name });
          } catch (err) {
            setError(errMsg(err, 'Failed to change the hook switch'));
          }
        }}
        open={confirming}
        pendingLabel="Saving…"
        title={enabled ? `Turn hooks off for "${label}"?` : `Turn hooks on for "${label}"?`}
      />
    </div>
  );
}
