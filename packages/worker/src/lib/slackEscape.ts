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
