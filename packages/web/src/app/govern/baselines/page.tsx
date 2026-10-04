'use client';

import { useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  useCreateHumanErrorBaseline,
  useDeleteHumanErrorBaseline,
  useHumanErrorBaselines,
  useUserOrgs,
} from '@/hooks/useAdmin';
import { errMsg } from '@/lib/errors';
import { formatDate, formatPercent } from '@/lib/utils';

type BaselineForm = {
  domain: string;
  errorCount: string;
  outcomeType: string;
  orgId: string;
  sampleSize: string;
};

function CreateBaselineModal({
  onClose,
  open,
  orgs,
}: {
  onClose: () => void;
  open: boolean;
  orgs: { id: string; name: string }[];
}) {
  const [form, setForm] = useState<BaselineForm>({
    domain: '',
    errorCount: '',
    orgId: '',
    outcomeType: '',
    sampleSize: '',
  });
  // Falls back to the first org until one is picked. Derived, not seeded into
  // state: the modal mounts before `orgs` loads, so a seeded value stayed ''
  // and the request went out without an org.
  const orgId = form.orgId || (orgs[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateHumanErrorBaseline();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const sampleSize = Number(form.sampleSize);
    const errorCount = Number(form.errorCount);
    if (!Number.isInteger(sampleSize) || sampleSize < 1) {
      setError('Sample size must be a positive integer');
      return;
    }
    if (!Number.isInteger(errorCount) || errorCount < 0) {
      setError('Error count must be a non-negative integer');
      return;
    }
    if (errorCount > sampleSize) {
      setError('Error count cannot exceed sample size');
      return;
    }
    try {
      await create.mutateAsync({
        domain: form.domain.trim(),
        errorCount,
        orgId,
        outcomeType: form.outcomeType.trim() || null,
        sampleSize,
      });
      onClose();
      setForm({
        domain: '',
        errorCount: '',
        orgId: '',
        outcomeType: '',
        sampleSize: '',
      });
    } catch (err) {
      setError(errMsg(err, 'Failed to create baseline'));
    }
  }

  return (
    <Modal
      eyebrow="Admin / Baselines"
      onClose={onClose}
      open={open}
      title="New human error baseline"
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}
        <Combobox
          id="baseline-org"
          label="Organization"
          onChange={(v) => setForm((f) => ({ ...f, orgId: v }))}
          options={orgs.map((o) => ({ label: o.name, value: o.id }))}
          value={orgId}
        />
        <Input
          id="baseline-domain"
          label="Domain"
          onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))}
          placeholder="e.g. git_repo"
          required
          value={form.domain}
        />
        <Input
          hint="Optional narrower bucket"
          id="baseline-outcome-type"
          label="Outcome type"
          onChange={(e) => setForm((f) => ({ ...f, outcomeType: e.target.value }))}
          value={form.outcomeType}
        />
        <Input
          id="baseline-sample-size"
          label="Sample size"
          min={1}
          onChange={(e) => setForm((f) => ({ ...f, sampleSize: e.target.value }))}
          required
          step={1}
          type="number"
          value={form.sampleSize}
        />
        <Input
          id="baseline-error-count"
          label="Errors found"
          min={0}
          onChange={(e) => setForm((f) => ({ ...f, errorCount: e.target.value }))}
          required
          step={1}
          type="number"
          value={form.errorCount}
        />
        <ModalFooter
          isPending={create.isPending}
          onCancel={onClose}
          pendingLabel="Creating…"
          submitLabel="Create baseline"
        />
      </form>
    </Modal>
  );
}

export default function GovernBaselinesPage() {
  const [newOpen, setNewOpen] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState<string>('all');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; domain: string } | null>(null);
  const deleteBaseline = useDeleteHumanErrorBaseline();
  const {
    data: orgs,
    isLoading: orgsLoading,
    isError: orgsIsError,
    refetch: refetchOrgs,
    error: orgsError,
  } = useUserOrgs();
  const {
    data: baselines,
    isLoading: baselinesLoading,
    isError: baselinesIsError,
    refetch,
    error: baselinesError,
  } = useHumanErrorBaselines(selectedOrgId === 'all' ? undefined : selectedOrgId);

  const orgOptions = useMemo(
    () => [{ id: 'all', name: 'All my organizations' }, ...(orgs ?? [])],
    [orgs]
  );

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            New baseline
          </Button>
        }
        chapter="§ Govern"
        subtitle="Manually-recorded human error rates that the analytics dashboard compares agent error rates against (the “vs human” column). Baselines are scoped to an organization and domain."
        title="Human error baselines"
      />

      <div className="max-w-xs">
        <Combobox
          disabled={orgsLoading}
          id="org-filter"
          label="Organization"
          onChange={setSelectedOrgId}
          options={orgOptions.map((o) => ({ label: o.name, value: o.id }))}
          value={selectedOrgId}
        />
      </div>

      <QueryBoundary
        error={orgsIsError ? orgsError : baselinesError}
        isError={orgsIsError || baselinesIsError}
        isLoading={orgsLoading || baselinesLoading}
        label="baselines"
        onRetry={() => void (orgsIsError ? refetchOrgs() : refetch())}
      >
        <Card>
          <CardHeader>
            <CardTitle>Recorded baselines</CardTitle>
          </CardHeader>
          {baselines?.length === 0 ? (
            <EmptyState title="No baselines recorded yet." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead className="text-left text-xs text-paper-400">
                  <Th variant="dense">Domain</Th>
                  <Th variant="dense">Outcome</Th>
                  <Th align="right" variant="dense">
                    Sample
                  </Th>
                  <Th align="right" variant="dense">
                    Errors
                  </Th>
                  <Th align="right" variant="dense">
                    Rate
                  </Th>
                  <Th align="right" variant="dense">
                    Recorded
                  </Th>
                  <Th variant="dense" />
                </THead>
                <tbody>
                  {(baselines ?? []).map((b) => (
                    <TRow key={b.id}>
                      <Td className="px-4 py-2">{b.domain}</Td>
                      <Td className="px-4 py-2 text-paper-400">{b.outcomeType ?? '—'}</Td>
                      <Td className="px-4 py-2 text-right tabular-nums">{b.sampleSize}</Td>
                      <Td className="px-4 py-2 text-right tabular-nums">{b.errorCount}</Td>
                      <Td className="px-4 py-2 text-right tabular-nums">
                        {formatPercent(b.errorRate)}
                      </Td>
                      <Td className="px-4 py-2 text-right tabular-nums">
                        {formatDate(b.recordedAt)}
                      </Td>
                      <Td className="px-4 py-2 text-right">
                        <Button onClick={() => setDeleteTarget(b)} size="sm" variant="danger">
                          Delete
                        </Button>
                      </Td>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Card>
      </QueryBoundary>

      <CreateBaselineModal
        onClose={() => setNewOpen(false)}
        open={newOpen}
        orgs={(orgs ?? []).map((o) => ({ id: o.id, name: o.name }))}
      />
      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message="This will remove the recorded baseline. It cannot be undone."
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await deleteBaseline.mutateAsync(deleteTarget.id);
          }
        }}
        open={deleteTarget !== null}
        pendingLabel="Deleting…"
        title={`Delete "${deleteTarget?.domain ?? ''}" baseline?`}
      />
    </div>
  );
}
