// @vitest-environment jsdom

import type { AssistantMessageView } from '@auto-swe/shared/lib/assistantConversation';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantStore } from '@/stores/assistantStore';
import { AssistantMarkdown, AssistantPanel, AssistantToggle } from './AssistantPanel';

const state = vi.hoisted(() => ({
  enabled: true,
  list: [] as unknown[],
  messages: [] as unknown[],
  rename: vi.fn(),
  reset: vi.fn(),
  send: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/runs/run-42' }));
vi.mock('@/hooks/useAssistant', () => ({
  useAssistantConversation: (id: string | null) => ({
    data: id
      ? {
          conversation: { id, title: 'Why did it fail', titleSource: 'USER' },
          messages: state.messages,
        }
      : undefined,
    error: null,
  }),
  useAssistantConversations: () => ({ data: state.list, isLoading: false }),
  useAssistantReplyStream: () => undefined,
  useAssistantStatus: () => ({ data: { enabled: state.enabled } }),
  useCloseAssistantConversation: () => ({ mutate: vi.fn() }),
  useRenameAssistantConversation: () => ({ mutate: state.rename }),
  useResetAssistantTitle: () => ({ mutate: state.reset }),
  useSendAssistantMessage: () => ({ error: null, isPending: false, mutate: state.send }),
}));

const msg = (overrides: Partial<AssistantMessageView>): AssistantMessageView => ({
  content: '',
  createdAt: '2026-10-14T10:00:00Z',
  error: null,
  id: 'm',
  pageContext: null,
  role: 'ASSISTANT',
  status: 'COMPLETE',
  steps: [],
  ...overrides,
});

beforeEach(() => {
  state.enabled = true;
  state.messages = [];
  state.list = [];
  state.rename.mockReset();
  state.reset.mockReset();
  state.send.mockReset();
  useAssistantStore.setState({ conversationId: null, open: true, showingList: false });
});

afterEach(cleanup);

describe('AssistantToggle', () => {
  it('is not offered while the assistant is off', () => {
    state.enabled = false;
    render(<AssistantToggle />);
    expect(screen.queryByRole('button', { name: /assistant/i })).toBeNull();
  });

  it('opens and closes the panel', () => {
    useAssistantStore.setState({ open: false });
    render(<AssistantToggle />);
    fireEvent.click(screen.getByRole('button', { name: /assistant/i }));
    expect(useAssistantStore.getState().open).toBe(true);
  });
});

describe('AssistantPanel', () => {
  it('sends the message with the page it was sent from', () => {
    render(<AssistantPanel />);
    const box = screen.getByLabelText('Message the assistant');
    fireEvent.change(box, { target: { value: 'Why did this run fail?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(state.send).toHaveBeenCalledWith(
      {
        conversationId: null,
        message: 'Why did this run fail?',
        pageContext: { entityId: 'run-42', entityType: 'run', route: '/runs/run-42' },
      },
      expect.anything()
    );
  });

  it('shows a reply with its tool steps, and holds the next message while one is written', () => {
    useAssistantStore.setState({ conversationId: 'conv-1' });
    state.messages = [
      msg({ content: 'How do I add GitHub?', id: 'u1', role: 'USER' }),
      msg({
        content: 'Add a PAT. See [Integrations](/docs/configuration#integrations).',
        id: 'r1',
        status: 'STREAMING',
        steps: [
          {
            id: 's1',
            input: { query: 'github' },
            status: 'done',
            summary: '3 doc sections',
            tool: 'searchDocs',
          },
        ],
      }),
    ];
    render(<AssistantPanel />);
    expect(screen.getByText('Searched the docs')).toBeTruthy();
    expect(screen.getByText('· 3 doc sections')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Integrations' }).getAttribute('href')).toBe(
      '/docs/configuration#integrations'
    );
    expect(screen.getByRole('button', { name: 'Answering…' })).toHaveProperty('disabled', true);
  });

  it('shows why a reply failed', () => {
    useAssistantStore.setState({ conversationId: 'conv-1' });
    state.messages = [msg({ error: 'The assistant could not start.', status: 'FAILED' })];
    render(<AssistantPanel />);
    expect(screen.getByText('The assistant could not start.')).toBeTruthy();
  });

  it('renames the open conversation from its header', () => {
    useAssistantStore.setState({ conversationId: 'conv-1' });
    render(<AssistantPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename the conversation' }));
    const field = screen.getByLabelText('Conversation title');
    fireEvent.change(field, { target: { value: '  Run 42 failure ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(state.rename).toHaveBeenCalledWith({ id: 'conv-1', title: 'Run 42 failure' });
    expect(screen.queryByLabelText('Conversation title')).toBeNull();
  });

  it('cancels a rename on Escape without closing the panel', () => {
    useAssistantStore.setState({ conversationId: 'conv-1' });
    render(<AssistantPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename the conversation' }));
    const field = screen.getByLabelText('Conversation title');
    fireEvent.change(field, { target: { value: 'Something else' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(state.rename).not.toHaveBeenCalled();
    expect(useAssistantStore.getState().open).toBe(true);
    expect(screen.getByRole('heading', { name: 'Why did it fail' })).toBeTruthy();
  });

  it('names the conversation automatically from the rename field, without saving the typed text', () => {
    useAssistantStore.setState({ conversationId: 'conv-1' });
    render(<AssistantPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename the conversation' }));
    fireEvent.change(screen.getByLabelText('Conversation title'), {
      target: { value: 'Half-typed' },
    });
    const auto = screen.getByRole('button', { name: 'Name the conversation automatically' });
    // Tabbing to the button moves focus within the form, which must not save.
    fireEvent.blur(screen.getByLabelText('Conversation title'), { relatedTarget: auto });
    fireEvent.click(auto);
    expect(state.reset).toHaveBeenCalledWith('conv-1');
    expect(state.rename).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Conversation title')).toBeNull();
  });

  it('saves when focus leaves the rename form', () => {
    useAssistantStore.setState({ conversationId: 'conv-1' });
    render(<AssistantPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename the conversation' }));
    const field = screen.getByLabelText('Conversation title');
    fireEvent.change(field, { target: { value: 'Run 42' } });
    fireEvent.blur(field, { relatedTarget: null });
    expect(state.rename).toHaveBeenCalledWith({ id: 'conv-1', title: 'Run 42' });
  });

  it('renames a conversation from the history list', () => {
    useAssistantStore.setState({ showingList: true });
    state.list = [
      { id: 'conv-1', title: 'hi', titleSource: 'FIRST_MESSAGE' },
      { id: 'conv-2', title: 'Slack setup', titleSource: 'MODEL' },
    ];
    render(<AssistantPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename “hi”' }));
    const field = screen.getByLabelText('Conversation title');
    expect((field as HTMLInputElement).value).toBe('hi');
    fireEvent.change(field, { target: { value: 'Run 42 failure' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(state.rename).toHaveBeenCalledWith({ id: 'conv-1', title: 'Run 42 failure' });
    // The other row was never in rename mode, and the list stays open.
    expect(screen.getByRole('button', { name: 'Slack setup' })).toBeTruthy();
    expect(useAssistantStore.getState().showingList).toBe(true);
  });

  it('offers no rename before a conversation exists', () => {
    render(<AssistantPanel />);
    expect(screen.queryByRole('button', { name: 'Rename the conversation' })).toBeNull();
  });

  it('closes on Escape', () => {
    render(<AssistantPanel />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useAssistantStore.getState().open).toBe(false);
  });
});

describe('AssistantMarkdown', () => {
  it('links dashboard paths and http(s) URLs only, and renders no raw HTML', () => {
    const { container } = render(
      <AssistantMarkdown>
        {
          '[docs](/docs/x) [ext](https://example.com) [bad](javascript:alert(1)) [proto](//evil.example) <img src=x onerror=alert(1)>'
        }
      </AssistantMarkdown>
    );
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/docs/x', 'https://example.com']);
    expect(container.querySelector('img')).toBeNull();
  });
});
