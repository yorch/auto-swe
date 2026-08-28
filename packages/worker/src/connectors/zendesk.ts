import { ApplicationFailure } from '@temporalio/activity';

export interface ZendeskConnectionLike {
  apiToken: string;
  config: { email?: string | null; subdomain?: string | null };
}

function zendeskBaseUrl(connection: ZendeskConnectionLike): string {
  const subdomain = connection.config.subdomain;
  if (!subdomain) {
    throw ApplicationFailure.nonRetryable('Zendesk connection is missing subdomain');
  }
  return `https://${subdomain}.zendesk.com/api/v2`;
}

function zendeskAuth(connection: ZendeskConnectionLike): string {
  const email = connection.config.email;
  if (!email) {
    throw ApplicationFailure.nonRetryable('Zendesk connection is missing email');
  }
  return Buffer.from(`${email}/token:${connection.apiToken}`).toString('base64');
}

async function zendeskFetch<T>(
  connection: ZendeskConnectionLike,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = `${zendeskBaseUrl(connection)}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Basic ${zendeskAuth(connection)}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown');
    const status = response.status;
    if (status === 401 || status === 403) {
      throw ApplicationFailure.nonRetryable(`Zendesk API authentication failed (${status})`);
    }
    if (status === 404) {
      throw ApplicationFailure.nonRetryable(`Zendesk ticket not found (${status})`);
    }
    if (status >= 500 || status === 429) {
      throw ApplicationFailure.create({
        message: `Zendesk API transient error (${status}): ${body}`,
        type: 'ZendeskTransientError',
      });
    }
    throw ApplicationFailure.nonRetryable(`Zendesk API error (${status}): ${body}`);
  }

  return response.json() as Promise<T>;
}

export interface ZendeskTicket {
  id: number;
  subject: string;
  description: string;
  status: string;
  requester_id?: number;
}

export interface ZendeskComment {
  body: string;
  html_body?: string;
  public?: boolean;
}

export interface ZendeskTicketResult {
  ticket: ZendeskTicket;
}

export async function fetchZendeskTicket(
  connection: ZendeskConnectionLike,
  ticketId: string
): Promise<ZendeskTicketResult> {
  return zendeskFetch(connection, `/tickets/${ticketId}.json`);
}

export interface ZendeskCommentResult {
  comment: ZendeskComment;
  ticketId: string;
}

export async function postZendeskComment(
  connection: ZendeskConnectionLike,
  ticketId: string,
  comment: ZendeskComment
): Promise<ZendeskCommentResult> {
  await zendeskFetch(connection, `/tickets/${ticketId}.json`, {
    body: JSON.stringify({ ticket: { comment } }),
    method: 'PUT',
  });
  return { comment, ticketId };
}
