/**
 * Where a `Connection` row's stored credential would be sent.
 *
 * The row's `api_key_*` columns hold a secret that is sent to whatever the row's
 * `config` says the destination is. `config` is editable by a team LEAD while the
 * secret is not readable by them — so with no binding between the two, a LEAD can
 * repoint their own connection at a host they control and receive the credential
 * on the next run.
 *
 * `ConnectionCredential` solves the same problem for a user's own GitHub token by
 * recording the origin the token was saved for; this is the equivalent for the
 * credential in the connection row. It is computed from the row rather than stored
 * beside it, which is sound only because the create and update routes are the only
 * writers of a non-`mcp` connection's `config`, and the update route refuses a
 * destination change that would keep the stored secret. A new writer of `config`
 * has to make the same check — a binding that is never re-checked is not a binding.
 */

import { originOf } from './connectionCredential.js';
import type { ConnectionType } from './connectionTypes.js';

/**
 * An origin (`https://host[:port]`), or null when the row names no destination.
 *
 * A null is a value, not "unknown": a comparison that treats it as "unchanged"
 * lets a caller clear the destination and set another in a second request.
 */
export type CredentialDestination = string | null;

/** Origins the platform reaches on a host nothing in the row can move. */
const NOTION_ORIGIN = 'https://api.notion.com';
const SLACK_ORIGIN = 'https://slack.com';
const LINEAR_ORIGIN = 'https://api.linear.app';

function stringField(config: unknown, key: string): string | null {
  if (typeof config !== 'object' || config === null) {
    return null;
  }
  const value = (config as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * One entry per connection type.
 *
 * `Record<ConnectionType, …>` on purpose: adding a type to `CONNECTION_TYPES` does
 * not compile until its author says where that type's credential goes. `null` is an
 * answer — "no request sends this row's secret" — and writing one down is the point;
 * an absent entry would be the same thing by accident.
 */
const DESTINATIONS: Record<ConnectionType, (config: unknown) => CredentialDestination> = {
  confluence: (config) => originOf(stringField(config, 'baseUrl') ?? ''),
  // A repository's credential is not in this row: the platform credential and a
  // user's own live in `GitHubConfig` / `ConnectionCredential`, both bound to their
  // host by `resolvePlatformCredential` and `resolveUserCredential`. The `apiKey*`
  // columns on a `git_repo` row are inert — nothing reads them — so there is no
  // destination to bind.
  git_repo: () => null,
  // Both are placeholder handlers that never send their token
  // (`genericActions.ts` returns `ok: true` without a request). Whoever gives one a
  // real sender must give it a destination here.
  http_api: () => null,
  hubspot: () => null,
  issue_tracker: (config) => {
    const provider = stringField(config, 'provider');
    // Linear's endpoint is fixed, so switching to it *moves* the destination even
    // though `baseUrl` does not change — which is why the provider is part of this
    // answer and not only the URL.
    if (provider === 'linear') {
      return LINEAR_ORIGIN;
    }
    // Jira is self-hosted as often as not: the destination is the row's own base URL.
    return provider === 'jira' ? originOf(stringField(config, 'baseUrl') ?? '') : null;
  },
  // Guarded by its own route (`TOKEN_ORIGIN_CHANGE`); reported here so the mapping
  // stays complete for the day one of them changes.
  mcp: (config) => originOf(stringField(config, 'url') ?? ''),
  notion: () => NOTION_ORIGIN,
  slack_workspace: () => SLACK_ORIGIN,
  zendesk: (config) => {
    const subdomain = stringField(config, 'subdomain');
    return subdomain ? originOf(`https://${subdomain}.zendesk.com`) : null;
  },
};

/** Where this row's credential would be sent, as an origin. */
export function credentialDestination(
  type: ConnectionType,
  config: unknown
): CredentialDestination {
  return DESTINATIONS[type](config);
}

/**
 * Whether an edit would move a stored credential to a different destination.
 *
 * A missing destination compares as itself, so clearing the field and setting
 * another afterwards is a change on both steps and is refused on the first.
 */
export function credentialDestinationChanged(
  previous: { config: unknown; type: ConnectionType },
  next: { config: unknown; type: ConnectionType }
): boolean {
  return (
    credentialDestination(previous.type, previous.config) !==
    credentialDestination(next.type, next.config)
  );
}
