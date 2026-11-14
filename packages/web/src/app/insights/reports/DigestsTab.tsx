'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { ApiError, api } from '@/lib/api';
import { errMsg } from '@/lib/errors';

type Scope = { id: string; name: string; orgId?: string | null };
type Digest = {
  emailRecipients: string[];
  enabled: boolean;
  id: string;
  lastError: string | null;
  lastPeriodStart: string | null;
  lastTestError: string | null;
  organization: Scope | null;
  orgId: string | null;
  optedOutEmails: string[];
  scope: 'ORGANIZATION' | 'TEAM';
  slackChannel: { id: string; name: string } | null;
  slackChannelId: string | null;
  team: Scope | null;
  teamId: string | null;
};
type DigestData = {
  channels: Array<{ id: string; name: string; orgId: string | null; teamId: string | null }>;
  organizations: Scope[];
  subscriptions: Digest[];
  teams: Scope[];
};
type UpdateInput = {
  confirmOptedOutReadd?: string[];
  emailRecipients?: string[];
  id: string;
  enabled?: boolean;
  slackChannelId?: string | null;
};

/**
 * Readable text for each status code the digest sweep records in `lastError` (scheduled
 * runs) and `lastTestError` (send-test). A code not listed here is shown as it is.
 */
const DIGEST_ERRORS: Record<string, string> = {
  build_failed: 'The digest could not be built from the workflow-run rollups.',
  delivery_failed: 'The digest was built but could not be delivered.',
  email_failed: 'The test email could not be sent to at least one recipient.',
  org_wide_reports_disabled:
    'Organization-wide reports are turned off, so this digest was skipped.',
  period_out_of_order: 'An earlier digest covers a later period, so this digest was skipped.',
  period_too_soon:
    'The last digest was sent for a period too close to this one, so it was skipped.',
  recipients_out_of_scope:
    'No recipient is still an active member of the digest scope, so nothing was sent.',
  rollup_incomplete:
    'The workflow-run rollups for this period are incomplete, so it was not built.',
  slack_failed: 'The test message could not be posted to the Slack channel.',
};

function digestErrorText(code: string): string {
  return Object.hasOwn(DIGEST_ERRORS, code) ? DIGEST_ERRORS[code] : code;
}

function recipients(value: string) {
  return value
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
}

/** The write that re-adds one opted-out address and confirms it. */
function readdInput(digest: Digest, email: string): UpdateInput {
  return {
    confirmOptedOutReadd: [email],
    emailRecipients: [
      ...digest.emailRecipients,
      ...(!digest.emailRecipients.some(
        (recipient) => recipient.toLowerCase() === email.toLowerCase()
      )
        ? [email]
        : []),
    ],
    id: digest.id,
  };
}

/**
 * A failed request's message, with the addresses the gateway named beneath it, so the
 * person can see which recipients were refused and why.
 */
function ErrorDetail({ error }: { error: unknown }) {
  const addresses =
    error instanceof ApiError
      ? [
          ...(error.offendingAddresses ?? []).map((address) => ({ address, list: 'refused' })),
          ...(error.optedOutAddresses ?? []).map((address) => ({ address, list: 'opted-out' })),
        ]
      : [];
  return (
    <>
      <span>{errMsg(error, 'Request failed')}</span>
      {addresses.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          {addresses.map(({ address, list }) => (
            <li key={`${list}:${address}`}>{address}</li>
          ))}
        </ul>
      )}
    </>
  );
}

export function DigestsTab() {
  const [scopeKey, setScopeKey] = useState('');
  const [emailText, setEmailText] = useState('');
  const [channelId, setChannelId] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editChannel, setEditChannel] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Digest | null>(null);
  const [readdTarget, setReaddTarget] = useState<{ digest: Digest; email: string } | null>(null);
  const query = useQuery({
    queryFn: () => api.get<{ data: DigestData }>('/api/v1/report-digests').then(({ data }) => data),
    queryKey: ['report-digests'],
  });
  const refresh = () => void query.refetch();
  const create = useMutation({
    mutationFn: async () => {
      const [scope, id] = scopeKey.split(':');
      return api.post('/api/v1/report-digests', {
        emailRecipients: recipients(emailText),
        orgId: scope === 'ORGANIZATION' ? id : null,
        scope,
        slackChannelId: channelId || null,
        teamId: scope === 'TEAM' ? id : null,
      });
    },
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: (input: UpdateInput) =>
      api.patch(`/api/v1/report-digests/${input.id}`, {
        ...(input.enabled !== undefined
          ? { enabled: input.enabled }
          : {
              ...(input.confirmOptedOutReadd
                ? { confirmOptedOutReadd: input.confirmOptedOutReadd }
                : {}),
              emailRecipients: input.emailRecipients ?? recipients(editEmail),
              ...(input.slackChannelId !== undefined
                ? { slackChannelId: input.slackChannelId }
                : input.emailRecipients === undefined
                  ? { slackChannelId: editChannel || null }
                  : {}),
            }),
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/report-digests/${id}`),
    onSuccess: refresh,
  });
  const sendTest = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/report-digests/${id}/send-test`, {}),
  });
  const data = query.data;
  const selectedScope = scopeKey.split(':');
  const selectedOrgId =
    selectedScope[0] === 'ORGANIZATION'
      ? selectedScope[1]
      : data?.teams.find((team) => team.id === selectedScope[1])?.orgId;
  const channels = data?.channels.filter((channel) => channel.orgId === selectedOrgId) ?? [];

  return (
    <section aria-label="Report digests" className="space-y-5">
      <div className="rounded-lg border border-ink-700 p-4">
        <h2 className="font-semibold text-paper-100">Create weekly digest</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Select
            aria-label="Digest scope"
            onChange={(value) => {
              setScopeKey(value);
              // A channel belongs to one organization; a new scope may not offer it.
              setChannelId('');
            }}
            options={[
              { label: 'Choose a manageable scope', value: '' },
              ...(data?.organizations ?? []).map((org) => ({
                label: `Organization: ${org.name}`,
                value: `ORGANIZATION:${org.id}`,
              })),
              ...(data?.teams ?? []).map((team) => ({
                label: `Team: ${team.name}`,
                value: `TEAM:${team.id}`,
              })),
            ]}
            placeholder="Choose a manageable scope"
            value={scopeKey}
          />
          <Input
            aria-label="Email recipients"
            onChange={(event) => setEmailText(event.target.value)}
            placeholder="Emails, comma separated"
            value={emailText}
          />
          <Select
            aria-label="Slack channel"
            onChange={setChannelId}
            options={[
              { label: 'No Slack channel', value: '' },
              ...channels.map((channel) => ({ label: channel.name, value: channel.id })),
            ]}
            value={channelId}
          />
          <Button
            disabled={!scopeKey || create.isPending}
            onClick={() => create.mutate()}
            variant="primary"
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
        {create.error && (
          <Alert className="mt-2">
            <ErrorDetail error={create.error} />
          </Alert>
        )}
      </div>
      <QueryBoundary
        error={query.error}
        isError={query.isError}
        isFetching={query.isFetching}
        isLoading={query.isLoading}
        label="digest subscriptions"
        onRetry={refresh}
        rows={2}
        shape="cards"
      >
        <div className="space-y-3">
          {(data?.subscriptions ?? []).map((digest) => {
            const orgId = digest.orgId ?? digest.team?.orgId;
            const scopedChannels =
              data?.channels.filter((channel) => channel.orgId === orgId) ?? [];
            return (
              <article className="rounded-lg border border-ink-700 p-4" key={digest.id}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <strong>
                    {digest.scope === 'ORGANIZATION'
                      ? `Organization: ${digest.organization?.name ?? digest.orgId}`
                      : `Team: ${digest.team?.name ?? digest.teamId}`}
                  </strong>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => {
                        setEditing(editing === digest.id ? null : digest.id);
                        setEditEmail(digest.emailRecipients.join(', '));
                        setEditChannel(digest.slackChannelId ?? '');
                      }}
                      size="sm"
                    >
                      Edit
                    </Button>
                    <Button
                      disabled={sendTest.isPending && sendTest.variables === digest.id}
                      onClick={() => sendTest.mutate(digest.id)}
                      size="sm"
                    >
                      {sendTest.isPending && sendTest.variables === digest.id
                        ? 'Sending…'
                        : 'Send test'}
                    </Button>
                    <Button
                      disabled={update.isPending}
                      onClick={() => update.mutate({ enabled: !digest.enabled, id: digest.id })}
                      size="sm"
                    >
                      {digest.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      disabled={remove.isPending}
                      onClick={() => setDeleteTarget(digest)}
                      size="sm"
                      variant="danger"
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                <p className="mt-2 text-sm text-paper-300">
                  {digest.emailRecipients.join(', ') || 'No email recipients'} ·{' '}
                  {digest.slackChannel?.name ?? 'No Slack channel'}
                </p>
                <p className="mt-1 text-xs text-paper-400">
                  Last completed period:{' '}
                  {digest.lastPeriodStart
                    ? // The period starts on a UTC Monday; formatting in local time shows the
                      // previous Monday west of UTC.
                      new Date(digest.lastPeriodStart).toLocaleDateString(undefined, {
                        timeZone: 'UTC',
                      })
                    : 'None'}
                </p>
                {sendTest.isError && sendTest.variables === digest.id && (
                  <Alert className="mt-2">
                    <ErrorDetail error={sendTest.error} />
                  </Alert>
                )}
                {sendTest.isSuccess && sendTest.variables === digest.id && (
                  <Alert className="mt-2" variant="success">
                    Test digest queued for delivery.
                  </Alert>
                )}
                {digest.lastError && (
                  <Alert className="mt-2">{digestErrorText(digest.lastError)}</Alert>
                )}
                {digest.lastTestError && (
                  <Alert className="mt-2">
                    Last test delivery failed. {digestErrorText(digest.lastTestError)}
                  </Alert>
                )}
                {update.isError && update.variables?.id === digest.id && readdTarget === null && (
                  <Alert className="mt-2">
                    <ErrorDetail error={update.error} />
                  </Alert>
                )}
                {digest.optedOutEmails.length > 0 && (
                  <div className="mt-3 rounded border border-ink-700 p-3">
                    <h3 className="text-sm font-medium">Opted-out email addresses</h3>
                    <ul className="mt-2 space-y-2">
                      {digest.optedOutEmails.map((email) => (
                        <li className="flex items-center justify-between gap-3" key={email}>
                          <span className="text-sm text-paper-300">{email}</span>
                          <Button
                            disabled={update.isPending}
                            onClick={() => setReaddTarget({ digest, email })}
                            size="sm"
                          >
                            Re-add
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {editing === digest.id && (
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <Input
                      aria-label="Edit email recipients"
                      onChange={(event) => setEditEmail(event.target.value)}
                      value={editEmail}
                    />
                    <Select
                      aria-label="Edit Slack channel"
                      onChange={setEditChannel}
                      options={[
                        { label: 'No Slack channel', value: '' },
                        ...scopedChannels.map((channel) => ({
                          label: channel.name,
                          value: channel.id,
                        })),
                      ]}
                      value={editChannel}
                    />
                    <Button
                      disabled={update.isPending}
                      onClick={() => update.mutate({ id: digest.id })}
                      variant="primary"
                    >
                      {update.isPending ? 'Saving…' : 'Save'}
                    </Button>
                  </div>
                )}
              </article>
            );
          })}
          {!data?.subscriptions.length && (
            <EmptyState
              bordered
              hint="Create a weekly digest above to email or post the report summary."
              icon="analytics"
              title="No digest subscriptions."
            />
          )}
        </div>
      </QueryBoundary>
      {deleteTarget && (
        <ConfirmModal
          confirmLabel="Delete"
          dangerous
          error={remove.error ? <ErrorDetail error={remove.error} /> : undefined}
          message="This digest stops sending to its email recipients and Slack channel. You can create it again later."
          onClose={() => {
            remove.reset();
            setDeleteTarget(null);
          }}
          onConfirm={async () => {
            await remove.mutateAsync(deleteTarget.id);
          }}
          open
          pendingLabel="Deleting…"
          title="Delete this digest?"
        />
      )}
      {readdTarget && (
        <ConfirmModal
          confirmLabel="Re-add"
          error={
            update.isError && update.variables?.id === readdTarget.digest.id ? (
              <ErrorDetail error={update.error} />
            ) : undefined
          }
          message={`${readdTarget.email} opted out of this digest. Re-adding them sends it to them again.`}
          onClose={() => {
            update.reset();
            setReaddTarget(null);
          }}
          onConfirm={async () => {
            await update.mutateAsync(readdInput(readdTarget.digest, readdTarget.email));
          }}
          open
          pendingLabel="Re-adding…"
          title="Re-add opted-out address?"
        />
      )}
    </section>
  );
}
