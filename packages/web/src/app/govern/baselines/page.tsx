'use client';

import {
  getWorkspaceProviderMetadata,
  isWorkspaceProviderType,
  listWorkspaceProviderTypes,
} from '@auto-swe/shared/lib/workspaceProviders';
import { useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { Toolbar } from '@/components/ui/Toolbar';
import {
  useCreateHumanErrorBaseline,
  useDeleteHumanErrorBaseline,
  useHumanErrorBaselines,
  useUserOrgs,
} from '@/hooks/useAdmin';
import { errMsg } from '@/lib/errors';
import { navLabel } from '@/lib/navigation';
import { formatDate, formatPercent, formatRelativeTime } from '@/lib/utils';

// Analytics groups a run by the workspace type of its template, so a baseline's domain must be one
// of those to be compared against anything.
const DOMAIN_OPTIONS = listWorkspaceProviderTypes().map((p) => ({ label: p.label, value: p.key }));

/** Analytics needs at least this many baseline cases before it compares (matches the analytics page). */
const MIN_BASELINE_SAMPLE = 30;

function domainLabel(domain: string): string {
  return isWorkspaceProviderType(domain) ? getWorkspaceProviderMetadata(domain).label : domain;
}

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
  const sampleN = Number(form.sampleSize);
  const errorN = Number(form.errorCount);
  const previewRate =
    form.sampleSize && form.errorCount && sampleN > 0 && errorN >= 0 && errorN <= sampleN
      ? errorN / sampleN
      : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.domain) {
      setError('Choose a domain');
      return;
    }
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
    <Modal eyebrow="Baselines" onClose={onClose} open={open} title="New human error baseline">
      <form className="space-y-4" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}
        <Combobox
          id="baseline-org"
          label="Organization"
          onChange={(v) => setForm((f) => ({ ...f, orgId: v }))}
          options={orgs.map((o) => ({ label: o.name, value: o.id }))}
          value={orgId}
        />
        <Select
          hint="The kind of work this baseline measures. Analytics compares agent runs of the same kind."
          id="baseline-domain"
          label="Domain"
          onChange={(v) => setForm((f) => ({ ...f, domain: v }))}
          options={DOMAIN_OPTIONS}
          placeholder="Choose a domain"
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            hint={`Cases a person handled. Analytics compares only from ${MIN_BASELINE_SAMPLE}.`}
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
            hint="How many of those cases had an error."
            id="baseline-error-count"
            label="Errors found"
            min={0}
            onChange={(e) => setForm((f) => ({ ...f, errorCount: e.target.value }))}
            required
            step={1}
            type="number"
            value={form.errorCount}
          />
        </div>
        {previewRate !== null && (
          <p className="text-[13px] text-paper-400" role="status">
            Human error rate:{' '}
            <span className="font-medium text-paper-100 tabular-nums">
              {formatPercent(previewRate)}
            </span>
          </p>
        )}
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
    isFetching: orgsIsFetching,
    refetch: refetchOrgs,
    error: orgsError,
  } = useUserOrgs();
  const {
    data: baselines,
    isLoading: baselinesLoading,
    isError: baselinesIsError,
    isFetching: baselinesIsFetching,
    refetch,
    error: baselinesError,
  } = useHumanErrorBaselines(selectedOrgId === 'all' ? undefined : selectedOrgId);

  const orgOptions = useMemo(
    () => [{ id: 'all', name: 'All my organizations' }, ...(orgs ?? [])],
    [orgs]
  );

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            <Icon name="plus" size={14} />
            New baseline
          </Button>
        }
        subtitle="Manually-recorded human error rates that the analytics dashboard compares agent error rates against (the “vs human” column). Baselines are scoped to an organization and domain."
        title={navLabel('/govern/baselines')}
      />

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Baselines">Recorded baselines</CardTitle>
        </CardHeader>
        <Toolbar
          end={
            baselines && baselines.length > 0 ? (
              <span className="text-xs text-paper-500 tabular-nums">
                {baselines.length} baseline{baselines.length === 1 ? '' : 's'}
              </span>
            ) : undefined
          }
        >
          <Select
            appearance="pill"
            aria-label="Organization"
            disabled={orgsLoading}
            id="org-filter"
            onChange={setSelectedOrgId}
            options={orgOptions.map((o) => ({ label: o.name, value: o.id }))}
            value={selectedOrgId}
          />
        </Toolbar>
        <QueryBoundary
          error={orgsIsError ? orgsError : baselinesError}
          isError={orgsIsError || baselinesIsError}
          isFetching={orgsIsFetching || baselinesIsFetching}
          isLoading={orgsLoading || baselinesLoading}
          label="baselines"
          loading={<SkeletonRows rows={3} />}
          onRetry={() => void (orgsIsError ? refetchOrgs() : refetch())}
        >
          {!baselines || baselines.length === 0 ? (
            <EmptyState
              action={
                <Button onClick={() => setNewOpen(true)} size="sm">
                  New baseline
                </Button>
              }
              hint="Record how often people get a kind of work wrong, so analytics can show whether agents do better or worse."
              icon="target"
              title="No baselines recorded yet"
            />
          ) : (
            <div className="-mx-4">
              <Table className="max-sm:px-4" stacked>
                <THead>
                  <Th variant="plain">Domain</Th>
                  <Th variant="plain">Outcome</Th>
                  <Th align="right" variant="plain">
                    Sample
                  </Th>
                  <Th align="right" variant="plain">
                    Errors
                  </Th>
                  <Th align="right" variant="plain">
                    Error rate
                  </Th>
                  <Th align="right" variant="plain">
                    Recorded
                  </Th>
                  <Th variant="plain">
                    <span className="sr-only">Actions</span>
                  </Th>
                </THead>
                <tbody>
                  {baselines.map((b) => (
                    <TRow hover key={b.id}>
                      <Td className="px-4 py-3 font-medium text-paper-100" primary>
                        {domainLabel(b.domain)}
                      </Td>
                      <Td className="px-4 py-3 text-paper-400" label="Outcome">
                        {b.outcomeType ?? '—'}
                      </Td>
                      <Td align="right" className="px-4 py-3 tabular-nums" label="Sample">
                        <span className="inline-flex items-center justify-end gap-2">
                          {b.sampleSize < MIN_BASELINE_SAMPLE && (
                            <Badge
                              title={`Analytics compares only from ${MIN_BASELINE_SAMPLE} cases`}
                              tone="amber"
                              variant="outline"
                            >
                              Too small to compare
                            </Badge>
                          )}
                          {b.sampleSize}
                        </span>
                      </Td>
                      <Td align="right" className="px-4 py-3 tabular-nums" label="Errors">
                        {b.errorCount}
                      </Td>
                      <Td
                        align="right"
                        className="px-4 py-3 font-medium text-paper-100 tabular-nums"
                        label="Error rate"
                      >
                        {formatPercent(b.errorRate)}
                      </Td>
                      <Td
                        align="right"
                        className="px-4 py-3 text-[13px] text-paper-400"
                        label="Recorded"
                      >
                        <time
                          className="whitespace-nowrap"
                          dateTime={b.recordedAt}
                          title={formatDate(b.recordedAt)}
                        >
                          {formatRelativeTime(b.recordedAt)}
                        </time>
                      </Td>
                      <Td align="right" className="px-4 py-3">
                        <Button
                          aria-label={`Delete ${domainLabel(b.domain)} baseline`}
                          className="px-2 text-paper-500 hover:text-brick-400"
                          onClick={() => setDeleteTarget(b)}
                          size="sm"
                          title="Delete baseline"
                          variant="ghost"
                        >
                          <Icon name="trash" size={14} />
                        </Button>
                      </Td>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </QueryBoundary>
      </Card>

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
        title={`Delete "${domainLabel(deleteTarget?.domain ?? '')}" baseline?`}
      />
    </div>
  );
}
