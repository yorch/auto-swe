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
 */
const BROADCAST_MENTION = /<!(?:channel|here|everyone|subteam\^[^>|\s]*)(?:\|[^>]*)?>/gi;

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
  return text.replace(BROADCAST_MENTION, (mention) =>
    mention.replace('<', '&lt;').replace(/>$/, '&gt;')
  );
}
