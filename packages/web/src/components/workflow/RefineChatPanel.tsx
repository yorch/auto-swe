'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SparkleIcon } from '@/components/ui/icons';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { useRefineWorkflowTemplate } from '@/hooks/useTemplates';
import { errMsg } from '@/lib/errors';

const EXAMPLES = [
  'Add a security review step before the pull request',
  'Pause for human approval before merging',
  'Retry the tests twice before failing',
];

type ChatMessage = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  /** Advisory validation findings returned with a refinement. */
  warnings?: string[];
  /** Rendered as an error bubble when the refinement failed. */
  isError?: boolean;
};

/**
 * RefineChatPanel — conversationally refine a workflow template. Each message is
 * a plain-language change; the gateway seeds the author agent with the current
 * spec and saves the result as a NEW version, so the canvas (behind this modal)
 * reflects the latest version once the query invalidates. The transcript is
 * client-side and ephemeral — the saved versions are the durable record.
 */
export function RefineChatPanel({
  open,
  onClose,
  templateId,
}: {
  open: boolean;
  onClose: () => void;
  templateId: string;
}) {
  const refine = useRefineWorkflowTemplate(templateId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const nextId = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset the transcript when the panel closes so the next open starts fresh.
  useEffect(() => {
    if (!open) {
      setMessages([]);
      setInput('');
    }
  }, [open]);

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    if (messages.length === 0) {
      return;
    }
    scrollRef.current?.scrollTo({ behavior: 'smooth', top: scrollRef.current.scrollHeight });
  }, [messages]);

  const append = (msg: Omit<ChatMessage, 'id'>) => {
    const id = nextId.current++;
    setMessages((prev) => [...prev, { ...msg, id }]);
  };

  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt || refine.isPending) {
      return;
    }
    setInput('');
    append({ role: 'user', text: prompt });
    try {
      const res = await refine.mutateAsync(prompt);
      const version = res.data.version;
      const summary = res.summary?.trim();
      append({
        role: 'assistant',
        text: `Saved as version ${version}.${summary ? ` ${summary}` : ''}`,
        warnings: res.warnings,
      });
    } catch (err) {
      append({
        isError: true,
        role: 'assistant',
        text: errMsg(err, 'Refinement failed. Try rephrasing.'),
      });
    }
  };

  return (
    <Modal
      eyebrow="§ Workflow"
      onClose={onClose}
      open={open}
      size="lg"
      subtitle="Describe a change in plain language. Each message saves a new draft version for you to review on the canvas, then activate."
      title="Refine with AI"
    >
      <div className="space-y-4">
        <div
          aria-live="polite"
          className="max-h-[45vh] min-h-[8rem] space-y-3 overflow-y-auto rounded-lg border border-ink-600 bg-ink-900/50 p-3"
          ref={scrollRef}
        >
          {messages.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-5 text-center">
              <p className="text-[13px] text-paper-500">Try one of these, or write your own</p>
              <div className="flex flex-wrap justify-center gap-2">
                {EXAMPLES.map((example) => (
                  <Button key={example} onClick={() => setInput(example)} size="sm">
                    {example}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <div
                className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
                key={m.id}
              >
                <div
                  className={
                    m.role === 'user'
                      ? 'max-w-[80%] rounded-lg rounded-br-sm bg-ember-600/20 px-3 py-2 text-sm text-paper-100'
                      : `max-w-[80%] rounded-lg rounded-bl-sm px-3 py-2 text-sm ${
                          m.isError ? 'bg-brick-400/10 text-brick-400' : 'bg-ink-700 text-paper-200'
                        }`
                  }
                >
                  {m.role === 'assistant' && !m.isError && (
                    <SparkleIcon className="mr-1 inline-block align-[-2px] text-ember-400" />
                  )}
                  {m.text}
                  {m.warnings && m.warnings.length > 0 && (
                    <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-amber-400">
                      {m.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))
          )}
          {refine.isPending && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-lg rounded-bl-sm bg-ink-700 px-3 py-2 text-sm text-paper-400">
                <span
                  aria-hidden
                  className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-400 border-t-ember-400"
                />
                Refining…
              </div>
            </div>
          )}
        </div>

        <Textarea
          hint="Enter sends; Shift+Enter adds a line"
          label="Change request"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder="Describe the change…"
          rows={3}
          value={input}
        />

        <ModalFooter
          cancelLabel="Close"
          disabled={!input.trim()}
          isPending={refine.isPending}
          onCancel={onClose}
          onSubmit={handleSend}
          pendingLabel="Refining…"
          submitLabel="Send"
        />
      </div>
    </Modal>
  );
}
