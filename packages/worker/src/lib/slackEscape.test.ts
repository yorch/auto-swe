import { describe, expect, it } from 'vitest';
import { escapeSlackText } from './slackEscape.js';

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
