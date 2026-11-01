'use client';

import Link from 'next/link';
import { useState } from 'react';
import { IntegrationCard } from '@/components/integrations/IntegrationCard';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  type HealthEntry,
  type HealthStatus,
  useConnectionHealth,
} from '@/hooks/useConnectionTests';
import { errMsg } from '@/lib/errors';

const TONE: Record<HealthStatus, BadgeTone> = { failed: 'danger', ok: 'success', skipped: 'muted' };
const LABEL: Record<HealthStatus, string> = {
  failed: 'Failing',
  ok: 'Working',
  skipped: 'Skipped',
};

/** Failures first, then what works, then what was skipped; the gateway's order within each. */
const ORDER: Record<HealthStatus, number> = { failed: 0, ok: 1, skipped: 2 };

function summarize(entries: HealthEntry[]): string {
  const failing = entries.filter((e) => e.status === 'failed').length;
  const working = entries.filter((e) => e.status === 'ok').length;
  if (failing > 0) {
    return `${failing} of ${failing + working} configured connections ${failing === 1 ? 'is' : 'are'} failing.`;
  }
  return working === 0
    ? 'Nothing is configured to test yet.'
    : `All ${working} configured connection${working === 1 ? '' : 's'} work.`;
}

/**
 * Runs every stored connection's own check — the same ones the per-connection "Test connection"
 * buttons run — and lists what each found. Nothing runs until the button is pressed: each check
 * sends a request to that connection's host.
 */
export function ConnectionHealthPanel() {
  const health = useConnectionHealth();
  const [ticket, setTicket] = useState('');
  const entries = [...(health.data ?? [])].sort((a, b) => ORDER[a.status] - ORDER[b.status]);

  return (
    <IntegrationCard
      description="Check every configured connection at once: the integrations, per-host GitHub credentials, package registries and model-provider keys. A repository's access is checked from its own row on the Connections page."
      footer={
        <div className="flex flex-wrap items-end gap-3">
          <Button
            disabled={health.isPending}
            onClick={() => health.mutate(ticket.trim() || undefined)}
            type="button"
            variant="primary"
          >
            {health.isPending ? 'Testing…' : 'Test all connections'}
          </Button>
          <div className="w-56">
            <Input
              aria-label="A ticket for the issue tracker to fetch"
              compact
              onChange={(e) => setTicket(e.target.value)}
              placeholder="Ticket, e.g. PAY-123 (optional)"
              value={ticket}
            />
          </div>
        </div>
      }
      title="Connection health"
    >
      <div aria-live="polite">
        {health.isError && <Alert>{errMsg(health.error, 'The checks could not be run.')}</Alert>}
        {health.data && (
          <>
            <p className="mb-3 text-sm text-paper-200">{summarize(health.data)}</p>
            <ul className="divide-y divide-ink-600 rounded-lg border border-ink-600">
              {entries.map((entry) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2.5"
                  key={entry.id}
                >
                  <div className="min-w-0">
                    <Link
                      className="text-sm font-medium text-paper-100 hover:underline"
                      href={entry.href}
                    >
                      {entry.label}
                    </Link>
                    <p className="text-xs text-paper-400">{entry.detail}</p>
                  </div>
                  <Badge dot tone={TONE[entry.status]}>
                    {LABEL[entry.status]}
                  </Badge>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </IntegrationCard>
  );
}
