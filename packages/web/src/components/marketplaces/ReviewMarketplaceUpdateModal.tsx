'use client';

import { useEffect, useState } from 'react';
import {
  describeProfileError,
  keyed,
  type ProfileError,
  shortSha,
} from '@/components/harnessProfiles/profileDisplay';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import {
  type MarketplacePreview,
  type MarketplaceSourceDto,
  useAcceptMarketplaceUpdate,
  usePreviewMarketplace,
} from '@/hooks/useMarketplaces';
import { visibleText } from '@/lib/visibleText';
import { CatalogTable } from './CatalogTable';

/**
 * Review a marketplace update: the catalog at the newer commit is read (writing nothing), and
 * accepting moves the pin to exactly that commit. Plugins already approved are unaffected; each
 * is tracked and updated on its own.
 */
export function ReviewMarketplaceUpdateModal({
  onClose,
  source,
}: {
  source: MarketplaceSourceDto | null;
  onClose: () => void;
}) {
  const preview = usePreviewMarketplace();
  const accept = useAcceptMarketplaceUpdate();
  const [previewed, setPreviewed] = useState<MarketplacePreview | null>(null);
  const [error, setError] = useState<ProfileError | null>(null);
  const id = source?.id ?? null;
  const target = source?.latestSha ?? null;

  async function load() {
    if (!source || !target) {
      return;
    }
    setError(null);
    setPreviewed(null);
    try {
      setPreviewed(
        await preview.mutateAsync({
          host: source.host,
          owner: source.owner,
          path: source.path,
          ref: source.ref,
          repo: source.repo,
          sha: target,
        })
      );
    } catch (err) {
      setError(describeProfileError(err, 'Failed to read the update'));
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: reads when a different update is opened
  useEffect(() => {
    setPreviewed(null);
    setError(null);
    if (id && target) {
      void load();
    }
  }, [id, target]);

  async function runAccept() {
    if (!(source && previewed)) {
      return;
    }
    setError(null);
    try {
      await accept.mutateAsync({ id: source.id, sha: previewed.sha });
      onClose();
    } catch (err) {
      setError(describeProfileError(err, 'Failed to accept the update'));
    }
  }

  return (
    <Modal
      onClose={onClose}
      open={source !== null}
      size="lg"
      subtitle={
        source ? `${shortSha(source.pinnedSha)} → ${shortSha(source.latestSha)}` : undefined
      }
      title="Review marketplace update"
    >
      <div className="space-y-4">
        {!previewed && preview.isPending && (
          <p className="text-sm text-paper-400">Reading the catalog…</p>
        )}
        {previewed && (
          <>
            <p className="text-xs text-paper-500">
              Accepting moves this marketplace’s pin to {shortSha(previewed.sha)}. Plugins you
              already approved are not changed by it. This is the catalog at the new commit:{' '}
              {visibleText(previewed.catalog.name)}.
            </p>
            <CatalogTable entries={previewed.catalog.entries} />
          </>
        )}
        {error && (
          <Alert>
            {error.message}
            {error.lines.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {keyed(error.lines).map((l) => (
                  <li key={l.key}>{l.text}</li>
                ))}
              </ul>
            )}
            {error.stale && (
              <div className="mt-2">
                <Button disabled={preview.isPending} onClick={() => void load()} size="sm">
                  Preview again
                </Button>
              </div>
            )}
          </Alert>
        )}
        <ModalFooter
          disabled={!previewed}
          isPending={accept.isPending}
          onCancel={onClose}
          onSubmit={runAccept}
          pendingLabel="Accepting…"
          submitLabel="Accept update"
        />
      </div>
    </Modal>
  );
}
