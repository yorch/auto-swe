'use client';

import {
  EVENT_ENDPOINT_PRESETS,
  type EventEndpointConfig,
  type EventEndpointScheme,
} from '@auto-swe/shared/automation';
import { useState } from 'react';
import { TeamAutomationsModal } from '@/components/automations/TeamAutomationsModal';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { CopyButton } from '@/components/ui/CopyButton';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  type EventEndpoint,
  useCreateEventEndpoint,
  useDeleteEventEndpoint,
  useEventEndpoints,
  useRotateEventEndpointSecret,
  useUpdateEventEndpoint,
} from '@/hooks/useEventEndpoints';
import { errMsg } from '@/lib/errors';

/** How each scheme is described to the person giving the URL to a sender. */
export function schemeLabel(
  e: Pick<
    EventEndpointConfig,
    'scheme' | 'signatureHeader' | 'signaturePrefix' | 'signatureEncoding'
  >
): string {
  if (e.scheme === 'autoswe-v1') {
    return 'X-AutoSwe-Signature (timestamped HMAC)';
  }
  if (e.scheme === 'hmac-sha256') {
    return `HMAC-SHA256 of the body in ${e.signatureHeader ?? '?'} as ${e.signaturePrefix ?? ''}<${e.signatureEncoding ?? 'hex'}>`;
  }
  return `Shared secret in ${e.signatureHeader ?? '?'}${e.signaturePrefix ? ` after “${e.signaturePrefix}”` : ''}`;
}

/** A secret shown once, with a copy button. */
function FreshSecret({ secret }: { secret: string }) {
  return (
    <div className="space-y-2">
      <Alert className="text-xs" variant="warning">
        Copy this secret now and give it to the sender. It is shown only once.
      </Alert>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-[11px] text-paper-300">
          {secret}
        </code>
        <CopyButton value={secret} />
      </div>
    </div>
  );
}

function NewEndpointForm({
  teamId,
  onDone,
}: {
  teamId: string;
  onDone: (secret?: string) => void;
}) {
  const create = useCreateEventEndpoint(teamId);
  const [preset, setPreset] = useState(EVENT_ENDPOINT_PRESETS[0]?.key ?? '');
  const base = EVENT_ENDPOINT_PRESETS.find((p) => p.key === preset)?.config;
  const [name, setName] = useState('');
  const [scheme, setScheme] = useState<EventEndpointScheme>(base?.scheme ?? 'autoswe-v1');
  const [header, setHeader] = useState(base?.signatureHeader ?? '');
  const [prefix, setPrefix] = useState(base?.signaturePrefix ?? '');
  const [encoding, setEncoding] = useState(base?.signatureEncoding ?? 'hex');
  const [typePointer, setTypePointer] = useState(base?.typePointer ?? '/type');
  const [idPointer, setIdPointer] = useState(base?.idPointer ?? '');
  const [subjectPointer, setSubjectPointer] = useState(base?.subjectPointer ?? '');
  const [scopePointer, setScopePointer] = useState(base?.scopePointer ?? '');
  const [format, setFormat] = useState(base?.format ?? 'json');
  const applyPreset = (key: string) => {
    const p = EVENT_ENDPOINT_PRESETS.find((x) => x.key === key)?.config;
    setPreset(key);
    if (!p) {
      return;
    }
    setScheme(p.scheme);
    setHeader(p.signatureHeader ?? '');
    setPrefix(p.signaturePrefix ?? '');
    setEncoding(p.signatureEncoding ?? 'hex');
    setFormat(p.format);
    setTypePointer(p.typePointer);
    setIdPointer(p.idPointer ?? '');
    setSubjectPointer(p.subjectPointer ?? '');
    setScopePointer(p.scopePointer ?? '');
  };
  const orNull = (v: string) => (v.trim() === '' ? null : v.trim());
  const needsHeader = scheme !== 'autoswe-v1';
  const valid = name.trim() !== '' && (!needsHeader || header.trim() !== '');
  const save = () =>
    create.mutate(
      {
        format,
        idPointer: orNull(idPointer),
        name: name.trim(),
        scheme,
        scopePointer: orNull(scopePointer),
        signatureEncoding: scheme === 'hmac-sha256' ? encoding : null,
        signatureHeader: needsHeader ? header.trim() : null,
        signaturePrefix: needsHeader && prefix !== '' ? prefix : null,
        subjectPointer: orNull(subjectPointer),
        typePointer: typePointer.trim(),
      },
      { onSuccess: (created) => onDone(created.secret) }
    );
  return (
    <section className="space-y-3 border-ink-600 border-t pt-4">
      <Select
        hint={EVENT_ENDPOINT_PRESETS.find((p) => p.key === preset)?.description}
        label="Start from"
        onChange={applyPreset}
        options={EVENT_ENDPOINT_PRESETS.map((p) => ({ label: p.label, value: p.key }))}
        value={preset}
      />
      <Input label="Name" onChange={(e) => setName(e.target.value)} value={name} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Verification"
          onChange={(v) => setScheme(v as EventEndpointScheme)}
          options={[
            { label: 'X-AutoSwe-Signature', value: 'autoswe-v1' },
            { label: 'HMAC-SHA256 header', value: 'hmac-sha256' },
            { label: 'Shared secret header', value: 'shared-secret-header' },
          ]}
          value={scheme}
        />
        <Select
          label="Body"
          onChange={(v) => setFormat(v as 'json' | 'cloudevents')}
          options={[
            { label: 'JSON', value: 'json' },
            { label: 'CloudEvents', value: 'cloudevents' },
          ]}
          value={format}
        />
        {needsHeader && (
          <>
            <Input label="Header" onChange={(e) => setHeader(e.target.value)} value={header} />
            <Input
              hint="Text before the value, e.g. sha256= or Bearer (optional)"
              label="Prefix"
              onChange={(e) => setPrefix(e.target.value)}
              value={prefix}
            />
          </>
        )}
        {scheme === 'hmac-sha256' && (
          <Select
            label="Encoding"
            onChange={(v) => setEncoding(v as 'hex' | 'base64')}
            options={[
              { label: 'hex', value: 'hex' },
              { label: 'base64', value: 'base64' },
            ]}
            value={encoding}
          />
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          hint="JSON Pointer to the event type, e.g. /type"
          label="Type pointer"
          onChange={(e) => setTypePointer(e.target.value)}
          value={typePointer}
        />
        <Input
          hint="Empty: a digest of the body"
          label="Id pointer"
          onChange={(e) => setIdPointer(e.target.value)}
          value={idPointer}
        />
        <Input
          hint="Empty: the id"
          label="Subject pointer"
          onChange={(e) => setSubjectPointer(e.target.value)}
          value={subjectPointer}
        />
        <Input
          hint="Empty: the type"
          label="Scope pointer"
          onChange={(e) => setScopePointer(e.target.value)}
          value={scopePointer}
        />
      </div>
      {create.isError && <Alert>{errMsg(create.error, 'Could not create the endpoint.')}</Alert>}
      <div className="flex justify-end gap-2">
        <Button onClick={() => onDone()} variant="ghost">
          Cancel
        </Button>
        <Button disabled={!valid || create.isPending} onClick={save} variant="primary">
          <Icon name="plus" size={14} />
          Create
        </Button>
      </div>
    </section>
  );
}

function EndpointRow({
  teamId,
  endpoint,
  canManage,
  onSecret,
}: {
  teamId: string;
  endpoint: EventEndpoint;
  canManage: boolean;
  onSecret: (secret: string) => void;
}) {
  const update = useUpdateEventEndpoint(teamId);
  const rotate = useRotateEventEndpointSecret(teamId);
  const remove = useDeleteEventEndpoint(teamId);
  const [confirming, setConfirming] = useState<'rotate' | 'remove' | null>(null);
  const url = `${typeof window !== 'undefined' ? window.location.origin : ''}${endpoint.path}`;
  const error = update.error ?? rotate.error ?? remove.error;
  return (
    <li className="space-y-2 px-3.5 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium text-paper-100">
            {endpoint.name}{' '}
            {endpoint.format === 'cloudevents' && (
              <Badge tone="muted" variant="text">
                CloudEvents
              </Badge>
            )}
          </div>
          <div className="mt-0.5 text-paper-500 text-xs">
            {schemeLabel(endpoint)} · secret ···{endpoint.secretLastFour}
            {endpoint.previousSecretExpiresAt &&
              ` · previous ···${endpoint.previousSecretLastFour ?? ''} accepted until ${new Date(endpoint.previousSecretExpiresAt).toLocaleString()}`}
          </div>
          <div className="mt-0.5 text-paper-500 text-xs">
            type {endpoint.typePointer || '(whole)'} · id {endpoint.idPointer ?? 'body digest'} ·
            subject {endpoint.subjectPointer ?? 'the id'} · scope{' '}
            {endpoint.scopePointer ?? 'the type'}
          </div>
        </div>
        <ToggleSwitch
          ariaLabel={`${endpoint.enabled ? 'Disable' : 'Enable'} ${endpoint.name}`}
          checked={endpoint.enabled}
          disabled={!canManage || update.isPending}
          onChange={() => update.mutate({ enabled: !endpoint.enabled, id: endpoint.id })}
        />
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-[11px] text-paper-300">
          POST {url}
        </code>
        <CopyButton value={url} />
      </div>
      {canManage && (
        <div className="flex gap-2">
          <Button onClick={() => setConfirming('rotate')} size="sm" variant="secondary">
            Rotate secret
          </Button>
          <Button onClick={() => setConfirming('remove')} size="sm" variant="danger">
            Remove
          </Button>
        </div>
      )}
      {error && (
        <Alert className="text-xs">{errMsg(error, 'Could not change the endpoint.')}</Alert>
      )}
      <ConfirmModal
        confirmLabel="Rotate"
        message="A new secret is issued and shown once. The current secret keeps working for 24 hours, so update the sender within that window."
        onClose={() => setConfirming(null)}
        onConfirm={async () => {
          const rotated = await rotate.mutateAsync(endpoint.id);
          if (rotated.secret) {
            onSecret(rotated.secret);
          }
        }}
        open={confirming === 'rotate'}
        title="Rotate secret?"
      />
      <ConfirmModal
        confirmLabel="Remove"
        dangerous
        message="Calls to this URL stop being accepted. An endpoint that automations still react to cannot be removed."
        onClose={() => setConfirming(null)}
        onConfirm={() => remove.mutate(endpoint.id)}
        open={confirming === 'remove'}
        title="Remove endpoint?"
      />
    </li>
  );
}

/**
 * The team's event endpoints (docs/inbound-events.md): the URL to give a sender, how calls are
 * verified, the secret's rotation and the on/off switch, and the team's automations that decide
 * what each event starts. Members read; the team's leads and admins manage.
 */
export function EventEndpointsCard({ team }: { team: { id: string; name: string } }) {
  const { data, isLoading, isError, error } = useEventEndpoints(team.id);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [automations, setAutomations] = useState(false);
  const canManage = data?.canManage ?? false;
  return (
    <Card>
      <CardHeader className="mb-2">
        <CardTitle eyebrow="Inbound events">Event endpoints</CardTitle>
        <Button onClick={() => setAutomations(true)} size="sm" variant="secondary">
          Automations
        </Button>
      </CardHeader>
      <div className="space-y-3">
        <p className="text-paper-500 text-xs leading-relaxed">
          Other services post signed events to these URLs. The team’s automations decide what each
          event starts; an event never runs anything on its own.
        </p>
        {isLoading && <SkeletonRows rows={2} />}
        {isError && <Alert>{errMsg(error, 'Could not load the event endpoints.')}</Alert>}
        {secret && <FreshSecret secret={secret} />}
        {data && data.endpoints.length > 0 && (
          <ul className="divide-y divide-ink-600 rounded-lg border border-ink-500/70 bg-ink-900/40">
            {data.endpoints.map((e) => (
              <EndpointRow
                canManage={canManage}
                endpoint={e}
                key={e.id}
                onSecret={setSecret}
                teamId={team.id}
              />
            ))}
          </ul>
        )}
        {data && data.endpoints.length === 0 && (
          <p className="text-paper-500 text-sm">No event endpoints.</p>
        )}
        {canManage &&
          (adding ? (
            <NewEndpointForm
              onDone={(fresh) => {
                setAdding(false);
                if (fresh) {
                  setSecret(fresh);
                }
              }}
              teamId={team.id}
            />
          ) : (
            <Button onClick={() => setAdding(true)} variant="secondary">
              <Icon name="plus" size={14} />
              New endpoint
            </Button>
          ))}
      </div>
      {automations && <TeamAutomationsModal onClose={() => setAutomations(false)} team={team} />}
    </Card>
  );
}
