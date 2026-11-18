/**
 * Escaping for text that fixed code interpolates into a Slack `mrkdwn` message.
 *
 * Slack reads `<…>` as markup: `<!channel>` and `<!here>` broadcast, `<@U…>` mentions a person and
 * `<https://x|label>` is a link with arbitrary label text. A ticket id, a template or node name, a
 * step title, an error message or a draft's name is chosen by someone other than the platform, so
 * it is escaped before it goes into a message. Escaping `&`, `<` and `>` is all Slack asks for; it
 * leaves `*bold*`, `_italic_` and backticks working.
 *
 * Dependency-free on purpose: a Temporal workflow file imports this, and a workflow runs in a V8
 * isolate where only `@temporalio/workflow` may be imported at run time.
 */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * `<!channel>`, `<!here>`, `<!everyone>` and `<!subteam^ID>` (a user-group mention), with or without
 * the `|label` Slack allows after the keyword. These are the forms that notify many people at once.
 *
 * Written as a single forward scan rather than one regex. The equivalent pattern,
 * `/<!(?:channel|here|everyone|subteam\^[^>|\s]*)(?:\|[^>]*)?>/gi`, rescans to the end of the text
 * from every unterminated opener, so `'<!channel|'.repeat(n)` costs O(n^2). Here the position of the
 * next `>` and of the next `>`, `|` or whitespace character are each cached and only ever searched
 * forward, so every character of the input is examined a constant number of times.
 *
 * Every broadcast opener is resolved independently: the scan does not skip past a match. The regex
 * consumed `<!here|<!here|x>>` as one token whose label swallowed the inner opener, leaving a raw
 * `<!here|x&gt;>` that still pings. Here each opener's `<` and its closing `>` are both escaped, and
 * openers that resolve to the same `>` escape it once, so no defusable opener survives and the
 * result is a fixed point.
 */
const KEYWORDS = ['channel', 'here', 'everyone'] as const;
const SUBTEAM = 'subteam^';
const WHITESPACE = /\s/;

/** True when `text` holds `word` (lower case, ASCII) at `at`, ignoring ASCII case only. */
function hasWordAt(text: string, at: number, word: string): boolean {
  if (at + word.length > text.length) {
    return false;
  }
  for (let k = 0; k < word.length; k++) {
    let c = text.charCodeAt(at + k);
    if (c >= 65 && c <= 90) {
      c += 32;
    }
    if (c !== word.charCodeAt(k)) {
      return false;
    }
  }
  return true;
}

/**
 * Defuse broadcast mentions in text a MODEL wrote, without touching anything else.
 *
 * A model's reply is meant to carry Slack formatting (links, `*bold*`, a mention of the person it
 * is answering), so it cannot be escaped wholesale the way a ticket id is. But a prompt-injected
 * channel message can make it write `<!channel>`, which would notify everyone in the channel. Each
 * such mention is turned into the literal text (`&lt;!channel&gt;` shows as `<!channel>`); links,
 * single-person mentions and formatting are left exactly as written.
 */
export function neutralizeSlackBroadcasts(text: string): string {
  let at = text.indexOf('<!');
  if (at === -1) {
    return text;
  }

  const n = text.length;
  // Cached forward-only lookups. -1 means "none at or after the last search position", which stays
  // true for every later position, so it is never searched again.
  let gt = -2; // index of the next '>' at or after the last position asked about
  let stop = -2; // index of the next '>', '|' or whitespace character, likewise
  const nextGt = (from: number): number => {
    if (gt === -2 || (gt !== -1 && gt < from)) {
      gt = text.indexOf('>', from);
    }
    return gt;
  };
  const nextStop = (from: number): number => {
    if (stop === -2 || (stop !== -1 && stop < from)) {
      let k = from;
      while (k < n) {
        const c = text[k] as string;
        if (c === '>' || c === '|' || WHITESPACE.test(c)) {
          break;
        }
        k++;
      }
      stop = k < n ? k : -1;
    }
    return stop;
  };

  const opens: number[] = [];
  const closes: number[] = [];
  while (at !== -1) {
    let end = -1; // index just past the closing '>' when this opener is a broadcast mention
    let p = -1; // index just past the keyword (and subteam id)
    const body = at + 2;
    for (const word of KEYWORDS) {
      if (hasWordAt(text, body, word)) {
        p = body + word.length;
        break;
      }
    }
    if (p === -1 && hasWordAt(text, body, SUBTEAM)) {
      const s = nextStop(body + SUBTEAM.length);
      p = s === -1 ? n : s;
    }
    if (p !== -1 && p < n) {
      const c = text[p];
      if (c === '>') {
        end = p + 1;
      } else if (c === '|') {
        const g = nextGt(p + 1);
        if (g !== -1) {
          end = g + 1;
        }
      }
    }
    if (end !== -1) {
      opens.push(at);
      // Closers are non-decreasing across openers (each is the first `>` at or after a growing
      // position), so a repeat of the last one is the same `>` shared by nested openers.
      if (closes[closes.length - 1] !== end - 1) {
        closes.push(end - 1);
      }
    }
    at = text.indexOf('<!', at + 1);
  }
  if (opens.length === 0) {
    return text;
  }
  // Merge the two sorted position lists into one pass over the text.
  let out = '';
  let copied = 0;
  let i = 0;
  let j = 0;
  while (i < opens.length || j < closes.length) {
    const useOpen =
      j >= closes.length || (i < opens.length && (opens[i] as number) < (closes[j] as number));
    const pos = (useOpen ? opens[i++] : closes[j++]) as number;
    out += text.slice(copied, pos) + (useOpen ? '&lt;' : '&gt;');
    copied = pos + 1;
  }
  return out + text.slice(copied);
}
