'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import {
  useCreateHumanErrorBaseline,
  useDeleteHumanErrorBaseline,
  useHumanErrorBaselines,
  useUserOrgs,
} from '@/hooks/useAdmin';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';

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
    orgId: orgs[0]?.id ?? '',
    outcomeType: '',
    sampleSize: '',
  });
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
        orgId: form.orgId,
        outcomeType: form.outcomeType.trim() || null,
        sampleSize,
      });
      onClose();
      setForm({
        domain: '',
        errorCount: '',
        orgId: orgs[0]?.id ?? '',
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
      title="New Human Error Baseline"
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        {error && <p className="text-xs text-brick-400">{error}</p>}
        <FieldWrapper label="Organization">
          <Select
            onChange={(e) => setForm((f) => ({ ...f, orgId: e.target.value }))}
            value={form.orgId}
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </FieldWrapper>
        <FieldWrapper label="Domain">
          <Input
            onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))}
            placeholder="e.g. git_repo"
            required
            value={form.domain}
          />
        </FieldWrapper>
        <FieldWrapper hint="Optional narrower bucket" label="Outcome type">
          <Input
            onChange={(e) => setForm((f) => ({ ...f, outcomeType: e.target.value }))}
            value={form.outcomeType}
          />
        </FieldWrapper>
        <FieldWrapper label="Sample size">
          <Input
            min={1}
            onChange={(e) => setForm((f) => ({ ...f, sampleSize: e.target.value }))}
            required
            step={1}
            type="number"
            value={form.sampleSize}
          />
        </FieldWrapper>
        <FieldWrapper label="Errors found">
          <Input
            min={0}
            onChange={(e) => setForm((f) => ({ ...f, errorCount: e.target.value }))}
            required
            step={1}
            type="number"
            value={form.errorCount}
          />
        </FieldWrapper>
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={create.isPending} type="submit" variant="primary">
            {create.isPending ? 'Creating…' : 'Create Baseline'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteBaselineModal({
  baseline,
  onClose,
}: {
  baseline: { id: string; domain: string } | null;
  onClose: () => void;
}) {
  const del = useDeleteHumanErrorBaseline();
  const [error, setError] = useState<string | null>(null);

  if (!baseline) {
    return null;
  }

  async function handleDelete() {
    if (!baseline) {
      return;
    }
    setError(null);
    try {
      await del.mutateAsync(baseline.id);
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Failed to delete baseline'));
    }
  }

  return (
    <Modal onClose={onClose} open={!!baseline} title={`Delete "${baseline.domain}" baseline?`}>
      <div className="space-y-4">
        <p className="text-sm text-paper-400">
          This will remove the recorded baseline. It cannot be undone.
        </p>
        {error && <p className="text-xs text-brick-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={del.isPending} onClick={handleDelete} variant="danger">
            {del.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default function GovernBaselinesPage() {
  const [newOpen, setNewOpen] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState<string>('all');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; domain: string } | null>(null);
  const { data: orgs, isLoading: orgsLoading } = useUserOrgs();
  const { data: baselines, isLoading: baselinesLoading } = useHumanErrorBaselines(
    selectedOrgId === 'all' ? undefined : selectedOrgId
  );

  const orgOptions = useMemo(
    () => [{ id: 'all', name: 'All my organizations' }, ...(orgs ?? [])],
    [orgs]
  );

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            + New Baseline
          </Button>
        }
        subtitle="Manually-recorded human error rates used to compute errorRateVsHuman on the analytics dashboard. Baselines are scoped to an organization and domain."
        title="Human Error Baselines"
      />

      <div className="flex items-center gap-4">
        <label className="text-sm text-paper-400" htmlFor="org-filter">
          Organization
        </label>
        <Select
          disabled={orgsLoading}
          id="org-filter"
          onChange={(e) => setSelectedOrgId(e.target.value)}
          value={selectedOrgId}
        >
          {orgOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </div>

      {orgsLoading || baselinesLoading ? (
        <LoadingState />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Recorded baselines</CardTitle>
          </CardHeader>
          {baselines?.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-paper-400">No baselines recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-600 text-left text-xs text-paper-400">
                    <th className="px-4 py-2 font-medium">Domain</th>
                    <th className="px-4 py-2 font-medium">Outcome</th>
                    <th className="px-4 py-2 font-medium text-right">Sample</th>
                    <th className="px-4 py-2 font-medium text-right">Errors</th>
                    <th className="px-4 py-2 font-medium text-right">Rate</th>
                    <th className="px-4 py-2 font-medium text-right">Recorded</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {(baselines ?? []).map((b) => (
                    <tr className="border-b border-ink-600 last:border-0" key={b.id}>
                      <td className="px-4 py-2">{b.domain}</td>
                      <td className="px-4 py-2 text-paper-400">{b.outcomeType ?? '—'}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{b.sampleSize}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{b.errorCount}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {(b.errorRate * 100).toFixed(1)}%
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatDate(b.recordedAt)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Button onClick={() => setDeleteTarget(b)} size="sm" variant="danger">
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <CreateBaselineModal
        onClose={() => setNewOpen(false)}
        open={newOpen}
        orgs={(orgs ?? []).map((o) => ({ id: o.id, name: o.name }))}
      />
      <DeleteBaselineModal baseline={deleteTarget} onClose={() => setDeleteTarget(null)} />
    </div>
  );
}
