'use client';

import { useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  CALLBACK_EVENTS,
  type CallbackDeliveryRow,
  type CallbackEndpointInput,
  type CallbackEndpointRow,
  type CallbackEvent,
  useCallbackEndpointDeliveries,
  useCallbackEndpoints,
  useCreateCallbackEndpoint,
  useDeleteCallbackEndpoint,
  useRedeliverCallback,
  useRotateCallbackSecret,
  useUpdateCallbackEndpoint,
} from '@/hooks/useCallbackEndpoints';
import { errMsg } from '@/lib/errors';

const EVENT_LABELS: Record<CallbackEvent, string> = {
  'run.completed': 'Run completed',
  'run.waiting_for_human': 'Waiting for a human',
};

const EMPTY: CallbackEndpointInput = {
  allowPrivateNetwork: false,
  events: ['run.completed'],
  name: '',
  origin: '',
  pathPrefix: '/',
};

/**
 * The receivers this team's runs may report their outcome to (docs/run-callbacks.md).
 * A launch names one of these, or a URL under one; nothing else is accepted.
 */
export function TeamCallbackEndpointsSection({
  teamId,
  isPlatformAdmin,
}: {
  teamId: string;
  /** Only a platform admin may let an endpoint reach a private network. */
  isPlatformAdmin: boolean;
}) {
  const list = useCallbackEndpoints(teamId);
  const create = useCreateCallbackEndpoint(teamId);
  const update = useUpdateCallbackEndpoint(teamId);
  const rotate = useRotateCallbackSecret(teamId);
  const remove = useDeleteCallbackEndpoint(teamId);

  const [editing, setEditing] = useState<CallbackEndpointRow | 'new' | null>(null);
  const [form, setForm] = useState<CallbackEndpointInput>(EMPTY);
  const [formError, setFormError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [rotating, setRotating] = useState<CallbackEndpointRow | null>(null);
  const [deleting, setDeleting] = useState<CallbackEndpointRow | null>(null);
  const [history, setHistory] = useState<CallbackEndpointRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function openForm(row: CallbackEndpointRow | 'new') {
    setFormError(null);
    setForm(
      row === 'new'
        ? EMPTY
        : {
            allowPrivateNetwork: row.allowPrivateNetwork,
            events: row.events,
            name: row.name,
            origin: row.origin,
            pathPrefix: row.pathPrefix,
          }
    );
    setEditing(row);
  }

  async function submit() {
    setFormError(null);
    if (form.events.length === 0) {
      setFormError('Subscribe to at least one event.');
      return;
    }
    try {
      if (editing === 'new') {
        const res = await create.mutateAsync(form);
        setSecret({ name: res.data.name, value: res.secret });
      } else if (editing) {
        await update.mutateAsync({ id: editing.id, ...form });
      }
      setEditing(null);
    } catch (e) {
      setFormError(errMsg(e, 'Could not save the endpoint'));
    }
  }

  function toggleEvent(event: CallbackEvent, on: boolean) {
    setForm((f) => ({
      ...f,
      events: on ? [...new Set([...f.events, event])] : f.events.filter((e) => e !== event),
    }));
  }

  const rows = list.data ?? [];

  return (
    <Card className="p-4 sm:p-6">
      <CardHeader className="mb-2">
        <CardTitle eyebrow="Integrations">Run callbacks</CardTitle>
        <Button onClick={() => openForm('new')} size="sm" variant="secondary">
          <Icon name="plus" size={14} />
          Add endpoint
        </Button>
      </CardHeader>
      <p className="mb-4 text-sm text-paper-400">
        Where this team's runs may report their outcome. A launch names an endpoint, or a URL under
        one; every delivery is signed with the endpoint's secret.
      </p>
      {actionError && <Alert className="mb-3">{actionError}</Alert>}
      {list.isLoading || list.isError ? (
        <QueryBoundary
          error={list.error}
          isError={list.isError}
          isFetching={list.isFetching}
          isLoading={list.isLoading}
          label="callback endpoints"
          onRetry={() => void list.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          hint="Register a receiver's origin and path prefix to let runs report to it."
          title="No callback endpoints"
        />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Destination</Th>
              <Th>Events</Th>
              <Th>Secret</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>
            {rows.map((row) => (
              <TRow key={row.id}>
                <Td>
                  <span className="font-medium">{row.name}</span>
                  {row.disabled && (
                    <Badge className="ml-2" tone="muted">
                      Disabled
                    </Badge>
                  )}
                  {row.allowPrivateNetwork && (
                    <Badge className="ml-2" tone="amber">
                      Private network
                    </Badge>
                  )}
                </Td>
                <Td className="font-mono text-xs">
                  {row.origin}
                  {row.pathPrefix}
                </Td>
                <Td className="text-xs">{row.events.map((e) => EVENT_LABELS[e]).join(', ')}</Td>
                <Td className="font-mono text-xs">
                  …{row.secretLastFour}
                  {row.previousSecretExpiresAt && (
                    <span className="ml-2 font-sans text-paper-500">
                      previous until <RelativeTime value={row.previousSecretExpiresAt} />
                    </span>
                  )}
                </Td>
                <Td>
                  <div className="flex justify-end gap-2">
                    <Button onClick={() => setHistory(row)} size="sm" variant="ghost">
                      Deliveries
                    </Button>
                    <ActionMenu
                      items={[
                        { icon: 'edit', id: 'edit', label: 'Edit', onAction: () => openForm(row) },
                        {
                          icon: 'key',
                          id: 'rotate',
                          label: 'Rotate secret',
                          onAction: () => setRotating(row),
                        },
                        {
                          icon: row.disabled ? 'play' : 'pause',
                          id: 'toggle',
                          label: row.disabled ? 'Enable' : 'Disable',
                          onAction: () => {
                            setActionError(null);
                            update
                              .mutateAsync({ disabled: !row.disabled, id: row.id })
                              .catch((e) => setActionError(errMsg(e, 'Could not update')));
                          },
                        },
                        {
                          icon: 'error',
                          id: 'delete',
                          label: 'Delete',
                          onAction: () => setDeleting(row),
                          tone: 'danger',
                        },
                      ]}
                      label={`More actions for ${row.name}`}
                    />
                  </div>
                </Td>
              </TRow>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        onClose={() => setEditing(null)}
        open={editing !== null}
        title={editing === 'new' ? 'Add callback endpoint' : 'Edit callback endpoint'}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {formError && <Alert>{formError}</Alert>}
          <Input
            label="Name"
            maxLength={100}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            value={form.name}
          />
          <Input
            hint="Scheme, host and port only, such as https://hooks.example.com"
            label="Origin"
            onChange={(e) => setForm({ ...form, origin: e.target.value })}
            required
            value={form.origin}
          />
          <Input
            hint="A callback URL's path must be this path or sit under it"
            label="Path prefix"
            onChange={(e) => setForm({ ...form, pathPrefix: e.target.value })}
            value={form.pathPrefix ?? '/'}
          />
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm text-paper-300">Events</legend>
            {CALLBACK_EVENTS.map((event) => (
              <Checkbox
                checked={form.events.includes(event)}
                key={event}
                label={EVENT_LABELS[event]}
                onChange={(e) => toggleEvent(event, e.target.checked)}
              />
            ))}
          </fieldset>
          {(isPlatformAdmin || form.allowPrivateNetwork) && (
            <Checkbox
              checked={form.allowPrivateNetwork}
              disabled={!isPlatformAdmin && !form.allowPrivateNetwork}
              hint="Allows http and a private-network address for this origin. Loopback, link-local and metadata addresses stay refused."
              label="Reach a private network"
              onChange={(e) => setForm({ ...form, allowPrivateNetwork: e.target.checked })}
            />
          )}
          <ModalFooter
            isPending={create.isPending || update.isPending}
            onCancel={() => setEditing(null)}
            submitLabel={editing === 'new' ? 'Add endpoint' : 'Save'}
          />
        </form>
      </Modal>

      <Modal
        closeOnBackdropClick={false}
        onClose={() => setSecret(null)}
        open={secret !== null}
        subtitle="Copy it now: it is not shown again. Receivers verify X-AutoSwe-Signature with it."
        title={`Signing secret for ${secret?.name ?? ''}`}
      >
        <div className="flex items-center gap-2 rounded bg-ink-900 p-3 font-mono text-sm break-all">
          <span className="flex-1">{secret?.value}</span>
          {secret && <CopyButton value={secret.value} />}
        </div>
        <ModalFooter cancelLabel="Done" onCancel={() => setSecret(null)} />
      </Modal>

      <ConfirmModal
        confirmLabel="Rotate"
        message="A new secret signs every delivery from now on. The current one also signs deliveries for 24 hours, so receivers can switch over."
        onClose={() => setRotating(null)}
        onConfirm={async () => {
          if (rotating) {
            const res = await rotate.mutateAsync(rotating.id);
            setSecret({ name: res.data.name, value: res.secret });
          }
        }}
        open={rotating !== null}
        title="Rotate the signing secret?"
      />
      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message="Runs that named it stop reporting: their pending deliveries go dead. Delivery history is kept until it ages out."
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) {
            await remove.mutateAsync(deleting.id);
          }
        }}
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? 'endpoint'}?`}
      />
      <Modal
        onClose={() => setHistory(null)}
        open={history !== null}
        size="lg"
        title={`Deliveries to ${history?.name ?? ''}`}
      >
        {history && <EndpointDeliveries endpoint={history} teamId={teamId} />}
        <ModalFooter cancelLabel="Close" onCancel={() => setHistory(null)} />
      </Modal>
    </Card>
  );
}

function EndpointDeliveries({
  endpoint,
  teamId,
}: {
  endpoint: CallbackEndpointRow;
  teamId: string;
}) {
  const deliveries = useCallbackEndpointDeliveries(teamId, endpoint.id);
  if (deliveries.isLoading || deliveries.isError) {
    return (
      <QueryBoundary
        error={deliveries.error}
        isError={deliveries.isError}
        isFetching={deliveries.isFetching}
        isLoading={deliveries.isLoading}
        label="deliveries"
        onRetry={() => void deliveries.refetch()}
      />
    );
  }
  return <CallbackDeliveriesTable rows={deliveries.data?.data ?? []} showRun />;
}

const STATUS_TONE = { DEAD: 'brick', DELIVERED: 'moss', PENDING: 'amber' } as const;

/** Deliveries as a table, with redelivery where the caller manages the endpoint. */
export function CallbackDeliveriesTable({
  rows,
  showRun = false,
}: {
  rows: CallbackDeliveryRow[];
  showRun?: boolean;
}) {
  const redeliver = useRedeliverCallback();
  const [error, setError] = useState<string | null>(null);
  if (rows.length === 0) {
    return <EmptyState hint="Nothing has been sent yet." title="No deliveries" />;
  }
  return (
    <>
      {error && <Alert className="mb-3">{error}</Alert>}
      <Table>
        <THead>
          <tr>
            <Th>Event</Th>
            <Th>Status</Th>
            <Th>Last attempt</Th>
            {showRun && <Th>Run</Th>}
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </THead>
        <tbody>
          {rows.map((d) => (
            <TRow key={d.id}>
              <Td className="text-xs">
                {EVENT_LABELS[d.event] ?? d.event}
                <div className="font-mono text-paper-500">{d.id}</div>
              </Td>
              <Td>
                <Badge tone={STATUS_TONE[d.status]}>{d.status.toLowerCase()}</Badge>
                <div className="mt-1 text-xs text-paper-500">
                  {d.attempts} {d.attempts === 1 ? 'attempt' : 'attempts'}
                  {d.deadReason && ` · ${d.deadReason}`}
                  {d.status === 'PENDING' && d.nextAttemptAt && (
                    <>
                      {' · next '}
                      <RelativeTime value={d.nextAttemptAt} />
                    </>
                  )}
                </div>
              </Td>
              <Td className="text-xs">
                {d.lastAttemptAt ? <RelativeTime value={d.lastAttemptAt} /> : '—'}
                {(d.lastStatusCode !== null || d.lastError) && (
                  <div className="font-mono text-paper-500">
                    {d.lastStatusCode ?? ''} {d.lastError ?? ''}
                  </div>
                )}
              </Td>
              {showRun && (
                <Td className="text-xs">
                  <a className="underline" href={`/runs/${d.workflowRunId}`}>
                    View run
                  </a>
                </Td>
              )}
              <Td>
                {d.canRedeliver && d.endpoint && (
                  <Button
                    disabled={redeliver.isPending}
                    onClick={() => {
                      setError(null);
                      redeliver
                        .mutateAsync({
                          deliveryId: d.id,
                          endpointId: d.endpoint?.id ?? '',
                          teamId: d.endpoint?.teamId ?? '',
                        })
                        .catch((e) => setError(errMsg(e, 'Could not redeliver')));
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    <Icon name="refresh" size={14} />
                    Redeliver
                  </Button>
                )}
              </Td>
            </TRow>
          ))}
        </tbody>
      </Table>
    </>
  );
}
