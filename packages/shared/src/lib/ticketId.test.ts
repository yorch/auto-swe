import { describe, expect, it } from 'vitest';
import { isValidTicketId } from './ticketId.js';

describe('isValidTicketId', () => {
  it.each(['JIRA-123', 'owner/repo#42', 'task_1.2'])('accepts %s', (id) => {
    expect(isValidTicketId(id)).toBe(true);
  });
  it.each(['', 'bad..id', 'task/', 'task.', 'has spaces', '-leading', 'x'.repeat(101)])(
    'rejects %s',
    (id) => {
      expect(isValidTicketId(id)).toBe(false);
    }
  );
});
