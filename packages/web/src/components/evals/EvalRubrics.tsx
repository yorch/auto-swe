'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ExpandablePre } from '@/components/ui/ExpandablePre';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Textarea } from '@/components/ui/Textarea';
import { useCreateEvalRubric, useEvalRubrics } from '@/hooks/useAdmin';
import { errMsg } from '@/lib/errors';
import { scanWarningLead } from '@/lib/scanWarnings';
import { formatRelativeTime } from '@/lib/utils';

const SLUG_RE = /^[a-z0-9_-]+$/;

/**
 * The judge rubrics an eval's `judge` scorer can grade with: a slug, a scale and the prompt the
 * judge model reads. A rubric is created here and not edited afterwards.
 */
export function EvalRubrics() {
  const rubrics = useEvalRubrics();
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = rubrics.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle hint="The prompts the judge model scores with">Judge rubrics</CardTitle>
        <Button onClick={() => setCreating(true)} size="sm">
          New rubric
        </Button>
      </CardHeader>
      {notice && (
        <Alert className="mb-3" variant="warning">
          {notice}
        </Alert>
      )}
      <QueryBoundary
        error={rubrics.error}
        isError={rubrics.isError}
        isFetching={rubrics.isFetching}
        isLoading={rubrics.isLoading}
        label="judge rubrics"
        onRetry={() => void rubrics.refetch()}
        rows={3}
      >
        {rows.length > 0 ? (
          <ul className="divide-y divide-ink-600">
            {rows.map((r) => (
              <li className="py-3" key={r.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-paper-100">{r.slug}</span>
                  <Badge tone="muted" variant="outline">
                    v{r.version}
                  </Badge>
                  <Badge tone="muted" variant="outline">
                    {r.scope.charAt(0) + r.scope.slice(1).toLowerCase().replaceAll('_', ' ')}
                  </Badge>
                  {r.isBuiltIn && (
                    <Badge tone="info" variant="outline">
                      Built in
                    </Badge>
                  )}
                  <span className="ml-auto text-xs text-paper-500">
                    Scale {r.scale} · {formatRelativeTime(r.createdAt)}
                  </span>
                </div>
                <ExpandablePre className="mt-2">{r.promptText}</ExpandablePre>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            hint="Create one to give the judge scorer a prompt of your own."
            icon="flask"
            title="No judge rubrics yet"
          />
        )}
      </QueryBoundary>
      <NewRubricModal
        onClose={() => setCreating(false)}
        onCreated={(warnings) => {
          setNotice(
            warnings.length > 0 ? `${scanWarningLead(warnings)} ${warnings.join('; ')}` : null
          );
          setCreating(false);
        }}
        open={creating}
      />
    </Card>
  );
}

function NewRubricModal({
  onClose,
  onCreated,
  open,
}: {
  onClose: () => void;
  onCreated: (scanWarnings: string[]) => void;
  open: boolean;
}) {
  const create = useCreateEvalRubric();
  const [slug, setSlug] = useState('');
  const [scale, setScale] = useState('0..1');
  const [promptText, setPromptText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const slugOk = SLUG_RE.test(slug) && slug.length <= 100;
  const canSave = slugOk && promptText.trim() !== '' && scale.trim() !== '';

  return (
    <Modal
      dismissible={!create.isPending}
      onClose={onClose}
      open={open}
      size="lg"
      subtitle="Created at the global scope. The prompt is scanned for injection and exfiltration patterns; findings are shown, not blocking."
      title="New judge rubric"
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate(
            { promptText, scale: scale.trim(), slug },
            {
              onError: (err) => setError(errMsg(err, 'The rubric could not be created')),
              onSuccess: (res) => {
                setSlug('');
                setPromptText('');
                onCreated(res.scanWarnings ?? []);
              },
            }
          );
        }}
      >
        <Input
          error={slug !== '' && !slugOk ? 'Lowercase letters, digits, - and _ only.' : undefined}
          hint="Names the rubric in a judge scorer."
          label="Slug"
          maxLength={100}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="patch-quality"
          required
          value={slug}
        />
        <Input
          hint="The range the judge scores on. Default 0..1."
          label="Scale"
          maxLength={40}
          onChange={(e) => setScale(e.target.value)}
          required
          value={scale}
        />
        <Textarea
          label="Prompt"
          maxLength={50_000}
          mono={false}
          onChange={(e) => setPromptText(e.target.value)}
          required
          rows={10}
          value={promptText}
        />
        {error && <Alert variant="error">{error}</Alert>}
        <ModalFooter
          disabled={!canSave}
          isPending={create.isPending}
          onCancel={onClose}
          pendingLabel="Creating…"
          submitLabel="Create rubric"
        />
      </form>
    </Modal>
  );
}
