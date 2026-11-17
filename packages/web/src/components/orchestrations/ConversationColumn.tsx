'use client';

import type {
  OrchestrationDetailDto,
  OrchestrationMessageDto,
} from '@auto-swe/shared/lib/orchestrationApi';
import { type FormEvent, type KeyboardEvent, useState } from 'react';
import {
  ApprovalCard,
  AttachRequestCard,
  ChildResultCard,
} from '@/components/orchestrations/OrchestrationCards';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Textarea } from '@/components/ui/Textarea';
import {
  useAttachRepo,
  useDecideApproval,
  useDeclineAttach,
  useSendOrchestrationMessage,
} from '@/hooks/useOrchestrations';
import { describeOrchestrationError, finishedReason } from '@/lib/orchestration';
import { cn } from '@/lib/utils';

const MAX_MESSAGE_CHARS = 4000;

function authorLabel(message: OrchestrationMessageDto, detail: OrchestrationDetailDto): string {
  if (message.role === 'ORCHESTRATOR') {
    return 'Orchestrator';
  }
  if (message.role === 'SYSTEM') {
    return 'System';
  }
  const child = message.childId ? detail.children.find((c) => c.id === message.childId) : null;
  const who = detail.canControl ? 'You' : (detail.launchedByName ?? 'The launcher');
  return child ? `${who} to ${child.label}` : who;
}

function MessageRow({
  detail,
  message,
}: {
  detail: OrchestrationDetailDto;
  message: OrchestrationMessageDto;
}) {
  const attach = useAttachRepo(detail.id);
  const decline = useDeclineAttach(detail.id);
  const decide = useDecideApproval(detail.id);

  if (message.kind === 'ATTACH_REQUEST') {
    return (
      <AttachRequestCard
        canControl={detail.canControl}
        detail={detail}
        error={
          attach.isError
            ? describeOrchestrationError(attach.error)
            : decline.isError
              ? describeOrchestrationError(decline.error)
              : null
        }
        message={message}
        onAttach={(repoId) => attach.mutate(repoId)}
        onDecline={() => decline.mutate()}
        pending={attach.isPending || decline.isPending}
      />
    );
  }
  if (message.kind === 'APPROVAL_REQUEST') {
    return (
      <ApprovalCard
        canControl={detail.canControl}
        detail={detail}
        error={decide.isError ? describeOrchestrationError(decide.error) : null}
        message={message}
        onDecide={(approvalId, decision) => decide.mutate({ approvalId, decision })}
        pending={decide.isPending}
      />
    );
  }
  if (message.kind === 'CHILD_RESULT') {
    return <ChildResultCard detail={detail} message={message} />;
  }
  const label = authorLabel(message, detail);
  if (message.kind === 'NOTICE') {
    return (
      <div className="rounded-lg border border-dashed border-ink-400 px-3 py-2 text-sm text-paper-400">
        <span className="font-medium text-paper-300">Notice: </span>
        <span className="whitespace-pre-wrap break-words">{message.body}</span>
      </div>
    );
  }
  const mine = message.role === 'USER';
  return (
    <div className={cn('flex flex-col gap-1', mine && 'items-end')}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-paper-500">
        <span className="font-medium text-paper-300">{label}</span>
        <RelativeTime value={message.createdAt} />
      </div>
      <p
        className={cn(
          'max-w-full whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-sm text-paper-100 sm:max-w-[85%]',
          mine ? 'border-accent-400/40 bg-accent-400/10' : 'border-ink-400 bg-ink-700'
        )}
      >
        {message.body}
      </p>
    </div>
  );
}

function Composer({ detail }: { detail: OrchestrationDetailDto }) {
  const send = useSendOrchestrationMessage(detail.id);
  const [text, setText] = useState('');
  const reason = finishedReason(detail.status);
  const body = text.trim();
  const tooLong = text.length > MAX_MESSAGE_CHARS;
  const disabled = reason !== null;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (disabled || !body || tooLong || send.isPending) {
      return;
    }
    send.mutate(body, { onSuccess: () => setText('') });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      submit();
    }
  };

  return (
    <form className="space-y-2 border-t border-ink-600 pt-3" onSubmit={submit}>
      <Textarea
        disabled={disabled}
        error={tooLong ? `At most ${MAX_MESSAGE_CHARS} characters` : undefined}
        hint={reason ?? 'Press Ctrl+Enter to send.'}
        label="Message to the orchestrator"
        mono={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
        value={text}
      />
      {send.isError && <Alert variant="error">{describeOrchestrationError(send.error)}</Alert>}
      <div className="flex justify-end">
        <Button
          disabled={disabled || !body || tooLong || send.isPending}
          type="submit"
          variant="primary"
        >
          {send.isPending ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </form>
  );
}

/** The chat with the orchestrator: transcript, inline cards, and (for the launcher) a composer. */
export function ConversationColumn({
  detail,
  messages,
}: {
  detail: OrchestrationDetailDto;
  messages: OrchestrationMessageDto[];
}) {
  return (
    <section aria-label="Conversation" className="flex min-w-0 flex-col gap-3">
      {/* A polite live region: new messages are announced without stealing focus. */}
      <div aria-label="Conversation messages" aria-live="polite" className="space-y-3" role="log">
        {messages.length === 0 ? (
          <EmptyState
            hint="The orchestrator’s first reply appears here."
            icon="chat"
            title="No messages yet"
          />
        ) : (
          messages.map((message) => (
            <MessageRow detail={detail} key={message.id} message={message} />
          ))
        )}
      </div>
      {detail.canControl ? (
        <Composer detail={detail} />
      ) : (
        <p className="border-t border-ink-600 pt-3 text-sm text-paper-500">
          <Badge tone="neutral">Read only</Badge>{' '}
          {detail.launchedByName ?? 'The person who launched this'} is the only one who can send
          messages, attach a repository or approve calls.
        </p>
      )}
    </section>
  );
}
