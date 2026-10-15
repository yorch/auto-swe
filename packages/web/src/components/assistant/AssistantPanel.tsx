'use client';

import type {
  AssistantMessageView,
  AssistantToolStep,
} from '@auto-swe/shared/lib/assistantConversation';
import {
  isAssistantReplyOpen,
  MAX_ASSISTANT_MESSAGE_CHARS,
} from '@auto-swe/shared/lib/assistantConversation';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SparkleIcon } from '@/components/ui/icons';
import {
  useAssistantConversation,
  useAssistantConversations,
  useAssistantReplyStream,
  useAssistantStatus,
  useCloseAssistantConversation,
  useSendAssistantMessage,
} from '@/hooks/useAssistant';
import { pageContextFor } from '@/lib/assistantPageContext';
import { isSafeExternalUrl } from '@/lib/docLinks';
import { errMsg } from '@/lib/errors';
import { cn, FOCUS_RING } from '@/lib/utils';
import { useAssistantStore } from '@/stores/assistantStore';

export const ASSISTANT_PANEL_ID = 'assistant-panel';

/**
 * The in-app assistant: a slide-out panel on every dashboard page (`docs/adr/in-app-assistant.md`
 * D8). Each message carries the page it was sent from, the reply streams in as it is written, and
 * the assistant's tool calls show as collapsible steps under it.
 */

/** The top-bar button that opens and closes the panel. Hidden while the assistant is off. */
export function AssistantToggle() {
  const { data: status } = useAssistantStatus();
  const { open, toggle } = useAssistantStore();
  if (!status?.enabled) {
    return null;
  }
  return (
    <button
      aria-controls={ASSISTANT_PANEL_ID}
      aria-expanded={open}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-ink-400 px-2.5 py-1 text-xs font-semibold text-paper-300 transition-colors hover:border-ember-400/60 hover:text-paper-100',
        open && 'border-ember-400/60 text-ember-300',
        FOCUS_RING
      )}
      onClick={toggle}
      type="button"
    >
      <SparkleIcon size={12} />
      <span className="max-sm:hidden">Assistant</span>
      <span className="sr-only sm:hidden">Assistant</span>
    </button>
  );
}

export function AssistantPanel() {
  const { data: status } = useAssistantStatus();
  const { open, setOpen } = useAssistantStore();

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen]);

  if (!status?.enabled || !open) {
    return null;
  }
  return (
    <aside
      aria-label="Assistant"
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-ink-500/70 bg-ink-950 shadow-2xl sm:w-[420px]"
      id={ASSISTANT_PANEL_ID}
    >
      <PanelBody />
    </aside>
  );
}

function PanelBody() {
  const { conversationId, select, setOpen, showingList, showList } = useAssistantStore();
  const conversations = useAssistantConversations(showingList);
  const conversation = useAssistantConversation(conversationId);
  const close = useCloseAssistantConversation();
  const messages = conversation.data?.messages;
  useAssistantReplyStream(conversationId, messages);

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-ink-500/70 px-4">
        <SparkleIcon className="text-ember-300" size={14} />
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-paper-100">
          {showingList ? 'Conversations' : (conversation.data?.conversation.title ?? 'Assistant')}
        </h2>
        <HeaderButton label="New conversation" onClick={() => select(null)}>
          New
        </HeaderButton>
        <HeaderButton
          label={showingList ? 'Back to the conversation' : 'Show conversations'}
          onClick={() => showList(!showingList)}
        >
          {showingList ? 'Back' : 'History'}
        </HeaderButton>
        <HeaderButton label="Close the assistant" onClick={() => setOpen(false)}>
          <span aria-hidden="true">✕</span>
        </HeaderButton>
      </header>

      {showingList ? (
        <ul className="flex-1 overflow-y-auto p-2">
          {conversations.isLoading && <li className="p-3 text-sm text-paper-500">Loading…</li>}
          {conversations.data?.length === 0 && (
            <li className="p-3 text-sm text-paper-500">No conversations yet.</li>
          )}
          {conversations.data?.map((c) => (
            <li className="group flex items-center gap-1" key={c.id}>
              <button
                className={cn(
                  'min-w-0 flex-1 truncate rounded-md px-3 py-2 text-left text-sm text-paper-300 hover:bg-ink-700 hover:text-paper-100',
                  c.id === conversationId && 'bg-ink-700 text-paper-100',
                  FOCUS_RING
                )}
                onClick={() => select(c.id)}
                type="button"
              >
                {c.title}
              </button>
              <button
                aria-label={`Remove “${c.title}”`}
                className={cn(
                  'rounded-md px-2 py-1 text-xs text-paper-500 hover:text-brick-400',
                  FOCUS_RING
                )}
                onClick={() => {
                  close.mutate(c.id);
                  if (c.id === conversationId) {
                    select(null);
                    showList(true);
                  }
                }}
                type="button"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <MessageList
            error={conversation.error ? errMsg(conversation.error) : null}
            messages={conversationId === null ? [] : messages}
          />
          <Composer
            busy={messages?.some((m) => m.role === 'ASSISTANT' && isAssistantReplyOpen(m.status))}
          />
        </>
      )}
    </>
  );
}

function HeaderButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className={cn(
        'rounded-md px-2 py-1 text-xs font-medium text-paper-400 hover:bg-ink-700 hover:text-paper-100',
        FOCUS_RING
      )}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function MessageList({
  messages,
  error,
}: {
  messages: AssistantMessageView[] | undefined;
  error: string | null;
}) {
  const end = useRef<HTMLDivElement | null>(null);
  const last = messages?.at(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the reply as it grows.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages?.length, last?.content, last?.steps.length]);

  return (
    <div aria-live="polite" className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
      {error && <p className="text-sm text-brick-400">{error}</p>}
      {messages?.length === 0 && (
        <div className="space-y-2 pt-6 text-center text-sm text-paper-500">
          <p>Ask how the platform works, how to configure it, or about the page you are on.</p>
          <p>The assistant acts as you and can only read for now.</p>
        </div>
      )}
      {messages?.map((m) =>
        m.role === 'USER' ? (
          <div className="flex justify-end" key={m.id}>
            <p className="max-w-[85%] whitespace-pre-wrap rounded-xl bg-ink-700 px-3 py-2 text-base text-paper-100">
              {m.content}
            </p>
          </div>
        ) : (
          <Reply key={m.id} message={m} />
        )
      )}
      <div ref={end} />
    </div>
  );
}

function Reply({ message }: { message: AssistantMessageView }) {
  const writing = isAssistantReplyOpen(message.status);
  return (
    <div className="space-y-2">
      {message.steps.length > 0 && (
        <ul className="space-y-1">
          {message.steps.map((step) => (
            <ToolStep key={step.id} step={step} />
          ))}
        </ul>
      )}
      {message.content && <AssistantMarkdown>{message.content}</AssistantMarkdown>}
      {writing && !message.content && (
        <p className="text-sm text-paper-500">
          {message.steps.length > 0 ? 'Working…' : 'Thinking…'}
        </p>
      )}
      {message.status === 'FAILED' && (
        <p className="text-sm text-brick-400">{message.error ?? 'The reply failed.'}</p>
      )}
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  callApi: 'Read from the API',
  describeApi: 'Looked up API routes',
  getPageContext: 'Checked this page',
  searchDocs: 'Searched the docs',
};

function ToolStep({ step }: { step: AssistantToolStep }) {
  return (
    <li>
      <details className="group rounded-md border border-ink-600 bg-ink-900/60 text-xs">
        <summary
          className={cn(
            'flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-paper-400',
            FOCUS_RING
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
              step.status === 'running' && 'animate-pulse bg-amber-400',
              step.status === 'done' && 'bg-moss-400',
              step.status === 'error' && 'bg-brick-400'
            )}
          />
          <span className="font-medium text-paper-300">{TOOL_LABELS[step.tool] ?? step.tool}</span>
          {step.summary && <span className="truncate text-paper-500">· {step.summary}</span>}
        </summary>
        <pre className="max-h-48 overflow-auto border-t border-ink-600 px-2.5 py-2 font-mono text-xs text-paper-400">
          {JSON.stringify(step.input, null, 2)}
        </pre>
      </details>
    </li>
  );
}

/**
 * Links in a reply: a dashboard path routes in the app, an http(s) URL opens in a new tab, and
 * anything else is shown as text. The reply is model output, so it is never trusted to say where a
 * link goes beyond that; raw HTML in it is not rendered at all.
 */
const replyLink: Components['a'] = ({ children, href, node: _node, ...rest }) => {
  if (href?.startsWith('/') && !href.startsWith('//')) {
    return (
      <Link href={href} {...rest}>
        {children}
      </Link>
    );
  }
  if (href && isSafeExternalUrl(href)) {
    return (
      <a href={href} rel="noopener noreferrer" target="_blank" {...rest}>
        {children}
      </a>
    );
  }
  return <span>{children}</span>;
};

export function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div
      className={cn(
        'text-base leading-6 text-paper-200',
        '[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_li]:my-0.5 [&_strong]:font-semibold [&_strong]:text-paper-100',
        '[&_a]:text-ember-300 [&_a]:underline [&_a]:decoration-ember-400/40 [&_a]:underline-offset-2',
        '[&_code]:rounded [&_code]:bg-ink-800 [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs',
        '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-ink-900 [&_pre]:p-2',
        '[&_h1]:text-lg [&_h2]:text-base [&_h3]:text-base [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold',
        '[&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-ink-600 [&_td]:px-2 [&_th]:border [&_th]:border-ink-600 [&_th]:px-2'
      )}
    >
      <ReactMarkdown components={{ a: replyLink }} remarkPlugins={[remarkGfm]}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

function Composer({ busy }: { busy: boolean | undefined }) {
  const pathname = usePathname();
  const { conversationId, select } = useAssistantStore();
  const send = useSendAssistantMessage();
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const disabled = busy || send.isPending;
  const submit = () => {
    const message = text.trim();
    if (!message || disabled) {
      return;
    }
    send.mutate(
      { conversationId, message, pageContext: pageContextFor(pathname) },
      {
        onSuccess: (result) => {
          setText('');
          if (conversationId === null) {
            select(result.conversationId);
          }
        },
      }
    );
  };

  return (
    <form
      className="shrink-0 border-t border-ink-500/70 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {send.error && <p className="mb-2 text-xs text-brick-400">{errMsg(send.error)}</p>}
      <label className="sr-only" htmlFor="assistant-input">
        Message the assistant
      </label>
      <textarea
        className="max-h-40 min-h-[4.5rem] w-full resize-y rounded-md border border-ink-200 bg-ink-900 px-3 py-2 text-base text-paper-100 outline-none placeholder:text-paper-600 hover:border-paper-600 focus:border-ember-400 focus:ring-2 focus:ring-ember-400/20"
        id="assistant-input"
        maxLength={MAX_ASSISTANT_MESSAGE_CHARS}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Ask about this page or how to configure something…"
        ref={input}
        value={text}
      />
      <div className="mt-2 flex items-center justify-between text-xs text-paper-500">
        <span>Enter to send · Shift+Enter for a new line</span>
        <button
          className={cn(
            'rounded-md bg-gradient-to-br from-ember-500 to-ember-600 px-3 py-1 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50',
            FOCUS_RING
          )}
          disabled={disabled || text.trim() === ''}
          type="submit"
        >
          {disabled ? 'Answering…' : 'Send'}
        </button>
      </div>
    </form>
  );
}
