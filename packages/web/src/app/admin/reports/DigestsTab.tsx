'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';

type Scope = { id: string; name: string; orgId?: string | null };
type Digest = {
  emailRecipients: string[];
  enabled: boolean;
  id: string;
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

function recipients(value: string) {
  return value
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
}

export function DigestsTab() {
  const [scopeKey, setScopeKey] = useState('');
  const [emailText, setEmailText] = useState('');
  const [channelId, setChannelId] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editChannel, setEditChannel] = useState('');
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
    mutationFn: (input: {
      confirmOptedOutReadd?: string[];
      emailRecipients?: string[];
      id: string;
      enabled?: boolean;
      slackChannelId?: string | null;
    }) =>
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
        <div className="mt-3 flex flex-wrap gap-3">
          <select
            aria-label="Digest scope"
            className="rounded border border-ink-600 bg-ink-900 px-3 py-2"
            onChange={(event) => setScopeKey(event.target.value)}
            value={scopeKey}
          >
            <option value="">Choose a manageable scope</option>
            {(data?.organizations ?? []).map((org) => (
              <option key={org.id} value={`ORGANIZATION:${org.id}`}>
                Organization: {org.name}
              </option>
            ))}
            {(data?.teams ?? []).map((team) => (
              <option key={team.id} value={`TEAM:${team.id}`}>
                Team: {team.name}
              </option>
            ))}
          </select>
          <input
            aria-label="Email recipients"
            className="rounded border border-ink-600 bg-ink-900 px-3 py-2"
            onChange={(event) => setEmailText(event.target.value)}
            placeholder="Emails, comma separated"
            value={emailText}
          />
          <select
            aria-label="Slack channel"
            className="rounded border border-ink-600 bg-ink-900 px-3 py-2"
            onChange={(event) => setChannelId(event.target.value)}
            value={channelId}
          >
            <option value="">No Slack channel</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name}
              </option>
            ))}
          </select>
          <button
            className="rounded bg-accent-500 px-3 py-2 text-paper-50 disabled:opacity-50"
            disabled={!scopeKey || create.isPending}
            onClick={() => create.mutate()}
            type="button"
          >
            Create
          </button>
        </div>
        {create.error && (
          <p className="mt-2 text-danger-400" role="alert">
            {create.error.message}
          </p>
        )}
      </div>
      {query.isLoading ? (
        <p>Loading digests…</p>
      ) : (
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
                  <div className="flex gap-2">
                    <button
                      className="rounded border border-ink-600 px-3 py-1"
                      onClick={() => {
                        setEditing(editing === digest.id ? null : digest.id);
                        setEditEmail(digest.emailRecipients.join(', '));
                        setEditChannel(digest.slackChannelId ?? '');
                      }}
                      type="button"
                    >
                      Edit
                    </button>
                    <button
                      className="rounded border border-ink-600 px-3 py-1"
                      onClick={() => sendTest.mutate(digest.id)}
                      type="button"
                    >
                      Send test
                    </button>
                    <button
                      className="rounded border border-danger-400/30 px-3 py-1"
                      onClick={() => remove.mutate(digest.id)}
                      type="button"
                    >
                      Delete
                    </button>
                    <button
                      className="rounded border border-ink-600 px-3 py-1"
                      onClick={() => update.mutate({ enabled: !digest.enabled, id: digest.id })}
                      type="button"
                    >
                      {digest.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-sm text-paper-300">
                  {digest.emailRecipients.join(', ') || 'No email recipients'} ·{' '}
                  {digest.slackChannel?.name ?? 'No Slack channel'}
                </p>
                <p className="mt-1 text-xs text-paper-400">
                  Last completed period:{' '}
                  {digest.lastPeriodStart
                    ? new Date(digest.lastPeriodStart).toLocaleDateString()
                    : 'None'}
                </p>
                {digest.lastTestError && (
                  <p className="mt-1 text-xs text-danger-400" role="status">
                    Last test delivery failed: {digest.lastTestError}
                  </p>
                )}
                {digest.optedOutEmails.length > 0 && (
                  <div className="mt-3 rounded border border-ink-700 p-3">
                    <h3 className="text-sm font-medium">Opted-out email addresses</h3>
                    <ul className="mt-2 space-y-2">
                      {digest.optedOutEmails.map((email) => (
                        <li className="flex items-center justify-between gap-3" key={email}>
                          <span className="text-sm text-paper-300">{email}</span>
                          <button
                            className="rounded border border-ink-600 px-3 py-1 text-sm"
                            onClick={() => {
                              if (!window.confirm(`Re-add ${email} to this digest?`)) {
                                return;
                              }
                              update.mutate({
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
                              });
                            }}
                            type="button"
                          >
                            Re-add
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {editing === digest.id && (
                  <div className="mt-3 flex flex-wrap gap-3">
                    <input
                      aria-label="Edit email recipients"
                      className="rounded border border-ink-600 bg-ink-900 px-3 py-2"
                      onChange={(event) => setEditEmail(event.target.value)}
                      value={editEmail}
                    />
                    <select
                      aria-label="Edit Slack channel"
                      className="rounded border border-ink-600 bg-ink-900 px-3 py-2"
                      onChange={(event) => setEditChannel(event.target.value)}
                      value={editChannel}
                    >
                      <option value="">No Slack channel</option>
                      {scopedChannels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="rounded bg-accent-500 px-3 py-2"
                      onClick={() => update.mutate({ id: digest.id })}
                      type="button"
                    >
                      Save
                    </button>
                  </div>
                )}
              </article>
            );
          })}
          {!data?.subscriptions.length && <p>No digest subscriptions.</p>}
        </div>
      )}
    </section>
  );
}
