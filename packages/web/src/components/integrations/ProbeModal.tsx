'use client';

import { useEffect } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Icon } from '@/components/ui/Icon';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { type ProbeResult, useProbe } from '@/hooks/useConnectionTests';
import { errMsg } from '@/lib/errors';
import { cn } from '@/lib/utils';

/** The steps of a check, each with what it found. One step needs no list: the alert says it. */
export function ProbeChecks({ result }: { result: ProbeResult }) {
  if (result.checks.length < 2) {
    return null;
  }
  return (
    <ul className="mt-3 space-y-1.5 text-sm">
      {result.checks.map((check) => (
        <li className="flex items-start gap-2" key={check.name}>
          <Icon
            className={cn('mt-0.5 shrink-0', check.ok ? 'text-success-400' : 'text-danger-400')}
            name={check.ok ? 'checkCircle' : 'error'}
            size={14}
          />
          <span className="min-w-0 text-paper-300">
            <span className="font-medium text-paper-100">{check.name}</span>: {check.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Runs one connection's check as soon as it opens and shows what it found. Mount it only when the
 * person asked for the test: it sends a request to the connection's own host each time it runs.
 */
export function ProbeModal({
  onClose,
  path,
  subtitle,
  title,
}: {
  onClose: () => void;
  /** The gateway route that runs the check, e.g. `/api/v1/repositories/<id>/test-access`. */
  path: string;
  subtitle?: string;
  title: string;
}) {
  const probe = useProbe(path);
  const { mutate } = probe;
  useEffect(() => {
    mutate();
  }, [mutate]);

  return (
    <Modal onClose={onClose} open subtitle={subtitle} title={title}>
      <div aria-live="polite" className="space-y-3">
        {probe.isPending && <p className="text-sm text-paper-400">Checking…</p>}
        {probe.isError && <Alert>{errMsg(probe.error, 'The check could not be run.')}</Alert>}
        {probe.data && (
          <>
            <Alert variant={probe.data.ok ? 'success' : 'error'}>{probe.data.detail}</Alert>
            <ProbeChecks result={probe.data} />
          </>
        )}
      </div>
      <ModalFooter
        cancelLabel="Close"
        isPending={probe.isPending}
        onCancel={onClose}
        onSubmit={() => probe.mutate()}
        pendingLabel="Checking…"
        submitLabel="Run again"
      />
    </Modal>
  );
}
