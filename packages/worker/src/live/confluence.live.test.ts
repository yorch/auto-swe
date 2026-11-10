import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createConfluenceFooterComment,
  createConfluenceInlineComment,
  createConfluencePage,
  readConfluencePage,
  updateConfluencePage,
} from '../connectors/confluence.js';
import { liveEnv, liveGate, liveTitle } from './liveGate.js';

/**
 * The Confluence connector against a real Atlassian Cloud site: create a page in a scratch space,
 * read it back, replace its body, and attach a footer comment and an inline comment. The page is
 * deleted afterwards (moved to the space trash by Confluence).
 *
 * The admin knowledge-base integration normally supplies the private-network opt-in through the
 * database; the site here is public, so that lookup is answered with "no opt-in" and the suite
 * needs no database. Opt in with `LIVE_CONFLUENCE=1`. Use a throwaway space: the token's user
 * needs permission to create and delete pages in it.
 */
const REQUIRED = [
  'LIVE_CONFLUENCE_BASE_URL',
  'LIVE_CONFLUENCE_EMAIL',
  'LIVE_CONFLUENCE_API_TOKEN',
  'LIVE_CONFLUENCE_SPACE_KEY',
] as const;
const gate = liveGate(
  'confluence',
  'LIVE_CONFLUENCE',
  process.env.LIVE_CONFLUENCE === '1',
  REQUIRED
);

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveKnowledgeBaseOrigin: async () => ({ allowPrivateNetwork: false, baseUrl: null }),
}));

const connection = () => ({
  apiToken: liveEnv('LIVE_CONFLUENCE_API_TOKEN'),
  config: {
    baseUrl: liveEnv('LIVE_CONFLUENCE_BASE_URL'),
    email: liveEnv('LIVE_CONFLUENCE_EMAIL'),
    spaceKey: liveEnv('LIVE_CONFLUENCE_SPACE_KEY'),
  },
});

describe.skipIf(!gate.enabled)(liveTitle('live Confluence connector', gate), () => {
  const title = `auto-swe live check ${Date.now().toString(36)}`;
  let pageId: string | undefined;

  afterAll(async () => {
    if (!pageId) {
      return;
    }
    const { apiToken, config } = connection();
    await fetch(`${config.baseUrl.replace(/\/+$/, '')}/wiki/api/v2/pages/${pageId}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.email}:${apiToken}`).toString('base64')}`,
      },
      method: 'DELETE',
      redirect: 'error',
    }).catch(() => undefined);
  });

  it('creates, reads and updates a page', async () => {
    const created = await createConfluencePage(connection(), {
      bodyText: 'First line.\n\nThe quick brown fox.',
      title,
    });
    pageId = created.id;
    expect(created.id).toBeTruthy();

    const read = await readConfluencePage(connection(), created.id);
    expect(read.title).toBe(title);
    expect(read.bodyText).toContain('quick brown fox');

    const updated = await updateConfluencePage(connection(), created.id, {
      bodyText: 'Replaced body.\n\nThe quick brown fox.',
    });
    expect(updated.version).toBeGreaterThan(created.version);
    expect((await readConfluencePage(connection(), created.id)).bodyText).toContain(
      'Replaced body.'
    );
  }, 120_000);

  it('adds a footer comment and an inline comment anchored to a passage', async () => {
    expect(pageId, 'the previous test creates the page').toBeDefined();
    const id = pageId as string;
    const footer = await createConfluenceFooterComment(connection(), {
      bodyText: 'Footer comment from the live check.',
      pageId: id,
    });
    expect(footer.id).toBeTruthy();
    const inline = await createConfluenceInlineComment(connection(), {
      bodyText: 'Inline comment from the live check.',
      matchCount: 1,
      matchIndex: 0,
      pageId: id,
      textSelection: 'quick brown fox',
    });
    expect(inline.id).toBeTruthy();
  }, 120_000);
});
