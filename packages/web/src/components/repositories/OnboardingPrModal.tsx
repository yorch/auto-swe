'use client';

import { MAX_ONBOARDING_TOOLS, OnboardingRequestSchema } from '@auto-swe/shared/lib/onboardingPr';
import { suggestedOnboardingTools } from '@auto-swe/shared/lib/stackDetection';
import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import {
  useOnboardingPrStatus,
  useOnboardingToolCatalog,
  useOpenOnboardingPr,
} from '@/hooks/useRepositoryOnboarding';
import { connectionLabel } from '@/lib/connectionDisplay';
import { errMsg } from '@/lib/errors';

export function OnboardingPrModal({
  repo,
  onClose,
}: {
  repo: RepositorySummary;
  onClose: () => void;
}) {
  const catalog = useOnboardingToolCatalog();
  const open = useOpenOnboardingPr(repo.id);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const status = useOnboardingPrStatus(repo.id, workflowId);
  const [includeTools, setIncludeTools] = useState(true);
  const [includePolicy, setIncludePolicy] = useState(true);
  const [selection, setSelection] = useState<string[] | null>(null);
  const [sensitivePaths, setSensitivePaths] = useState('**/auth/**\n**/migrations/**');
  const [error, setError] = useState<string | null>(null);
  const keys = catalog.data ?? [];
  const selected = (selection ?? suggestedOnboardingTools(repo.detectedStack, keys)).filter((k) =>
    keys.includes(k)
  );
  const result = status.data?.result;

  async function submit() {
    const parsed = OnboardingRequestSchema.safeParse({
      files: [
        ...(includeTools ? [{ kind: 'tools', tools: selected.map((key) => ({ key })) }] : []),
        ...(includePolicy
          ? [
              {
                kind: 'prPolicy',
                sensitivePaths: sensitivePaths
                  .split('\n')
                  .map((p) => p.trim())
                  .filter(Boolean),
              },
            ]
          : []),
      ],
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Choose at least one onboarding file.');
      return;
    }
    setError(null);
    try {
      setWorkflowId((await open.mutateAsync(parsed.data)).workflowId);
    } catch (err) {
      setError(errMsg(err, 'The onboarding pull request could not be started.'));
    }
  }

  return (
    <Modal onClose={onClose} open subtitle={connectionLabel(repo)} title="Open onboarding PR">
      {workflowId ? (
        <div aria-live="polite" className="space-y-3">
          {!status.data && !status.isError && <p>Waiting for onboarding status…</p>}
          {status.data?.status === 'running' && <p>Opening onboarding pull request…</p>}
          {status.isError && (
            <Alert variant="error">
              {errMsg(status.error, 'Onboarding status could not be loaded.')}
            </Alert>
          )}
          {status.data?.status === 'failed' && (
            <Alert variant="error">{status.data.error ?? 'Onboarding failed.'}</Alert>
          )}
          {result && (
            <p>
              {result.status === 'nothing_to_do'
                ? 'Nothing to do: the selected files already match.'
                : `Pull request ${result.status}.`}
            </p>
          )}
          {result?.pullRequestUrl && (
            <ButtonLink href={result.pullRequestUrl} rel="noopener noreferrer" target="_blank">
              View pull request
            </ButtonLink>
          )}
          <ModalFooter cancelLabel="Close" onCancel={onClose} />
        </div>
      ) : (
        <div className="space-y-4">
          {error && <Alert variant="error">{error}</Alert>}
          <Checkbox
            checked={includeTools}
            label="Include .auto-swe/tools.yml"
            onChange={(e) => setIncludeTools(e.target.checked)}
          />
          {includeTools && (
            <fieldset className="space-y-2" disabled={open.isPending}>
              <legend>
                Catalog tools ({selected.length}/{MAX_ONBOARDING_TOOLS})
              </legend>
              {catalog.isLoading && <p>Loading tools…</p>}
              {catalog.isError && (
                <Alert variant="error">
                  The tool catalog could not be loaded. Retry or exclude tools.yml.
                </Alert>
              )}
              {!catalog.isLoading && !catalog.isError && keys.length === 0 && (
                <p>No non-revoked catalog tools are available. Exclude tools.yml to continue.</p>
              )}
              {keys.map((key) => (
                <Checkbox
                  checked={selected.includes(key)}
                  disabled={!selected.includes(key) && selected.length >= MAX_ONBOARDING_TOOLS}
                  key={key}
                  label={key}
                  onChange={(e) =>
                    setSelection(
                      e.target.checked ? [...selected, key] : selected.filter((k) => k !== key)
                    )
                  }
                />
              ))}
            </fieldset>
          )}
          <Checkbox
            checked={includePolicy}
            label="Include .auto-swe/pr-policy.yml"
            onChange={(e) => setIncludePolicy(e.target.checked)}
          />
          {includePolicy && (
            <Textarea
              hint="One relative glob per line. These paths make pull request review stricter."
              label="Sensitive paths"
              onChange={(e) => setSensitivePaths(e.target.value)}
              value={sensitivePaths}
            />
          )}
          <ModalFooter
            disabled={
              (!includeTools && !includePolicy) ||
              (includeTools && (catalog.isLoading || catalog.isError || selected.length === 0))
            }
            isPending={open.isPending}
            onCancel={onClose}
            onSubmit={submit}
            submitLabel="Open onboarding PR"
          />
        </div>
      )}
    </Modal>
  );
}
