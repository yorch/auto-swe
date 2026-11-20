import { clean } from './format.js';

/**
 * Presentation helpers shared by `teams requests` and `orgs requests`. The gateway owns the
 * rules; these only shape what the CLI prints. Server text is passed through `clean` so a
 * requester's message cannot drive the terminal.
 */

/** One join request as the gateway returns it. Optional fields are absent on some routes. */
export interface JoinRequestView {
  id: string;
  status: string;
  teamId?: string;
  teamName?: string;
  orgId?: string;
  orgName?: string;
  userId?: string;
  /** Reviewer views only: the person who asked. */
  requester?: { id?: string; name?: string | null; email?: string | null } | null;
  message?: string;
  requiresOrgApproval?: boolean;
  grantedRole?: string | null;
  teamDecisionNote?: string | null;
  orgDecisionNote?: string | null;
  createdAt?: string;
}

/** Column-aligned text table. The last column is not padded. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map(
    (h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)) + 2
  );
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? c.length)))
      .join('')
      .trimEnd();
  const body = [line(headers), ...rows.map((r) => line(r.map((c) => clean(c))))].join('\n');
  return `${body}\n`;
}

/** Text for an optional field: the value, or `-` when the server did not send one. */
export function orDash(value: string | null | undefined): string {
  return value === undefined || value === null || value === '' ? '-' : value;
}

/** The decision note that applies to a request's latest step, if any. */
export function latestNote(r: JoinRequestView): string {
  return orDash(r.orgDecisionNote ?? r.teamDecisionNote ?? null);
}

/** Who asked: the requester's name, else email, else id (own-request views have none). */
export function requesterText(r: JoinRequestView): string {
  const p = r.requester;
  return orDash(p?.name?.trim() || p?.email?.trim() || p?.id || r.userId);
}

/** Print a list of requests as a table with the columns the caller asks for. */
export function printRequests(rows: JoinRequestView[], columns: 'own' | 'review' | 'org'): void {
  if (rows.length === 0) {
    process.stdout.write('No join requests.\n');
    return;
  }
  if (columns === 'own') {
    process.stdout.write(
      renderTable(
        ['ID', 'TEAM', 'ORGANIZATION', 'STATUS', 'NOTE'],
        rows.map((r) => [r.id, orDash(r.teamName), orDash(r.orgName), r.status, latestNote(r)])
      )
    );
    return;
  }
  if (columns === 'review') {
    process.stdout.write(
      renderTable(
        ['ID', 'REQUESTER', 'STATUS', 'ORG STEP', 'ROLE', 'MESSAGE'],
        rows.map((r) => [
          r.id,
          requesterText(r),
          r.status,
          r.requiresOrgApproval ? 'yes' : 'no',
          orDash(r.grantedRole ?? null),
          orDash(r.message ?? null),
        ])
      )
    );
    return;
  }
  process.stdout.write(
    renderTable(
      ['ID', 'REQUESTER', 'TEAM', 'STATUS', 'ROLE', 'MESSAGE'],
      rows.map((r) => [
        r.id,
        requesterText(r),
        orDash(r.teamName ?? r.teamId),
        r.status,
        orDash(r.grantedRole ?? null),
        orDash(r.message ?? null),
      ])
    )
  );
}
