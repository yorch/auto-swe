import { approvedRepositoryHosts } from '@auto-swe/shared/lib/connectionCredential';
import { resolveWebUrl } from '@auto-swe/shared/lib/systemConfig';

/**
 * Hosts a card button may link to: the dashboard and the approved repository hosts. A failure
 * resolving the repository hosts degrades to the dashboard alone, never to "any host".
 */
export async function resolveCardLinkHosts(): Promise<string[]> {
  const hosts: string[] = [];
  try {
    hosts.push(new URL(resolveWebUrl()).host.toLowerCase());
  } catch {
    // An unparseable WEB_URL contributes nothing; links then have no allowed host.
  }
  try {
    hosts.push(...(await approvedRepositoryHosts()).map((h) => h.toLowerCase()));
  } catch {
    // Settings unreadable: keep the dashboard host only.
  }
  return [...new Set(hosts)];
}
