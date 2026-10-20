/**
 * How a GitHub account's numeric id is recorded on a platform user: a bare id on github.com
 * (where every linked account predates hosts), `<host>:<id>` anywhere else. The same list
 * serves a lookup (`IN`) and a comparison (`includes`), so an account linked on the instance
 * host is recognised however it was stored.
 */
export function linkedGithubAccountIds(host: string, accountId: string): string[] {
  return host === 'github.com' ? [accountId, `github.com:${accountId}`] : [`${host}:${accountId}`];
}
