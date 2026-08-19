'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SparkleIcon } from '@/components/ui/icons';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { useRefineWorkflowTemplate } from '@/hooks/useWorkflows';
import { errMsg } from '@/lib/errors';

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
      subtitle="Describe a change in plain language. Each message saves a new DRAFT version — review it on the canvas, then activate."
      title="Refine with AI"
    >
      <div className="space-y-4">
        <div
          className="max-h-[45vh] min-h-[8rem] space-y-3 overflow-y-auto rounded-lg border border-ink-600 bg-ink-800/40 p-3"
          ref={scrollRef}
        >
          {messages.length === 0 ? (
            <p className="py-6 text-center text-sm text-paper-500">
              e.g. “add a security review step before the PR” or “pause for human approval before
              merge”.
            </p>
          ) : (
            messages.map((m) => (
              <div
                className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
                key={m.id}
              >
                <div
                  className={
                    m.role === 'user'
                      ? 'max-w-[80%] rounded-lg bg-ember-600/20 px-3 py-2 text-sm text-paper-100'
                      : `max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                          m.isError ? 'bg-brick-400/10 text-brick-300' : 'bg-ink-700 text-paper-200'
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
              <div className="rounded-lg bg-ink-700 px-3 py-2 text-sm text-paper-400">
                Refining…
              </div>
            </div>
          )}
        </div>

        <Textarea
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

        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="secondary">
            Done
          </Button>
          <Button
            disabled={!input.trim() || refine.isPending}
            onClick={handleSend}
            variant="primary"
          >
            {refine.isPending ? 'Refining…' : 'Send'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
