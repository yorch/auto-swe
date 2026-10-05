export type LoginTab = 'magic' | 'password';

/**
 * Which sign-in tab shows. Magic link is offered only when the gateway reports it
 * enabled; a pending MCP sign-in cannot continue through a link, so it defaults
 * to password. A person's own pick wins when it is available.
 */
export function resolveLoginTab(
  picked: LoginTab | null,
  magicAvailable: boolean,
  oauthPending: boolean
): LoginTab {
  if (!magicAvailable) {
    return 'password';
  }
  return (picked ?? (oauthPending ? 'password' : 'magic')) === 'magic' ? 'magic' : 'password';
}
