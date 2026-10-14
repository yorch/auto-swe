import type { ConfluenceConnectionConfig } from '@auto-swe/shared';
import { createGuardedFetch } from '@auto-swe/shared/lib/guardedDispatcher';
import { adfToPlainText } from '@auto-swe/shared/lib/integrations/adf';
import { resolveKnowledgeBaseOrigin } from '@auto-swe/shared/lib/systemConfig';
import { ApplicationFailure } from '@temporalio/activity';
import { assertSafeConnectionBaseUrl } from './baseUrlGuard.js';

const CONFLUENCE_TIMEOUT_MS = 30_000;

export interface ConfluenceConnectionLike {
  apiToken: string;
  config: ConfluenceConnectionConfig;
}

export interface ConfluencePageContent {
  bodyText: string;
  id: string;
  title: string;
  url: string;
  version: number;
}

export interface ConfluencePageResult {
  id: string;
  url: string;
  version: number;
}

interface ConfluencePageResponse {
  _links?: { webui?: string };
  body?: {
    atlas_doc_format?: { value?: string };
    storage?: { value?: string };
  };
  id: string;
  spaceId?: string;
  title: string;
  version?: { number?: number };
}

function requireBaseUrl(config: ConfluenceConnectionConfig): string {
  if (!config.baseUrl) {
    throw ApplicationFailure.nonRetryable('confluence connection is missing baseUrl');
  }
  return config.baseUrl.replace(/\/+$/, '');
}

function requireEmail(config: ConfluenceConnectionConfig): string {
  if (!config.email) {
    throw ApplicationFailure.nonRetryable('confluence connection is missing email');
  }
  return config.email;
}

/**
 * The SSRF check for a Confluence connection's `baseUrl`, with the admin
 * knowledge-base integration supplying the private-address opt-in. See
 * {@link assertSafeConnectionBaseUrl} for the rule and why the opt-in may not
 * come from the connection row.
 */
export async function assertSafeConfluenceBaseUrl(
  baseUrl: string
): Promise<{ allowPrivate: boolean }> {
  // The origin-only resolver: decrypting nothing, and still propagated rather than
  // caught, so a database blip is a retryable failure and not a permanent refusal.
  const admin = await resolveKnowledgeBaseOrigin();
  return assertSafeConnectionBaseUrl(baseUrl, admin, 'confluence');
}

async function confluenceFetch<T>(
  connection: ConfluenceConnectionLike,
  path: string,
  init: RequestInit = {},
  /** What is being fetched, for the 404 message — a missing space is not a missing page. */
  notFound: 'page' | 'space' = 'page'
): Promise<T> {
  const baseUrl = requireBaseUrl(connection.config);
  const email = requireEmail(connection.config);
  const { allowPrivate } = await assertSafeConfluenceBaseUrl(baseUrl);
  const url = `${baseUrl}${path}`;
  const timeoutSignal = AbortSignal.timeout(CONFLUENCE_TIMEOUT_MS);
  // The text check above vets the URL; this one vets what it resolves to and pins
  // the connection.
  //
  // A failure here is deliberately not classified. `SsrfBlockedError` covers an
  // address the guard refuses *and* a host it could not resolve or that answered
  // with no usable address, so the class alone cannot separate a permanent policy
  // refusal from a resolver outage — and turning an outage into a permanent
  // failure loses the run. The kinds that are never allowed (loopback, link-local,
  // cloud metadata) are refused by the text check above, before any request.
  // `redirect: 'error'` rejects a redirect the same way, so a redirecting endpoint
  // costs this activity's retries and then fails; the request is never followed,
  // which is what matters for the credential.
  const response = await createGuardedFetch({ allowPrivate })(url, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${connection.apiToken}`).toString('base64')}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    redirect: 'error',
    signal: init.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal,
  });

  if (!response.ok) {
    // No response body in the message: it is written by the far end, it becomes
    // durable failure evidence on the run, and an error page can echo back the
    // Authorization header it was sent.
    if (response.status === 401 || response.status === 403) {
      throw ApplicationFailure.nonRetryable(
        `Confluence API authentication failed (${response.status})`
      );
    }
    if (response.status === 404) {
      throw ApplicationFailure.nonRetryable(
        `Confluence ${notFound} not found (${response.status})`
      );
    }
    if (response.status === 409) {
      // Confluence answers 409 both for a stale `version.number` and for a space
      // that requires approval before content is published, and the response
      // distinguishes them only in its body, which is not safe to quote. Say both
      // and stay non-retryable: re-sending the same request cannot help either way.
      throw ApplicationFailure.nonRetryable(
        'Confluence refused the write (409): the page version is stale or the space requires ' +
          'content approval'
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw ApplicationFailure.create({
        message: `Confluence API transient error (${response.status})`,
        type: 'ConfluenceTransientError',
      });
    }
    throw ApplicationFailure.nonRetryable(`Confluence API error (${response.status})`);
  }

  try {
    return (await response.json()) as T;
  } catch {
    // A 2xx whose body is not JSON. For a read that is a contract failure; for a
    // write it is an ambiguous outcome the caller must not treat as success, so
    // it never reaches the code that would record one.
    throw ApplicationFailure.nonRetryable('Confluence API returned a non-JSON response');
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Decode the entities Confluence storage format encodes.
 *
 * A bounded, one-pass decoder: the named entities storage actually uses, plus
 * numeric references. `&amp;` is decoded last, because decoding it first would
 * turn the text `&amp;lt;` into `<` rather than the literal `&lt;` the page holds.
 * This is not a full HTML entity table — the ADF body is the primary
 * representation and this is the fallback.
 */
/**
 * Named entity references storage format uses.
 *
 * A `Map`, not an object literal: a lookup on an ordinary object finds inherited
 * properties, so a page containing `&constructor;` would decode to JavaScript's
 * `Object` constructor source rather than keeping the unknown reference as written.
 */
const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['apos', "'"],
  ['gt', '>'],
  ['lt', '<'],
  ['nbsp', ' '],
  ['quot', '"'],
]);

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const n = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return NAMED_ENTITIES.get(body.toLowerCase()) ?? match;
  });
}

/**
 * Plain text as Confluence storage format: one paragraph per non-empty line.
 *
 * Deliberately not a Markdown renderer. The storage format is HTML-shaped, and
 * interpolating agent-authored text into it unescaped would let a draft inject
 * markup into someone else's page, so every line is escaped and wrapped rather
 * than interpreted.
 */
function storageFromText(text: string): string {
  const paragraphs = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<p>${escapeHtml(line)}</p>`);
  return paragraphs.length > 0 ? paragraphs.join('') : '<p></p>';
}

/**
 * A page's web URL from the response link, or a generated one.
 *
 * `_links.webui` is a context path, not an absolute URL, so it is only usable when
 * it is rooted: a bare `spaces/…` would otherwise be pasted onto the origin as a
 * sibling of `/wiki`. An absolute link is used only when it is the same origin,
 * so a response cannot point a run's page reference at another host.
 */
function pageUrl(baseUrl: string, page: ConfluencePageResponse, fallbackPath: string): string {
  const webui = page._links?.webui;
  if (typeof webui === 'string' && webui.startsWith('/')) {
    return `${baseUrl}${webui}`;
  }
  if (typeof webui === 'string' && /^https?:\/\//i.test(webui)) {
    try {
      if (new URL(webui).origin === new URL(baseUrl).origin) {
        return webui;
      }
    } catch {
      // Fall through to the generated path.
    }
  }
  return `${baseUrl}${fallbackPath}`;
}

/**
 * A parsed ADF document, or null when the value is not one.
 *
 * `'null'` and `'{}'` parse without throwing but are not documents; treating them
 * as documents would convert to an empty string and report a blank page.
 */
function parseAdfDocument(value: string): unknown | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const doc = parsed as { content?: unknown; type?: unknown };
    if (doc.type !== 'doc') {
      return null;
    }
    // An ADF document root carries an array of content nodes. A string there is a
    // malformed body, and converting it would report a blank page over whatever
    // text the document actually holds.
    if (doc.content !== undefined && !Array.isArray(doc.content)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** The ADF body as text, or null when the value is absent or unusable. */
function adfTextOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (value.trim().length === 0) {
    // A page with no body at all: empty content, not unreadable content.
    return '';
  }
  const document = parseAdfDocument(value);
  return document ? adfToPlainText(document).trim() : null;
}

/** The storage body as text, or null when the value is absent. */
function storageTextOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  // The ADF wording of the same text is not available here, but the storage format
  // encodes entities: `A &amp; B` is the page text `A & B`.
  return decodeEntities(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The id of the page a response is about, or a failure.
 *
 * The value is checked to be an object first: a JSON `null` would otherwise throw
 * a plain `TypeError`, which reads as a transient failure and lets the activity
 * retry a write that may already have committed. `expected`, when given, must
 * match: a response naming a different page is not evidence that *this* page was
 * read or written, and a proxy answering with another page's title and version
 * would otherwise be used to build a write to this one.
 */
function requirePageId(page: unknown, what: string, expected?: string): string {
  if (typeof page !== 'object' || page === null || Array.isArray(page)) {
    throw ApplicationFailure.nonRetryable(`Confluence ${what} returned no page object`);
  }
  const id = (page as { id?: unknown }).id;
  if (typeof id !== 'string' || id.length === 0) {
    throw ApplicationFailure.nonRetryable(`Confluence ${what} did not return the page it acted on`);
  }
  if (expected && id !== expected) {
    // The returned value is not quoted: a hostile or debugging endpoint can put
    // anything there, and this message becomes durable failure evidence on the run.
    throw ApplicationFailure.nonRetryable(
      `Confluence ${what} returned a different page than the one it was given`
    );
  }
  return id;
}

/**
 * Read a Confluence page and its body as plain text.
 *
 * When the ADF body cannot be read, the storage representation is **requested** in
 * a second call rather than hoped for in the first: Confluence returns the
 * representation that was asked for, so a response to an `atlas_doc_format`
 * request is not evidence about the page's storage body either way.
 */
export async function readConfluencePage(
  connection: ConfluenceConnectionLike,
  pageId: string
): Promise<ConfluencePageContent> {
  const path = `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`;
  const page = await confluenceFetch<ConfluencePageResponse>(
    connection,
    `${path}?body-format=atlas_doc_format`
  );
  const id = requirePageId(page, 'fetchPage', pageId);
  let bodyText = adfTextOrNull(page.body?.atlas_doc_format?.value);
  let meta = page;
  if (bodyText === null) {
    const withStorage = await confluenceFetch<ConfluencePageResponse>(
      connection,
      `${path}?body-format=storage`,
      {},
      'page'
    );
    requirePageId(withStorage, 'fetchPage', pageId);
    bodyText = storageTextOrNull(withStorage.body?.storage?.value);
    // The body now comes from the second response, and so must its metadata: taking
    // the title and version from the first would pair one revision's text with
    // another's version.
    meta = withStorage;
  }
  if (bodyText === null) {
    // Neither representation could be read: reporting '' would tell a drafting
    // agent the page is blank and let it write over content that is there.
    throw ApplicationFailure.nonRetryable('Confluence returned no readable page body');
  }
  if (typeof meta.title !== 'string' || meta.title.length === 0) {
    throw ApplicationFailure.nonRetryable('Confluence fetchPage returned a page with no title');
  }
  return {
    bodyText,
    id,
    title: meta.title,
    url: pageUrl(requireBaseUrl(connection.config), meta, `/wiki/pages/${id}`),
    version: meta.version?.number ?? 1,
  };
}

/**
 * A space key as the `spaceId` the v2 API takes.
 *
 * The connector (and the admin form) speak in space *keys*; v2 addresses spaces by
 * id. A value that is already an id is used as it is, so a deployment can configure
 * either.
 */
async function resolveSpaceId(connection: ConfluenceConnectionLike, ref: string): Promise<string> {
  if (/^\d+$/.test(ref)) {
    return ref;
  }
  const found = await confluenceFetch<{ results?: { id?: unknown; key?: unknown }[] }>(
    connection,
    `/wiki/api/v2/spaces?keys=${encodeURIComponent(ref)}`,
    {},
    'space'
  );
  // An exact key match only. Falling back to the first result — or accepting one of
  // several — would publish the page into whichever space the endpoint answered
  // with, which is not the space the operator configured.
  const matches = (found.results ?? []).filter((space) => space.key === ref);
  const id = matches.length === 1 ? matches[0]?.id : undefined;
  if (typeof id !== 'string' || id.length === 0) {
    throw ApplicationFailure.nonRetryable(
      matches.length === 0
        ? `Confluence space '${ref}' was not found`
        : `Confluence space key '${ref}' matched ${matches.length} spaces`
    );
  }
  return id;
}

/**
 * Create a Confluence page.
 *
 * v2 throughout, like the read and update paths: the v1 `POST /wiki/rest/api/content`
 * operation is one of the ones Atlassian has been retiring, so it is not a
 * foundation to build a new connector on. v2 takes a `spaceId`, which is why the
 * configured space key is resolved through the space API first.
 */
export async function createConfluencePage(
  connection: ConfluenceConnectionLike,
  input: { bodyText: string; parentPageId?: string; spaceKey?: string; title: string }
): Promise<ConfluencePageResult> {
  const spaceRef = input.spaceKey ?? connection.config.spaceKey;
  if (!spaceRef) {
    throw ApplicationFailure.nonRetryable(
      'confluence createPage requires a spaceKey or a default spaceKey on the connection'
    );
  }
  const spaceId = await resolveSpaceId(connection, spaceRef);
  const parentPageId = input.parentPageId ?? connection.config.parentPageId;
  const created = await confluenceFetch<ConfluencePageResponse>(connection, '/wiki/api/v2/pages', {
    body: JSON.stringify({
      body: { representation: 'storage', value: storageFromText(input.bodyText) },
      ...(parentPageId ? { parentId: parentPageId } : {}),
      spaceId,
      status: 'current',
      title: input.title,
    }),
    method: 'POST',
  });
  const id = requirePageId(created, 'createPage');
  return {
    id,
    url: pageUrl(
      requireBaseUrl(connection.config),
      created,
      `/wiki/spaces/${encodeURIComponent(spaceRef)}/pages/${id}`
    ),
    version: created.version?.number ?? 1,
  };
}

/**
 * Replace an existing Confluence page's body.
 *
 * A full-body replacement, not an append: a draft that is regenerated must not
 * stack under the previous run's text. Confluence requires the next version
 * number with each write, so the current one is read first unless the caller
 * already knows it.
 *
 * A caller-supplied `version` is honoured rather than refreshed, which is what
 * makes a retry safe: the second attempt sends the same precondition, so a write
 * that landed before the response was lost is refused as stale instead of
 * silently replacing whatever else changed the page in the meantime.
 */
export async function updateConfluencePage(
  connection: ConfluenceConnectionLike,
  pageId: string,
  input: { bodyText: string; title?: string; version?: number }
): Promise<ConfluencePageResult> {
  const current = await confluenceFetch<ConfluencePageResponse>(
    connection,
    `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`
  );
  // The identity matters here more than anywhere: this response's title and version
  // are what the PUT below is built from, so another page's metadata would be
  // written onto this one.
  requirePageId(current, 'updatePage', pageId);
  const version = input.version ?? current.version?.number ?? 1;
  const updated = await confluenceFetch<ConfluencePageResponse>(
    connection,
    `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`,
    {
      body: JSON.stringify({
        body: { representation: 'storage', value: storageFromText(input.bodyText) },
        id: pageId,
        status: 'current',
        title: input.title ?? current.title,
        version: { message: 'Updated by auto-swe', number: version + 1 },
      }),
      method: 'PUT',
    }
  );
  // The page id is the evidence the write landed. Never fall back to the id we
  // asked for: a proxy answering `200 {}` would then read as a successful write,
  // and a response naming another page would read as a write to this one.
  const id = requirePageId(updated, 'updatePage', pageId);
  return {
    id,
    url: pageUrl(requireBaseUrl(connection.config), updated, `/wiki/pages/${id}`),
    version: updated.version?.number ?? version + 1,
  };
}
