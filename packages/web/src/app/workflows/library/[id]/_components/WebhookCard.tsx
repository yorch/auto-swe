import type { WorkflowTemplateDetail } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { CopyButton } from '@/components/ui/CopyButton';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  useRegenerateWebhook,
  useRemoveWebhookSigningSecret,
  useRevokeWebhook,
  useRotateWebhookSigningSecret,
  useSetWebhookRequireSignature,
} from '@/hooks/useTemplates';
import { errMsg } from '@/lib/errors';
import { RailCard } from './RailCard';

/** Regenerate / Revoke for an existing webhook URL. Both invalidate the
 *  current URL, so each goes through a confirmation. */
function WebhookActions({
  onRegenerate,
  onRevoke,
}: {
  onRegenerate: () => Promise<void>;
  onRevoke: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<'regenerate' | 'revoke' | null>(null);
  return (
    <div className="flex gap-2">
      <Button onClick={() => setConfirming('regenerate')} size="sm" variant="secondary">
        Regenerate
      </Button>
      <Button onClick={() => setConfirming('revoke')} size="sm" variant="danger">
        Revoke
      </Button>
      <ConfirmModal
        confirmLabel="Regenerate"
        dangerous
        message="A new webhook URL is issued and the current URL stops working immediately. Anything calling the old URL must be updated."
        onClose={() => setConfirming(null)}
        onConfirm={onRegenerate}
        open={confirming === 'regenerate'}
        title="Regenerate webhook URL?"
      />
      <ConfirmModal
        confirmLabel="Revoke"
        dangerous
        message="The current webhook URL stops working immediately. You can generate a new one later, but the old URL cannot be restored."
        onClose={() => setConfirming(null)}
        onConfirm={onRevoke}
        open={confirming === 'revoke'}
        title="Revoke webhook URL?"
      />
    </div>
  );
}

export function WebhookCard({
  template,
  canManage,
}: {
  template: WorkflowTemplateDetail;
  canManage: boolean;
}) {
  const regenerate = useRegenerateWebhook(template.id);
  const revoke = useRevokeWebhook(template.id);
  const [error, setError] = useState<string | null>(null);
  // The token is a trigger credential: the API returns it exactly once, from
  // the regenerate call, so it only lives in this component's state until the
  // page is left. Afterwards the template only reports that one is configured.
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const webhookUrl = freshToken
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/api/v1/webhooks/${freshToken}`
    : null;

  const handleRegenerate = async () => {
    setError(null);
    try {
      const { webhookToken } = await regenerate.mutateAsync();
      setFreshToken(webhookToken);
    } catch (err) {
      setError(errMsg(err, 'regenerate failed'));
    }
  };

  // Confirmed from WebhookActions: errors propagate so the ConfirmModal shows them.
  const confirmRegenerate = async () => {
    setError(null);
    const { webhookToken } = await regenerate.mutateAsync();
    setFreshToken(webhookToken);
  };

  const confirmRevoke = async () => {
    setError(null);
    await revoke.mutateAsync();
    setFreshToken(null);
  };

  return (
    <RailCard hint="HTTP" title="Webhook trigger">
      {error && <Alert className="mb-3 text-xs">{error}</Alert>}
      {webhookUrl ? (
        <div className="space-y-3">
          <Alert className="text-xs" variant="warning">
            Copy this URL now. It is shown only once.
          </Alert>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-[11px] text-paper-300">
              {webhookUrl}
            </code>
            <CopyButton value={webhookUrl} />
          </div>
          {canManage && (
            <WebhookActions onRegenerate={confirmRegenerate} onRevoke={confirmRevoke} />
          )}
        </div>
      ) : template.webhookConfigured ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-[13px] text-paper-200">
            <Badge dot tone="moss">
              Configured
            </Badge>
          </p>
          <p className="text-xs leading-relaxed text-paper-500">
            The URL is shown only once, when it is generated. Regenerate to issue a new one (the
            current URL stops working) or revoke it.
          </p>
          {canManage && (
            <WebhookActions onRegenerate={confirmRegenerate} onRevoke={confirmRevoke} />
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-paper-500">
            No webhook yet. Generate a URL to let another system start this workflow with an HTTP
            request.
          </p>
          {canManage && (
            <Button
              disabled={regenerate.isPending}
              onClick={handleRegenerate}
              size="sm"
              variant="secondary"
            >
              {regenerate.isPending ? 'Generating…' : 'Generate webhook URL'}
            </Button>
          )}
        </div>
      )}
      <WebhookSigning canManage={canManage} template={template} />
    </RailCard>
  );
}

/**
 * Signing for the webhook: a secret the caller signs each body with (`X-AutoSwe-Signature`),
 * shown once when generated; a rotation keeps the previous one valid for 24 hours. The switch
 * refuses unsigned calls; policy can force that for the whole team or organization.
 */
function WebhookSigning({
  template,
  canManage,
}: {
  template: WorkflowTemplateDetail;
  canManage: boolean;
}) {
  const rotate = useRotateWebhookSigningSecret(template.id);
  const remove = useRemoveWebhookSigningSecret(template.id);
  const setRequired = useSetWebhookRequireSignature(template.id);
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'rotate' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signing = template.webhookSigning;
  const byPolicy = template.webhookSignatureRequiredByPolicy;
  const enforced = signing.requireSignature || byPolicy;

  const doRotate = async () => {
    setError(null);
    const { signingSecret } = await rotate.mutateAsync();
    setFreshSecret(signingSecret);
  };
  const generate = async () => {
    try {
      await doRotate();
    } catch (err) {
      setError(errMsg(err, 'could not generate a signing secret'));
    }
  };
  const doRemove = async () => {
    setError(null);
    await remove.mutateAsync();
    setFreshSecret(null);
  };
  const toggle = async () => {
    setError(null);
    try {
      await setRequired.mutateAsync(!signing.requireSignature);
    } catch (err) {
      setError(errMsg(err, 'could not change the signature requirement'));
    }
  };

  return (
    <div className="mt-4 space-y-3 border-t border-ink-600 pt-3">
      <p className="flex flex-wrap items-center gap-2 text-[13px] text-paper-200">
        Signing
        {signing.configured ? (
          <Badge dot tone="moss">
            Secret set{signing.lastFour ? ` ···${signing.lastFour}` : ''}
          </Badge>
        ) : (
          <Badge dot tone="amber">
            Unsigned
          </Badge>
        )}
        {enforced && (
          <Badge tone="neutral" variant="outline">
            {signing.requireSignature ? 'required' : 'required by policy'}
          </Badge>
        )}
      </p>
      {error && <Alert className="text-xs">{error}</Alert>}
      {freshSecret && (
        <div className="space-y-2">
          <Alert className="text-xs" variant="warning">
            Copy this signing secret now. It is shown only once.
          </Alert>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-[11px] text-paper-300">
              {freshSecret}
            </code>
            <CopyButton value={freshSecret} />
          </div>
        </div>
      )}
      <p className="text-xs leading-relaxed text-paper-500">
        {signing.configured
          ? 'Callers sign each body with this secret in an X-AutoSwe-Signature header. A signed call is always checked.'
          : 'Generate a secret so callers can sign each call; anyone holding the URL can call it otherwise.'}
        {signing.previousExpiresAt &&
          ` The previous secret is still accepted until ${new Date(signing.previousExpiresAt).toLocaleString()}.`}
        {byPolicy &&
          !signing.configured &&
          ' Policy requires signed calls here, so every call is refused until a secret exists.'}
      </p>
      {canManage && (
        <div className="space-y-3">
          <div className="flex gap-2">
            {signing.configured ? (
              <>
                <Button onClick={() => setConfirming('rotate')} size="sm" variant="secondary">
                  Rotate secret
                </Button>
                <Button
                  disabled={signing.requireSignature}
                  onClick={() => setConfirming('remove')}
                  size="sm"
                  title={
                    signing.requireSignature
                      ? 'Turn off “Require signed calls” first'
                      : 'Remove the signing secret'
                  }
                  variant="danger"
                >
                  Remove
                </Button>
              </>
            ) : (
              <Button disabled={rotate.isPending} onClick={generate} size="sm" variant="secondary">
                {rotate.isPending ? 'Generating…' : 'Generate signing secret'}
              </Button>
            )}
          </div>
          <ToggleSwitch
            checked={signing.requireSignature}
            disabled={(!signing.configured && !signing.requireSignature) || setRequired.isPending}
            label="Require signed calls"
            onChange={toggle}
            title={
              signing.configured || signing.requireSignature
                ? undefined
                : 'Generate a signing secret first'
            }
          />
          <ConfirmModal
            confirmLabel="Rotate"
            message="A new secret is issued and shown once. The current secret keeps working for 24 hours, so update the caller within that window."
            onClose={() => setConfirming(null)}
            onConfirm={doRotate}
            open={confirming === 'rotate'}
            title="Rotate signing secret?"
          />
          <ConfirmModal
            confirmLabel="Remove"
            dangerous
            message="The current and any previous signing secret are removed. Calls are then accepted unsigned, unless policy requires signing — in which case every call is refused."
            onClose={() => setConfirming(null)}
            onConfirm={doRemove}
            open={confirming === 'remove'}
            title="Remove signing secret?"
          />
        </div>
      )}
    </div>
  );
}
