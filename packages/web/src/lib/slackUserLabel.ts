/**
 * The person behind a Slack user ID: their platform email when an account is linked to that Slack
 * user, otherwise the Slack ID itself, labelled so it reads as "someone in Slack" and not as data.
 */
export function slackUserLabel(
  emailBySlackId: ReadonlyMap<string, string>,
  slackId: string | null | undefined
): string {
  if (!slackId) {
    return 'System';
  }
  return emailBySlackId.get(slackId) ?? `Slack user ${slackId}`;
}

export function emailsBySlackId(
  users: readonly { email: string; slackId: string | null }[] | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  for (const u of users ?? []) {
    if (u.slackId) {
      map.set(u.slackId, u.email);
    }
  }
  return map;
}
