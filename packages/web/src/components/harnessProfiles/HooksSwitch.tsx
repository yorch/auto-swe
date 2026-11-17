'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useHarnessProfile, usePatchProfile } from '@/hooks/useHarnessProfiles';
import { ApiError } from '@/lib/api';
import { errMsg } from '@/lib/errors';
import { visibleText } from '@/lib/visibleText';
import { AutoRunSources, HOOKS_REVIEWED_LABEL } from './AutoRunSources';

/**
 * A plugin's hook switch (platform ADMIN). Either direction asks first: hooks run commands in the
 * run container with the agent's authority, and turning them off does not remove the scripts.
 * Turning them on shows the hook sources of the latest version, needs an explicit "reviewed" box
 * and sends the version shown, so a version that landed meanwhile is refused (409) and re-shown.
 * The change is audited, needs no new version and applies to runs that start afterwards.
 */
export function HooksSwitch({ enabled, name }: { name: string; enabled: boolean }) {
  const patch = usePatchProfile();
  const detail = useHarnessProfile(name);
  const [confirming, setConfirming] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const label = visibleText(name);

  const close = () => {
    setConfirming(false);
    setReviewed(false);
    setStale(false);
  };

  async function turnOn() {
    const version = detail.data?.latestVersion;
    if (version === undefined) {
      return;
    }
    setStale(false);
    try {
      await patch.mutateAsync({ expectedVersion: version, hooksEnabled: true, name });
      close();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'HOOKS_VERSION_STALE') {
        // A newer version landed: load it and make the admin read its sources again.
        setReviewed(false);
        setStale(true);
        await detail.refetch();
      } else {
        setError(errMsg(err, 'Failed to change the hook switch'));
        close();
      }
    }
  }

  const toggle = (
    <ToggleSwitch
      ariaLabel={`Hooks for ${label}`}
      checked={enabled}
      disabled={patch.isPending}
      label={enabled ? 'Hooks on' : 'Hooks off'}
      onChange={() => {
        setError(null);
        setReviewed(false);
        setStale(false);
        setConfirming(true);
      }}
      title={enabled ? 'Turn hooks off' : 'Turn hooks on'}
    />
  );

  if (enabled) {
    return (
      <div className="space-y-2">
        {toggle}
        {error && <Alert variant="error">{error}</Alert>}
        <ConfirmModal
          confirmLabel="Turn hooks off"
          dangerous
          message={
            <p>
              With hooks off, “{label}” writes no hook configs into the container of new runs.
              Scripts and executable files in the plugin are still written, so the switch does not
              remove them. The change applies to runs that start afterwards and is recorded in the
              audit log.
            </p>
          }
          onClose={close}
          onConfirm={async () => {
            try {
              await patch.mutateAsync({ hooksEnabled: false, name });
            } catch (err) {
              setError(errMsg(err, 'Failed to change the hook switch'));
            }
          }}
          open={confirming}
          pendingLabel="Saving…"
          title={`Turn hooks off for "${label}"?`}
        />
      </div>
    );
  }

  const version = detail.data?.latestVersion;
  const ready = version !== undefined && !detail.isFetching;
  return (
    <div className="space-y-2">
      {toggle}
      {error && <Alert variant="error">{error}</Alert>}
      <Modal onClose={close} open={confirming} size="lg" title={`Turn hooks on for "${label}"?`}>
        <div className="space-y-3">
          <p className="text-sm text-paper-300">
            Hooks run commands in the run container with the agent’s authority. With hooks on, “
            {label}” writes its hook configs into the container of every new run that uses it.
            Scripts and executable files are written whether hooks are on or off. The change applies
            to runs that start afterwards and is recorded in the audit log.
          </p>
          {stale && (
            <Alert variant="warning">
              A newer version of the plugin landed. Its hook sources are shown below; read them
              again.
            </Alert>
          )}
          {detail.isError && <Alert>Failed to load the hook sources.</Alert>}
          {ready && (
            <>
              <p className="text-xs text-paper-500">Version {version}</p>
              <AutoRunSources sources={detail.data?.autoRunSources ?? []} />
              <Checkbox
                checked={reviewed}
                label={HOOKS_REVIEWED_LABEL}
                onChange={(e) => setReviewed(e.target.checked)}
              />
            </>
          )}
          <ModalFooter
            disabled={!(ready && reviewed)}
            isPending={patch.isPending}
            onCancel={close}
            onSubmit={turnOn}
            pendingLabel="Saving…"
            submitLabel="Turn hooks on"
          />
        </div>
      </Modal>
    </div>
  );
}
