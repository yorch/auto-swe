'use client';

import type {
  AssistantConversationSummary,
  AssistantMessageView,
  AssistantPageContext,
} from '@auto-swe/shared/lib/assistantConversation';
import { isAssistantReplyOpen } from '@auto-swe/shared/lib/assistantConversation';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { API_BASE } from '@/lib/config';

/**
 * The in-app assistant panel's server state. Conversations and their messages come from
 * `/api/v1/assistant`; a reply being written arrives over a server-sent event stream and is
 * written straight into the conversation's cached messages.
 */

export interface AssistantConversationDetail {
  conversation: AssistantConversationSummary;
  messages: AssistantMessageView[];
}

const conversationKey = (id: string | null) => ['assistant', 'conversation', id] as const;
const LIST_KEY = ['assistant', 'conversations'] as const;

/** Whether the assistant is turned on. The panel is not offered while it is off. */
export function useAssistantStatus() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: { enabled: boolean } }>('/api/v1/assistant/status').then((r) => r.data),
    queryKey: ['assistant', 'status'],
    staleTime: 60_000,
  });
}

export function useAssistantConversations(enabled: boolean) {
  return useQuery({
    enabled,
    queryFn: () =>
      api
        .get<{ data: AssistantConversationSummary[] }>('/api/v1/assistant/conversations?limit=50')
        .then((r) => r.data),
    queryKey: LIST_KEY,
  });
}

function fetchConversation(id: string | null) {
  return api
    .get<{ data: AssistantConversationDetail }>(`/api/v1/assistant/conversations/${id}`)
    .then((r) => r.data);
}

export function useAssistantConversation(id: string | null) {
  return useQuery({
    enabled: id !== null,
    queryFn: () => fetchConversation(id),
    queryKey: conversationKey(id),
  });
}

/** Write a conversation's new title into the open conversation and the list. */
function writeConversation(qc: QueryClient, next: AssistantConversationSummary) {
  qc.setQueryData<AssistantConversationDetail>(conversationKey(next.id), (prev) =>
    prev ? { ...prev, conversation: next } : prev
  );
  qc.setQueryData<AssistantConversationSummary[]>(LIST_KEY, (prev) =>
    prev?.map((c) => (c.id === next.id ? next : c))
  );
}

interface SendInput {
  conversationId: string | null;
  message: string;
  pageContext: AssistantPageContext;
}

interface SendResult {
  conversationId: string;
  userMessage: AssistantMessageView;
  reply: AssistantMessageView;
}

/**
 * Send a message: to a new conversation when `conversationId` is null, else to that one. The
 * message and its empty reply are added to the cache at once, so the panel shows them before the
 * first streamed text arrives.
 */
export function useSendAssistantMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      conversationId,
      message,
      pageContext,
    }: SendInput): Promise<SendResult> => {
      if (conversationId === null) {
        const { data } = await api.post<{
          data: {
            conversation: AssistantConversationSummary;
            userMessage: AssistantMessageView;
            reply: AssistantMessageView;
          };
        }>('/api/v1/assistant/conversations', { message, pageContext });
        qc.setQueryData<AssistantConversationDetail>(conversationKey(data.conversation.id), {
          conversation: data.conversation,
          messages: [data.userMessage, data.reply],
        });
        return {
          conversationId: data.conversation.id,
          reply: data.reply,
          userMessage: data.userMessage,
        };
      }
      const { data } = await api.post<{
        data: { userMessage: AssistantMessageView; reply: AssistantMessageView };
      }>(`/api/v1/assistant/conversations/${conversationId}/messages`, { message, pageContext });
      qc.setQueryData<AssistantConversationDetail>(conversationKey(conversationId), (prev) =>
        prev ? { ...prev, messages: [...prev.messages, data.userMessage, data.reply] } : prev
      );
      return { conversationId, reply: data.reply, userMessage: data.userMessage };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

export function useCloseAssistantConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/assistant/conversations/${id}/close`, {}),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: conversationKey(id) });
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

/**
 * Rename a conversation. The new title is written into the open conversation and the list at once;
 * the assistant never renames one the user has.
 */
export function useRenameAssistantConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api
        .patch<{ data: AssistantConversationSummary }>(`/api/v1/assistant/conversations/${id}`, {
          title,
        })
        .then((r) => r.data),
    onSuccess: (renamed) => writeConversation(qc, renamed),
  });
}

/** How often, and how many times, the panel looks for a title being written after a reset. */
const TITLE_POLL_MS = 2500;
const TITLE_POLL_TRIES = 8;

/**
 * Re-read a conversation until the model has named it, or the user has, or the tries run out (the
 * model may decline: the first message's title then stays until a later turn names it).
 */
async function watchForTitle(qc: QueryClient, id: string) {
  for (let i = 0; i < TITLE_POLL_TRIES; i++) {
    await new Promise((resolve) => setTimeout(resolve, TITLE_POLL_MS));
    try {
      const detail = await qc.fetchQuery({
        queryFn: () => fetchConversation(id),
        queryKey: conversationKey(id),
        staleTime: 0,
      });
      if (detail.conversation.titleSource !== 'FIRST_MESSAGE') {
        writeConversation(qc, detail.conversation);
        return;
      }
    } catch {
      return;
    }
  }
}

/**
 * Give a conversation back to automatic naming: the title returns to its first message at once,
 * and the model's title replaces it a few seconds later when it writes one.
 */
export function useResetAssistantTitle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api
        .post<{ data: { conversation: AssistantConversationSummary; naming: boolean } }>(
          `/api/v1/assistant/conversations/${id}/title/reset`,
          {}
        )
        .then((r) => r.data),
    onSuccess: ({ conversation, naming }) => {
      writeConversation(qc, conversation);
      if (naming) {
        void watchForTitle(qc, conversation.id);
      }
    },
  });
}

/**
 * Follow the open reply in a conversation, if it has one, and write each update into the cache.
 * The stream ends itself when the reply finishes; it is reopened if the panel is (or the reply is
 * still open after the gateway's stream time limit).
 */
export function useAssistantReplyStream(
  conversationId: string | null,
  messages: AssistantMessageView[] | undefined
) {
  const qc = useQueryClient();
  // Bumped after a dropped stream, so a reply that is still open gets a fresh one.
  const [attempt, setAttempt] = useState(0);
  const open = messages?.find((m) => m.role === 'ASSISTANT' && isAssistantReplyOpen(m.status));
  const openId = open?.id ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the trigger that reopens the stream after a drop.
  useEffect(() => {
    if (!conversationId || !openId || typeof EventSource === 'undefined') {
      return;
    }
    const es = new EventSource(
      `${API_BASE}/api/v1/assistant/conversations/${conversationId}/messages/${openId}/stream`,
      { withCredentials: true }
    );
    const update = (next: AssistantMessageView) =>
      qc.setQueryData<AssistantConversationDetail>(conversationKey(conversationId), (prev) =>
        prev ? { ...prev, messages: prev.messages.map((m) => (m.id === next.id ? next : m)) } : prev
      );
    es.addEventListener('message', (event) => {
      try {
        update(JSON.parse((event as MessageEvent<string>).data) as AssistantMessageView);
      } catch {
        // A malformed event is skipped; the next one carries the whole reply again.
      }
    });
    es.addEventListener('done', () => {
      es.close();
      // The turn may have named the conversation, so its title is re-read with the list.
      qc.invalidateQueries({ queryKey: conversationKey(conversationId) });
      qc.invalidateQueries({ queryKey: LIST_KEY });
    });
    let retry: ReturnType<typeof setTimeout> | undefined;
    es.onerror = () => {
      // The gateway ended the stream (time limit) or the network dropped. Re-read the
      // conversation, and try again shortly if the reply is still open.
      es.close();
      qc.invalidateQueries({ queryKey: conversationKey(conversationId) });
      retry = setTimeout(() => setAttempt((n) => n + 1), 2000);
    };
    return () => {
      es.close();
      if (retry) {
        clearTimeout(retry);
      }
    };
  }, [conversationId, openId, qc, attempt]);
}
