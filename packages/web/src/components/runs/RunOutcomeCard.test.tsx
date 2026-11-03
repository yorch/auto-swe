// @vitest-environment jsdom

import { NO_CRITERIA_REASON } from '@auto-swe/shared/lib/agentPrompts';
import { TICKET_FAILURE_CLASSES } from '@auto-swe/shared/lib/integrations/ticketFailure';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  RunOutcomeCard,
  TICKET_UNAVAILABLE_HINTS,
  TICKET_UNAVAILABLE_LINES,
  TICKET_UNAVAILABLE_WORKAROUND,
} from './RunOutcomeCard';

describe('RunOutcomeCard', () => {
  it('renders nothing for an unknown template', () => {
    const { container } = render(
      <RunOutcomeCard result={{ text: 'hello' }} runId="run-1" templateName="custom" />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a Notion outcome with page link', () => {
    render(
      <RunOutcomeCard
        result={{ targetPageId: 'page-123', text: 'Draft content' }}
        runId="run-1"
        templateName="notion-content-draft"
      />
    );
    expect(screen.getByText(/Draft content/)).toBeTruthy();
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://notion.so/page-123');
  });

  it('renders a product PRD outcome with page link', () => {
    render(
      <RunOutcomeCard
        result={{ targetPageId: 'page-456', text: 'PRD body text' }}
        runId="run-1"
        templateName="product-prd-draft"
      />
    );
    expect(screen.getByText(/PRD body text/)).toBeTruthy();
  });

  it('renders a Slack outcome with channel and posted status', () => {
    render(
      <RunOutcomeCard
        result={{ channelId: 'C123', posted: true, text: 'Hello channel' }}
        runId="run-1"
        templateName="send-slack-update"
      />
    );
    expect(screen.getByText(/#C123/)).toBeTruthy();
    expect(screen.getByText('Posted')).toBeTruthy();
    expect(screen.getByText(/Hello channel/)).toBeTruthy();
  });

  it('renders an issue tracker outcome with issue link', () => {
    render(
      <RunOutcomeCard
        result={{
          description: 'Something is broken',
          issueUrl: 'https://linear.app/issue/TEAM-1',
          title: 'Bug',
        }}
        runId="run-1"
        templateName="create-issue"
      />
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://linear.app/issue/TEAM-1');
    expect(screen.getByText(/Something is broken/)).toBeTruthy();
  });

  it('renders an issue tracker outcome for the from-brief template', () => {
    render(
      <RunOutcomeCard
        result={{
          description: 'Drafted from brief',
          issueUrl: 'https://x.atlassian.net/browse/PROJ-9',
          title: 'Refactor auth',
        }}
        runId="run-1"
        templateName="create-issue-from-brief"
      />
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://x.atlassian.net/browse/PROJ-9');
    expect(screen.getByText(/Drafted from brief/)).toBeTruthy();
  });

  it('does not render a malicious issueUrl as a link', () => {
    const { container } = render(
      <RunOutcomeCard
        result={{
          description: 'Should not be clickable',
          issueUrl: 'javascript:alert(1)',
          title: 'Evil',
        }}
        runId="run-1"
        templateName="create-issue"
      />
    );
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText(/Should not be clickable/)).toBeTruthy();
  });
});

describe('a spilled result text', () => {
  it('offers the full text where a template shows its text output', () => {
    const id = '7a9619ff-8b86-4a08-8b86-3e6f9619ffd2';
    render(
      <RunOutcomeCard
        result={{ text: `[stored as artifact ${id} — 9000 bytes]`, ticketId: 'Z-1' }}
        runId="run-1"
        templateName="zendesk-ticket-reply"
      />
    );
    expect(screen.getByRole('button', { name: 'View full text (9,000 bytes)' })).toBeTruthy();
  });

  describe('a run that stopped with a message', () => {
    it('shows the message of any template, and no more than that when there are no ambiguities', () => {
      const { container } = render(
        <RunOutcomeCard
          result={{ message: 'The request is not actionable: paste the ticket text.' }}
          runId="run-1"
          templateName="ticket-to-merge"
        />
      );
      expect(screen.getByText(/The request is not actionable/)).toBeTruthy();
      expect(container.querySelector('ul')).toBeNull();
    });

    it('is drawn in the warning tone, not the success one other cards use', () => {
      const { container } = render(
        <RunOutcomeCard result={{ message: 'Stopped.' }} runId="run-1" templateName="x" />
      );
      const icon = container.querySelector('h3 svg');
      expect(icon?.getAttribute('class')).toContain('text-warning-400');
      expect(icon?.getAttribute('class')).not.toContain('text-success-400');
    });

    it('leaves the pull request card in the success tone', () => {
      const { container } = render(
        <RunOutcomeCard
          result={{ prNumber: 7, prUrl: 'https://github.com/acme/api/pull/7' }}
          runId="run-1"
          templateName="ticket-to-merge"
        />
      );
      const classes = container.querySelector('h3 svg')?.getAttribute('class');
      expect(classes).toContain('text-success-400');
      expect(classes).not.toContain('text-warning-400');
    });

    it('lists the ambiguities as plain text, not markup', () => {
      const { container } = render(
        <RunOutcomeCard
          result={{
            ambiguities: ['only a Jira URL', '<img src=x onerror=alert(1)>', 42],
            message: 'The request is not actionable.',
          }}
          runId="run-1"
          templateName="ticket-to-merge"
        />
      );
      const items = [...container.querySelectorAll('li')].map((li) => li.textContent);
      expect(items).toEqual(['only a Jira URL', '<img src=x onerror=alert(1)>']);
      expect(container.querySelector('img')).toBeNull();
    });

    const LINES: Record<string, string> = {
      empty: 'The ticket was read from the tracker but has no text.',
      forbidden: 'The ticket could not be read from the tracker (access was refused).',
      network: 'The ticket could not be read from the tracker (the tracker could not be reached).',
      no_repository:
        'The platform could not resolve a repository from the ticket id, so it did not write to it.',
      no_transition:
        'No transition to a status named like the one the platform looks for was found on the ticket (the project may name its statuses differently), so nothing was written.',
      not_found:
        'The ticket could not be read from the tracker (access was refused, or it does not exist).',
      out_of_scope: 'The ticket is in a repository this run does not target.',
      rate_limited:
        'The ticket could not be read from the tracker (the tracker is limiting requests).',
      redirect:
        'The ticket could not be read from the tracker (the tracker address redirects, which is not followed).',
      refused:
        "The ticket could not be read from the tracker (it was blocked by the platform's network policy).",
      rejected: 'The ticket could not be read from the tracker (it rejected the request).',
      server_error:
        'The ticket could not be read from the tracker (the tracker returned an error).',
      timeout:
        'The ticket could not be read from the tracker (the tracker did not answer in time).',
      unauthorized:
        'The ticket could not be read from the tracker (the tracker rejected its credentials).',
      unconfigured:
        'The ticket could not be read from the tracker (no ticket tracker is configured).',
      unknown: 'The ticket could not be read (the reason is not known).',
    };

    it('has a line for every failure class, and no line for anything else', () => {
      expect([...TICKET_UNAVAILABLE_LINES.keys()].sort()).toEqual(
        [...TICKET_FAILURE_CLASSES].sort()
      );
      expect(Object.keys(LINES).sort()).toEqual([...TICKET_FAILURE_CLASSES].sort());
    });

    // Classes that are not read failures: 'empty' means the ticket was read but had no text. A new
    // failure class must be consciously placed: either it gets a hint (unreadable) or it is added here.
    // Classes that are not a failure to read the ticket: 'empty' means it was read, and
    // 'out_of_scope' is write-only (a refused read is reported as 'not_found'), so neither leads
    // the card or has a hint. A new class must be placed here or given a hint.
    const NOT_READ_FAILURES = ['empty', 'out_of_scope', 'no_repository', 'no_transition'];
    const UNREADABLE = [...TICKET_FAILURE_CLASSES].filter((c) => !NOT_READ_FAILURES.includes(c));

    // The literal the validate phase stores (packages/shared/.../authoring/validatePhase.ts).
    const REAL_MESSAGE =
      'The request is not actionable: validation found nothing it could verify, only the ambiguities listed here. Paste the ticket text or add acceptance criteria to the request, then re-run.';

    it('has a next-step hint for every unreadable class, and none for anything else', () => {
      expect([...TICKET_UNAVAILABLE_HINTS.keys()].sort()).toEqual([...UNREADABLE].sort());
    });

    it('uses distinct hint wording where the advice differs', () => {
      // 12 hints, 11 distinct: unauthorized and forbidden intentionally share their advice.
      expect(new Set(TICKET_UNAVAILABLE_HINTS.values()).size).toBe(
        TICKET_UNAVAILABLE_HINTS.size - 1
      );
      expect(TICKET_UNAVAILABLE_HINTS.get('unauthorized')).toBe(
        TICKET_UNAVAILABLE_HINTS.get('forbidden')
      );
    });

    it.each(UNREADABLE)(
      'leads with the failure for %s, then the hint, then the workaround',
      (reason) => {
        const { container } = render(
          <RunOutcomeCard
            result={{
              ambiguities: ['The ticket only states Vuln UIP-1.'],
              message: REAL_MESSAGE,
              ticketUnavailableReason: reason,
            }}
            runId="run-1"
            templateName="ticket-to-merge"
          />
        );
        const text = container.textContent ?? '';
        const line = TICKET_UNAVAILABLE_LINES.get(reason) ?? '';
        const hint = TICKET_UNAVAILABLE_HINTS.get(reason) ?? '';
        expect(line).not.toBe('');
        expect(hint).not.toBe('');
        expect(text.indexOf(line)).toBeGreaterThanOrEqual(0);
        expect(text.indexOf(hint)).toBeGreaterThan(text.indexOf(line));
        expect(text.indexOf(TICKET_UNAVAILABLE_WORKAROUND)).toBeGreaterThan(text.indexOf(hint));
        // The ambiguities are only reachable inside a closed <details> (see the describe below).
        expect(container.querySelector('details[open]')).toBeNull();
        expect(container.querySelectorAll('details > ul > li')).toHaveLength(1);
        // F1: the stored message is not rendered on this path, and nothing dangles.
        expect(text).not.toContain(REAL_MESSAGE);
        expect(text).not.toContain('not actionable');
        expect(text).not.toContain('listed here');
        // F6: the lead is bright and medium weight, and differs from the hint.
        const leadClass = screen.getByText(line).className;
        const hintClass = screen.getByText(hint).className;
        expect(leadClass).toMatch(/\bfont-medium\b/);
        expect(leadClass).toMatch(/\btext-paper-100\b/);
        expect(leadClass).not.toBe(hintClass);
        expect(hintClass).not.toMatch(/font-medium|text-paper-100/);
        expect(hint).not.toMatch(/\byou\b|\byour\b/i);
      }
    );

    it('offers the workaround as plain own-copy text without blaming the requester', () => {
      expect(TICKET_UNAVAILABLE_WORKAROUND).toMatch(/paste the ticket text/i);
      expect(TICKET_UNAVAILABLE_WORKAROUND).toMatch(/acceptance criteria/);
      // It must not point at a list the unreadable path hides.
      expect(TICKET_UNAVAILABLE_WORKAROUND).not.toContain('listed here');
    });

    it.each(['', 'empty', undefined])(
      'still renders the real message (and ambiguities) when the reason is %j',
      (ticketUnavailableReason) => {
        const { container } = render(
          <RunOutcomeCard
            result={{
              ambiguities: ['Which component?'],
              message: REAL_MESSAGE,
              ticketUnavailableReason,
            }}
            runId="run-1"
            templateName="ticket-to-merge"
          />
        );
        const text = container.textContent ?? '';
        expect(text).toContain(REAL_MESSAGE);
        expect(text).toContain('Which component?');
        expect(text).not.toContain(TICKET_UNAVAILABLE_WORKAROUND);
      }
    );

    it('keeps the old order for the empty class', () => {
      const { container } = render(
        <RunOutcomeCard
          result={{
            message: REAL_MESSAGE,
            ticketUnavailableReason: 'empty',
          }}
          runId="run-1"
          templateName="ticket-to-merge"
        />
      );
      const text = container.textContent ?? '';
      expect(text).toContain(REAL_MESSAGE);
      expect(text).toContain(LINES.empty);
      expect(text.indexOf(REAL_MESSAGE)).toBeLessThan(text.indexOf(LINES.empty));
    });

    describe('ambiguities on the unreadable path', () => {
      const REAL_AMBIGUITY =
        "The ticket only states 'Vuln UIP-15211' and gives no description, so the intended change cannot be determined.";
      const renderUnreadable = (ambiguities: unknown) =>
        render(
          <RunOutcomeCard
            result={{
              ambiguities,
              message: REAL_MESSAGE,
              ticketUnavailableReason: 'not_found',
            }}
            runId="run-1"
            templateName="ticket-to-merge"
          />
        ).container;

      it('puts them in a closed details after the workaround, as plain list items', () => {
        const container = renderUnreadable([REAL_AMBIGUITY]);
        const details = container.querySelectorAll('details');
        expect(details).toHaveLength(1);
        const el = details[0] as HTMLDetailsElement;
        expect(el.open).toBe(false);
        expect(el.hasAttribute('open')).toBe(false);
        expect(el.textContent).toContain(REAL_AMBIGUITY);
        expect(el.querySelector('summary')?.textContent ?? '').not.toMatch(/\byou\b|\byour\b/i);
        expect(el.querySelectorAll('ul > li')).toHaveLength(1);
        // Every list item of the card is inside the details: none is rendered outside it too.
        expect(container.querySelectorAll('li')).toHaveLength(1);
        expect(el.querySelector('li')?.children).toHaveLength(0);
        // The lead, hint and workaround keep their order and the details comes after all of them.
        const text = container.textContent ?? '';
        expect(text.indexOf(REAL_AMBIGUITY)).toBeGreaterThan(
          text.indexOf(TICKET_UNAVAILABLE_WORKAROUND)
        );
        const workaround = screen.getByText(TICKET_UNAVAILABLE_WORKAROUND);
        expect(
          workaround.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        // The stored message still does not render.
        expect(text).not.toContain('listed here');
      });

      it.each([
        ['empty', []],
        ['missing', undefined],
        ['non-array', 'text'],
        ['non-string items', [1, null, { a: 1 }]],
      ])('renders no details when the ambiguities are %s', (_label, ambiguities) => {
        expect(renderUnreadable(ambiguities).querySelector('details')).toBeNull();
      });

      it('renders no details when the only entry is the no-criteria reason, even repeated', () => {
        expect(renderUnreadable([NO_CRITERIA_REASON]).querySelector('details')).toBeNull();
        expect(
          renderUnreadable([NO_CRITERIA_REASON, NO_CRITERIA_REASON]).querySelector('details')
        ).toBeNull();
      });

      it('keeps the details, with both entries, when the reason comes with a real ambiguity', () => {
        const container = renderUnreadable([NO_CRITERIA_REASON, REAL_AMBIGUITY]);
        expect(container.querySelectorAll('details')).toHaveLength(1);
        expect(container.querySelectorAll('details li')).toHaveLength(2);
      });

      it('keeps the details for real ambiguities only', () => {
        const container = renderUnreadable([REAL_AMBIGUITY]);
        expect(container.querySelectorAll('details li')).toHaveLength(1);
      });

      it('de-duplicates and truncates the items, ignoring non-strings', () => {
        const long = 'x'.repeat(900);
        const container = renderUnreadable(['A one', 'A one', 7, long]);
        const items = [...container.querySelectorAll('details li')].map((li) => li.textContent);
        expect(items).toHaveLength(2);
        expect(items[0]).toBe('A one');
        expect((items[1] ?? '').length).toBeLessThan(long.length);
        expect(items[1]).toMatch(/^x+/);
      });

      it('does not add a details to the non-unreadable path, which keeps its visible list', () => {
        const { container } = render(
          <RunOutcomeCard
            result={{ ambiguities: ['Which component?'], message: REAL_MESSAGE }}
            runId="run-1"
            templateName="ticket-to-merge"
          />
        );
        expect(container.querySelector('details')).toBeNull();
        expect(container.querySelectorAll('ul > li')).toHaveLength(1);
      });
    });

    describe('hint wording', () => {
      const hint = (reason: string) => TICKET_UNAVAILABLE_HINTS.get(reason) ?? '';
      const TRANSIENT = ['rate_limited', 'server_error', 'timeout', 'network'];
      const ADMIN_CHECK = ['redirect', 'unconfigured', 'unauthorized', 'forbidden', 'refused'];

      it.each(TRANSIENT)('%s says to try again and does not blame credentials', (reason) => {
        expect(hint(reason)).toMatch(/try again in a few minutes/);
        expect(hint(reason)).toMatch(/administrator/);
        expect(hint(reason)).toMatch(/keeps happening/);
        expect(hint(reason)).not.toMatch(/credentials/);
        expect(hint(reason)).toMatch(/not the requester/);
      });

      it.each(ADMIN_CHECK)('%s asks an administrator and is not the requester', (reason) => {
        expect(hint(reason)).toMatch(/administrator/);
        expect(hint(reason)).toMatch(/not the requester/);
      });

      it('rejected points at the platform tracker settings, not the ticket id', () => {
        expect(hint('rejected')).toMatch(/not the requester/);
        expect(hint('rejected')).toMatch(/administrator.*tracker settings/);
        expect(hint('rejected')).not.toMatch(/ticket id|credentials/);
        expect(LINES.rejected).not.toMatch(/check/);
        expect(LINES.refused).not.toMatch(/administrator|check/);
      });

      it('not_found keeps the not-the-requester framing without leading on the id', () => {
        expect(hint('not_found')).toMatch(/token/);
        expect(hint('not_found')).toMatch(/ticket id/);
        expect(hint('not_found')).toMatch(/administrator/);
        expect(hint('not_found')).not.toMatch(/^Check the ticket id/);
        // The token and the platform come before the id, and it is not the requester's fault.
        expect(hint('not_found').search(/token/)).toBeLessThan(
          hint('not_found').search(/ticket id/)
        );
        expect(hint('not_found')).not.toMatch(/looks wrong|you |your /i);
      });

      it('unknown does not blame the tracker or its credentials', () => {
        expect(hint('unknown')).toMatch(/platform/);
        expect(hint('unknown')).toMatch(/administrator/);
        expect(hint('unknown')).not.toMatch(/tracker|credentials/);
      });

      it('has a rule for every unreadable class', () => {
        const covered = [...TRANSIENT, ...ADMIN_CHECK, 'rejected', 'not_found', 'unknown'];
        expect([...covered].sort()).toEqual([...UNREADABLE].sort());
      });
    });

    it.each(Object.entries(LINES))('adds one neutral line for the class %s', (reason, line) => {
      render(
        <RunOutcomeCard
          result={{ message: 'The request is not actionable.', ticketUnavailableReason: reason }}
          runId="run-1"
          templateName="ticket-to-merge"
        />
      );
      expect(screen.getByText(line).textContent).not.toMatch(/\byou\b|\byour\b/i);
    });

    it('does not blame the tracker for an unknown reason or a ticket that was read', () => {
      expect(LINES.unknown).not.toMatch(/from the tracker/);
      expect(LINES.empty).toMatch(/was read/);
    });

    it('adds no line when the reason is empty, absent or not a known class', () => {
      for (const ticketUnavailableReason of ['', undefined, 7, 'constructor', '<b>x</b>']) {
        const { container, unmount } = render(
          <RunOutcomeCard
            result={{ message: 'The request is not actionable.', ticketUnavailableReason }}
            runId="run-1"
            templateName="ticket-to-merge"
          />
        );
        expect(container.textContent).not.toMatch(/could not be read/);
        expect(container.querySelector('b')).toBeNull();
        unmount();
      }
    });

    it('never renders markup from the reason or the ambiguities as elements', () => {
      const payload = '<img src=x onerror=alert(1)>';
      const { container } = render(
        <RunOutcomeCard
          result={{
            ambiguities: [payload],
            message: 'The request is not actionable.',
            ticketUnavailableReason: payload,
          }}
          runId="run-1"
          templateName="ticket-to-merge"
        />
      );
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain(payload);
      expect(container.textContent).not.toMatch(/could not be read/);
    });

    it('still renders nothing for a result with neither a message nor a known shape', () => {
      const { container } = render(
        <RunOutcomeCard
          result={{ ambiguities: ['x'], text: 'hello' }}
          runId="run-1"
          templateName="ticket-to-merge"
        />
      );
      expect(container.firstChild).toBeNull();
    });
  });
});
