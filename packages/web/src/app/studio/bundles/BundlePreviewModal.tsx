'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import type { BundleInstallResult, BundlePreview, BundlePreviewEntry } from '@/hooks/useBundles';
import { errMsg } from '@/lib/errors';

const SECTIONS: Array<{ key: keyof BundlePreview['entities']; label: string }> = [
  { key: 'agents', label: 'Agents' },
  { key: 'skills', label: 'Skills' },
  { key: 'scannerPatterns', label: 'Scanner rules' },
  { key: 'templates', label: 'Workflow templates' },
];

function EntryList({ entries, label }: { entries: BundlePreviewEntry[]; label: string }) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <div>
      <div className="label-mono mb-1">
        {label} ({entries.length})
      </div>
      <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
        {entries.map((e) => (
          <li className="flex items-center gap-2" key={e.name}>
            <Badge tone={e.action === 'create' ? 'moss' : 'amber'} variant="text">
              {e.action === 'create' ? 'New' : 'Replaces'}
            </Badge>
            <span className="min-w-0 break-words font-mono text-paper-200">{e.name}</span>
            {e.protected && (
              <Badge tone="brick" variant="text">
                built-in or admin-authored
              </Badge>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What an install will do, shown before it happens: the bundle's trust state and signer, every
 * entry it creates or replaces, and any scanner findings in its skills. An unverified bundle needs
 * a second, explicit confirmation, and replacing built-in or admin-authored content needs a ticked
 * box. Skills from a bundle always install unverified.
 */
export function BundlePreviewModal({
  onClose,
  onInstall,
  preview,
}: {
  onClose: () => void;
  onInstall: (overwriteProtected: boolean) => Promise<BundleInstallResult>;
  preview: BundlePreview;
}) {
  const [overwrite, setOverwrite] = useState(false);
  const [confirmUnverified, setConfirmUnverified] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const protectedCount = SECTIONS.reduce(
    (n, s) => n + preview.entities[s.key].filter((e) => e.protected).length,
    0
  );
  const total = SECTIONS.reduce((n, s) => n + preview.entities[s.key].length, 0);
  const unverified = preview.trustState === 'UNVERIFIED';
  const blocked = preview.blockedReason !== null || (protectedCount > 0 && !overwrite);

  async function install() {
    setPending(true);
    setError(null);
    try {
      await onInstall(overwrite);
      setConfirmUnverified(false);
      onClose();
    } catch (e) {
      setConfirmUnverified(false);
      setError(errMsg(e, 'Install failed'));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Modal
        dismissible={!pending}
        onClose={onClose}
        open
        size="lg"
        subtitle={
          preview.installedVersion
            ? `Replaces the installed version ${preview.installedVersion}`
            : 'Not installed yet'
        }
        title={`Install ${preview.name} ${preview.version}?`}
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={unverified ? 'amber' : 'moss'} variant="outline">
              {unverified ? 'Unverified' : 'Verified'}
            </Badge>
            <span className="text-paper-400">
              {unverified
                ? 'No signature from a key this deployment trusts.'
                : `Signed by ${preview.signedBy ?? 'a trusted key'}.`}
            </span>
          </div>

          {preview.blockedReason && <Alert variant="error">{preview.blockedReason}</Alert>}
          {unverified && !preview.blockedReason && (
            <Alert variant="warning">
              This bundle comes from a source you have not verified. It can add agents, skills and
              scanner rules that change how runs behave. Its skills install as unverified.
            </Alert>
          )}

          {total === 0 ? (
            <p className="text-sm text-paper-400">This bundle contains no content.</p>
          ) : (
            <div className="space-y-3">
              {SECTIONS.map((s) => (
                <EntryList entries={preview.entities[s.key]} key={s.key} label={s.label} />
              ))}
            </div>
          )}

          {preview.warnings.length > 0 && (
            <Alert title="Scanner findings in skill text" variant="warning">
              <ul className="list-disc space-y-0.5 pl-4 text-xs">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Alert>
          )}

          {protectedCount > 0 && (
            <Checkbox
              checked={overwrite}
              hint="These are platform built-ins or content an admin wrote. Replacing them changes behavior for every team."
              label={`Replace ${protectedCount} built-in or admin-authored ${protectedCount === 1 ? 'entry' : 'entries'}`}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
          )}

          {error && <Alert>{error}</Alert>}
          <ModalFooter
            dangerous={unverified}
            disabled={blocked}
            isPending={pending}
            onCancel={onClose}
            onSubmit={() => (unverified ? setConfirmUnverified(true) : install())}
            pendingLabel="Installing…"
            submitLabel={unverified ? 'Install unverified bundle…' : 'Install bundle'}
          />
        </div>
      </Modal>
      <ConfirmModal
        confirmLabel="Install unverified bundle"
        dangerous
        message={`Install ${preview.name} ${preview.version} even though no trusted key signed it? Its content takes effect immediately and its skills install as unverified until someone reviews them.`}
        onClose={() => setConfirmUnverified(false)}
        onConfirm={install}
        open={confirmUnverified}
        pendingLabel="Installing…"
        title="Install an unverified bundle?"
      />
    </>
  );
}
