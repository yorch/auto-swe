'use client';

import { useState } from 'react';
import { parseRepositoryUrl } from '@/components/skills/AddSourceModal';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import {
  type HarnessProfileLocation,
  type HarnessProfilePreview,
  useCreateProfile,
  usePreviewProfile,
  useReviewProfileFile,
} from '@/hooks/useHarnessProfiles';
import { visibleText } from '@/lib/visibleText';
import { ProfilePreview } from './ProfilePreview';
import {
  describeProfileError,
  keyed,
  locationLabel,
  type ProfileError,
  shortSha,
} from './profileDisplay';

const EMPTY: HarnessProfileLocation = {
  host: 'github.com',
  owner: '',
  path: '',
  ref: 'main',
  repo: '',
};

/**
 * Add a profile: name the folder, preview it (reads, validates and scans; writes nothing), read
 * the files, acknowledge any warnings, approve. The approval names the previewed commit and the
 * preview's `contentHash` and `warningsHash`; a repository, a scanner or a ref that moved since
 * is a 409 and a fresh preview.
 */
export function AddProfileModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const preview = usePreviewProfile();
  const reviewFile = useReviewProfileFile();
  const create = useCreateProfile();
  const [form, setForm] = useState<HarnessProfileLocation>(EMPTY);
  const [link, setLink] = useState('');
  const [previewed, setPreviewed] = useState<HarnessProfilePreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<ProfileError | null>(null);

  const location = (): HarnessProfileLocation => ({
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
    setAcknowledged(false);
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
    setAcknowledged(false);
    try {
      setPreviewed(await preview.mutateAsync(location()));
    } catch (err) {
      setPreviewed(null);
      setError(describeProfileError(err, 'Failed to read the folder'));
    }
  }

  async function runCreate() {
    if (!previewed) {
      return;
    }
    setError(null);
    try {
      await create.mutateAsync({
        ...location(),
        acknowledgeWarnings: acknowledged,
        contentHash: previewed.contentHash,
        sha: previewed.sha,
        warningsHash: previewed.warningsHash,
      });
      close();
    } catch (err) {
      setError(describeProfileError(err, 'Failed to approve the profile'));
    }
  }

  const formValid = form.owner.trim() !== '' && form.repo.trim() !== '' && form.ref.trim() !== '';

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
    const conflicts = previewed.conflicts;
    const needsAck = previewed.warnings.length > 0;
    return (
      <Modal
        onClose={close}
        open={open}
        size="lg"
        subtitle={`${locationLabel(previewed.source)} @ ${shortSha(previewed.sha)}`}
        title="Review profile"
      >
        <div className="space-y-4">
          <p className="text-xs text-paper-500">
            Nothing has been written yet. Hooks and scripts in a profile run commands inside the run
            container, so read the files before approving. Everything below comes from the
            repository.
          </p>
          <ProfilePreview
            key={`${previewed.sha}:${previewed.contentHash}`}
            onReadFile={(file) =>
              reviewFile.mutateAsync({ ...location(), file, sha: previewed.sha })
            }
            preview={previewed}
          />
          {conflicts.length > 0 && (
            <Alert variant="error">
              A profile named{' '}
              {conflicts
                .map((c) => `${visibleText(c.name)} (${c.status.toLowerCase()})`)
                .join(', ')}{' '}
              already exists. Names are compared case-insensitively and cannot be reused.
            </Alert>
          )}
          {needsAck && (
            <Checkbox
              checked={acknowledged}
              label={`I have read the ${previewed.warnings.length} warning(s) and the files, and approve this profile anyway`}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
          )}
          {errorAlert}
          <ModalFooter
            disabled={conflicts.length > 0 || (needsAck && !acknowledged)}
            isPending={create.isPending}
            onCancel={() => {
              setPreviewed(null);
              setError(null);
            }}
            onSubmit={runCreate}
            pendingLabel="Approving…"
            submitLabel="Approve profile"
          >
            <span className="text-xs text-paper-500">Cancel goes back to the form</span>
          </ModalFooter>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={close} open={open} title="Add harness profile">
      <form className="space-y-4" onSubmit={runPreview}>
        <Input
          hint="Paste a link to the repository or to the folder that holds profile.json"
          id="harness-profile-url"
          label="GitHub link"
          onBlur={() => applyLink(link)}
          onChange={(e) => setLink(e.target.value)}
          onPaste={(e) => applyLink(e.clipboardData.getData('text'))}
          placeholder="https://github.com/owner/repo/tree/main/profiles/review-kit"
          value={link}
        />
        <Input
          id="harness-profile-host"
          label="Host"
          onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
          required
          value={form.host}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            id="harness-profile-owner"
            label="Owner"
            onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value }))}
            required
            value={form.owner}
          />
          <Input
            id="harness-profile-repo"
            label="Repository"
            onChange={(e) => setForm((f) => ({ ...f, repo: e.target.value }))}
            required
            value={form.repo}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            hint="Folder holding profile.json; empty is the repository root"
            id="harness-profile-path"
            label="Path"
            onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))}
            value={form.path}
          />
          <Input
            hint="Branch or tag; it is resolved to the exact commit you review"
            id="harness-profile-ref"
            label="Ref"
            onChange={(e) => setForm((f) => ({ ...f, ref: e.target.value }))}
            required
            value={form.ref}
          />
        </div>
        {errorAlert}
        <ModalFooter
          disabled={!formValid}
          isPending={preview.isPending}
          onCancel={close}
          pendingLabel="Reading folder…"
          submitLabel="Preview"
        />
      </form>
    </Modal>
  );
}
