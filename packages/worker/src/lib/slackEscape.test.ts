import { describe, expect, it } from 'vitest';
import { escapeSlackText, neutralizeSlackBroadcasts } from './slackEscape.js';

describe('escapeSlackText', () => {
  it('escapes the three characters Slack reads as markup', () => {
    expect(escapeSlackText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('defuses broadcasts, mentions and labelled links', () => {
    const escaped = escapeSlackText('<!channel> <!here> <@U123> <https://evil.example|click>');
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(escaped).toBe(
      '&lt;!channel&gt; &lt;!here&gt; &lt;@U123&gt; &lt;https://evil.example|click&gt;'
    );
  });

  it('escapes an ampersand first so an existing entity is not double-decoded', () => {
    expect(escapeSlackText('&lt;')).toBe('&amp;lt;');
  });

  it('leaves emphasis and code markers alone', () => {
    expect(escapeSlackText('*bold* _it_ `code` plain')).toBe('*bold* _it_ `code` plain');
  });

  it('passes the empty string through', () => {
    expect(escapeSlackText('')).toBe('');
  });
});

describe('neutralizeSlackBroadcasts', () => {
  it.each([
    ['<!channel>', '&lt;!channel&gt;'],
    ['<!here>', '&lt;!here&gt;'],
    ['<!everyone>', '&lt;!everyone&gt;'],
    ['<!channel|channel>', '&lt;!channel|channel&gt;'],
    ['<!here|here>', '&lt;!here|here&gt;'],
    ['<!subteam^S0123ABC>', '&lt;!subteam^S0123ABC&gt;'],
    ['<!subteam^S0123ABC|@oncall>', '&lt;!subteam^S0123ABC|@oncall&gt;'],
    ['<!CHANNEL>', '&lt;!CHANNEL&gt;'],
    ['<!Here>', '&lt;!Here&gt;'],
  ])('defuses %s', (input, expected) => {
    expect(neutralizeSlackBroadcasts(input)).toBe(expected);
  });

  it('defuses every occurrence in a longer reply and keeps the rest', () => {
    expect(
      neutralizeSlackBroadcasts('Heads up <!channel>: see <!here> and *this* <!channel|all>.')
    ).toBe('Heads up &lt;!channel&gt;: see &lt;!here&gt; and *this* &lt;!channel|all&gt;.');
  });

  it('leaves links, single-person mentions, channels, dates and formatting as written', () => {
    const reply = [
      'Thanks <@U123>, see <https://example.com/a?b=1&c=2|the doc> in <#C456>.',
      '*bold* _italic_ `code` > quote',
      '<!date^1700000000^{date_short}|Nov 14>',
    ].join('\n');
    expect(neutralizeSlackBroadcasts(reply)).toBe(reply);
  });

  it('does not touch the look-alikes that are not broadcasts', () => {
    for (const text of ['<!channelx>', '<!heres>', '<! channel>', '!channel', '<channel>']) {
      expect(neutralizeSlackBroadcasts(text)).toBe(text);
    }
  });

  it('is idempotent and leaves text that was already escaped alone', () => {
    const once = neutralizeSlackBroadcasts('a <!channel> b');
    expect(neutralizeSlackBroadcasts(once)).toBe(once);
    const escaped = escapeSlackText('<!channel>');
    expect(neutralizeSlackBroadcasts(escaped)).toBe(escaped);
  });

  it('defuses a mention hidden inside a nested bracket', () => {
    expect(neutralizeSlackBroadcasts('<<!channel>>')).toBe('<&lt;!channel&gt;>');
  });
});
