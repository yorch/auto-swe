import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { CopyButton } from '@/components/ui/CopyButton';
import { useRegenerateWebhook, useRevokeWebhook } from '@/hooks/useTemplates';
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
  template: WorkflowTemplateSummary;
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
    </RailCard>
  );
}
