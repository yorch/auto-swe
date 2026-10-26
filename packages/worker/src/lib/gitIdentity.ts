import { resolveSettings } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { hasGitNameCharacter } from '@auto-swe/shared/lib/gitIdentityName';
import { currentRunLaunchContext } from './runLauncher.js';
import { shellQuote } from './shellQuote.js';

export interface GitIdentity {
  /** The configured bot identity. */
  committer: { name: string; email: string };
  /** Equals `committer` unless launcher attribution is `author`. */
  author: { name: string; email: string };
  /** Only in `co-author-trailer` mode, with a verified launcher. */
  coAuthorTrailer?: string;
}

export const DEFAULT_GIT_IDENTITY: GitIdentity = {
  author: { email: 'auto-swe@localhost', name: 'auto-swe' },
  committer: { email: 'auto-swe@localhost', name: 'auto-swe' },
};

/// The class the `git.authorName` schema refuses: a launcher's own name must
/// not be able to end a trailer line or close the `<email>` part.
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}<>]/gu;
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}<>]/u;
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+$/;
const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;

async function resolveLauncher(
  launchedById: string | null
): Promise<{ name: string; email: string } | null> {
  if (!launchedById) {
    return null;
  }
  const user = await prisma.user.findUnique({
    select: { email: true, emailVerified: true, name: true },
    where: { id: launchedById },
  });
  if (!user?.emailVerified) {
    return null;
  }
  // The verified address is used exactly as stored or not at all: rewriting it
  // would credit commits to an address nobody verified.
  const { email } = user;
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(email) || UNSAFE_CHARS.test(email)) {
    return null;
  }
  const name = Array.from((user.name ?? '').replace(UNSAFE_NAME_CHARS, '').trim())
    .slice(0, MAX_NAME_LENGTH)
    .join('')
    .trim();
  return { email, name: hasGitNameCharacter(name) ? name : email };
}

/**
 * The identity every commit in a workspace carries. Settings resolve through
 * the full cascade (template, team, organization, global); outside a workflow
 * run there is no template and no launcher, so no attribution. A database
 * failure throws and the activity retries: the platform never commits under a
 * fallback identity.
 */
export async function resolveGitIdentity(scope: { teamId: string | null }): Promise<GitIdentity> {
  const { teamId } = scope;
  const [team, launch] = await Promise.all([
    teamId === null
      ? null
      : prisma.team.findUnique({ select: { orgId: true }, where: { id: teamId } }),
    currentRunLaunchContext(),
  ]);
  if (teamId !== null && !team) {
    throw new Error(`Cannot resolve a git identity: team ${teamId} does not exist`);
  }
  const configured = await resolveSettings(
    ['git.authorName', 'git.authorEmail', 'git.launcherAttribution'],
    {
      orgId: team?.orgId ?? undefined,
      teamId: teamId ?? undefined,
      workflowTemplateId: launch?.workflowTemplateId,
    }
  );
  const committer = { email: configured['git.authorEmail'], name: configured['git.authorName'] };
  const mode = configured['git.launcherAttribution'];
  const identity: GitIdentity = { author: { ...committer }, committer };
  if (mode === 'none') {
    return identity;
  }
  const launchedById = launch?.launchedById ?? null;
  const launcher = await resolveLauncher(launchedById);
  if (!launcher || launchedById === null || teamId === null) {
    return identity;
  }
  // Only a member of the repository's owning team is credited: a launcher
  // outside it gets the configured identity, as an unknown launcher does.
  const membership = await prisma.teamMembership.findUnique({
    select: { id: true },
    where: { userId_teamId: { teamId, userId: launchedById } },
  });
  if (!membership) {
    return identity;
  }
  if (mode === 'author') {
    identity.author = launcher;
  } else {
    identity.coAuthorTrailer = `Co-authored-by: ${launcher.name} <${launcher.email}>`;
  }
  return identity;
}

/** The six git config keys an identity sets, as `[key, unquoted value]`. */
export function gitIdentityEntries(identity: GitIdentity): Array<[string, string]> {
  return [
    ['user.name', identity.committer.name],
    ['user.email', identity.committer.email],
    ['author.name', identity.author.name],
    ['author.email', identity.author.email],
    ['committer.name', identity.committer.name],
    ['committer.email', identity.committer.email],
  ];
}

/**
 * A `sh -c` script that writes the identity to the global git config. `--`
 * ends option parsing: the schemas allow a name starting with `-`, which git
 * would otherwise read as a switch. One script, so a partial write cannot
 * leave some keys set.
 */
export function gitIdentityConfigScript(identity: GitIdentity): string {
  return gitIdentityEntries(identity)
    .map(([key, value]) => `git config --global -- ${key} ${shellQuote(value)}`)
    .join(' && ');
}

/**
 * `-c` flags for a `git` invocation that ignores global config. Every value
 * is `shellQuote`d: the `git.*` schemas allow shell metacharacters and a
 * leading `-`, so the value is only ever the argument of `-c key=<quoted>`,
 * never bare. Embed the result in a `sh -c` script.
 */
export function gitIdentityFlags(identity: GitIdentity): string {
  return gitIdentityEntries(identity)
    .map(([key, value]) => `-c ${key}=${shellQuote(value)}`)
    .join(' ');
}

/** Appends the trailer to the message text; `git commit --trailer` needs git 2.32. */
export function withCoAuthorTrailer(message: string, identity: GitIdentity): string {
  if (!identity.coAuthorTrailer) {
    return message;
  }
  return `${message.replace(/\n+$/, '')}\n\n${identity.coAuthorTrailer}`;
}
