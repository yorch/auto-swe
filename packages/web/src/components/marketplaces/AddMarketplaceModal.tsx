'use client';

import { useState } from 'react';
import {
  describeProfileError,
  keyed,
  locationLabel,
  type ProfileError,
  shortSha,
} from '@/components/harnessProfiles/profileDisplay';
import { parseRepositoryUrl } from '@/components/skills/AddSourceModal';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import {
  type MarketplaceLocation,
  type MarketplacePreview,
  useAddMarketplace,
  usePreviewMarketplace,
} from '@/hooks/useMarketplaces';
import { visibleText } from '@/lib/visibleText';
import { CatalogTable } from './CatalogTable';

const EMPTY: MarketplaceLocation = {
  host: 'github.com',
  owner: '',
  path: '',
  ref: 'main',
  repo: '',
};

/**
 * Add a marketplace: name the repository, preview its catalog (reads and validates; writes
 * nothing), then add it pinned to the exact commit you saw. A marketplace that moved since the
 * preview is refused and previewed again.
 */
export function AddMarketplaceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const preview = usePreviewMarketplace();
  const add = useAddMarketplace();
  const [form, setForm] = useState<MarketplaceLocation>(EMPTY);
  const [link, setLink] = useState('');
  const [previewed, setPreviewed] = useState<MarketplacePreview | null>(null);
  const [error, setError] = useState<ProfileError | null>(null);

  const location = (): MarketplaceLocation => ({
    host: form.host.trim(),
    owner: form.owner.trim(),
    path: form.path.trim(),
    ref: form.ref.trim(),
    repo: form.repo.trim(),
  });

  function close() {
    setForm(EMPTY);
    setLink('');
    setPreviewed(null);
    setError(null);
    onClose();
  }

  const applyLink = (text: string) => {
    const parsed = parseRepositoryUrl(text);
    if (parsed) {
      setForm((f) => ({ ...f, ...parsed }));
    }
  };

  async function runPreview(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    try {
      setPreviewed(await preview.mutateAsync(location()));
    } catch (err) {
      setPreviewed(null);
      setError(describeProfileError(err, 'Failed to read the marketplace'));
    }
  }

  async function runAdd() {
    if (!previewed) {
      return;
    }
    setError(null);
    try {
      await add.mutateAsync({ ...location(), sha: previewed.sha });
      close();
    } catch (err) {
      setError(describeProfileError(err, 'Failed to add the marketplace'));
    }
  }

  const valid = form.owner.trim() !== '' && form.repo.trim() !== '' && form.ref.trim() !== '';

  const errorAlert = error && (
    <Alert>
      {error.message}
      {error.lines.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {keyed(error.lines).map((l) => (
            <li key={l.key}>{l.text}</li>
          ))}
        </ul>
      )}
      {error.stale && previewed && (
        <div className="mt-2">
          <Button disabled={preview.isPending} onClick={() => runPreview()} size="sm">
            Preview again
          </Button>
        </div>
      )}
    </Alert>
  );

  if (previewed) {
    const catalog = previewed.catalog;
    return (
      <Modal
        onClose={close}
        open={open}
        size="lg"
        subtitle={`${locationLabel(previewed.source)} @ ${shortSha(previewed.sha)}`}
        title="Review marketplace"
      >
        <div className="space-y-4">
          <p className="text-xs text-paper-500">
            Nothing has been added yet. Adding pins the marketplace to this commit; a newer commit
            is only flagged, and you review it before the pin moves. Plugins are approved one at a
            time afterwards.
          </p>
          {previewed.existingId && (
            <Alert variant="error">
              This marketplace is already added. Close this dialog and open it from the list.
            </Alert>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-paper-500">Name</dt>
            <dd className="font-medium text-paper-100">{visibleText(catalog.name)}</dd>
            {catalog.ownerName && (
              <>
                <dt className="text-paper-500">Owner</dt>
                <dd className="text-paper-300">{visibleText(catalog.ownerName)}</dd>
              </>
            )}
            <dt className="text-paper-500">Commit</dt>
            <dd className="font-mono text-xs text-paper-300" title={previewed.sha}>
              {visibleText(previewed.sha)}
            </dd>
          </dl>
          <CatalogTable entries={catalog.entries} />
          {errorAlert}
          <ModalFooter
            disabled={previewed.existingId !== null}
            isPending={add.isPending}
            onCancel={() => {
              setPreviewed(null);
              setError(null);
            }}
            onSubmit={runAdd}
            pendingLabel="Adding…"
            submitLabel="Add marketplace"
          >
            <span className="text-xs text-paper-500">Cancel goes back to the form</span>
          </ModalFooter>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={close} open={open} title="Add marketplace">
      <form className="space-y-4" onSubmit={runPreview}>
        <Input
          hint="Paste a link to the repository or to the folder that holds .claude-plugin/marketplace.json"
          id="marketplace-url"
          label="GitHub link"
          onBlur={() => applyLink(link)}
          onChange={(e) => setLink(e.target.value)}
          onPaste={(e) => applyLink(e.clipboardData.getData('text'))}
          placeholder="https://github.com/owner/repo"
          value={link}
        />
        <Input
          id="marketplace-host"
          label="Host"
          onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
          required
          value={form.host}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            id="marketplace-owner"
            label="Owner"
            onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value }))}
            required
            value={form.owner}
          />
          <Input
            id="marketplace-repo"
            label="Repository"
            onChange={(e) => setForm((f) => ({ ...f, repo: e.target.value }))}
            required
            value={form.repo}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            hint="Folder holding .claude-plugin/marketplace.json; empty is the repository root"
            id="marketplace-path"
            label="Path"
            onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))}
            value={form.path}
          />
          <Input
            hint="Branch or tag; it is resolved to the exact commit you review"
            id="marketplace-ref"
            label="Ref"
            onChange={(e) => setForm((f) => ({ ...f, ref: e.target.value }))}
            required
            value={form.ref}
          />
        </div>
        {errorAlert}
        <ModalFooter
          disabled={!valid}
          isPending={preview.isPending}
          onCancel={close}
          pendingLabel="Reading catalog…"
          submitLabel="Preview"
        />
      </form>
    </Modal>
  );
}
