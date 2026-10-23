import { resolveSettings } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
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
  const name = (user.name ?? '')
    .replace(UNSAFE_NAME_CHARS, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return { email, name: name || email };
}

/**
 * The identity every commit in a workspace carries. Settings resolve through
 * the full cascade (template, team, organization, global); outside a workflow
 * run there is no template and no launcher, so no attribution. A database
 * failure throws and the activity retries: the platform never commits under a
 * fallback identity.
 */
export async function resolveGitIdentity(scope: { teamId: string }): Promise<GitIdentity> {
  const [team, launch] = await Promise.all([
    prisma.team.findUnique({ select: { orgId: true }, where: { id: scope.teamId } }),
    currentRunLaunchContext(),
  ]);
  if (!team) {
    throw new Error(`Cannot resolve a git identity: team ${scope.teamId} does not exist`);
  }
  const configured = await resolveSettings(
    ['git.authorName', 'git.authorEmail', 'git.launcherAttribution'],
    {
      orgId: team.orgId ?? undefined,
      teamId: scope.teamId,
      workflowTemplateId: launch?.workflowTemplateId,
    }
  );
  const committer = { email: configured['git.authorEmail'], name: configured['git.authorName'] };
  const mode = configured['git.launcherAttribution'];
  const identity: GitIdentity = { author: { ...committer }, committer };
  if (mode === 'none') {
    return identity;
  }
  const launcher = await resolveLauncher(launch?.launchedById ?? null);
  if (!launcher) {
    return identity;
  }
  if (mode === 'author') {
    identity.author = launcher;
  } else {
    identity.coAuthorTrailer = `Co-authored-by: ${launcher.name} <${launcher.email}>`;
  }
  return identity;
}

/**
 * `-c` flags for a `git` invocation that ignores global config. Every value
 * is `shellQuote`d: the `git.*` schemas allow shell metacharacters and a
 * leading `-`, so the value is only ever the argument of `-c key=<quoted>`,
 * never bare. Embed the result in a `sh -c` script.
 */
export function gitIdentityFlags(identity: GitIdentity): string {
  const pairs: Array<[string, string]> = [
    ['user.name', identity.committer.name],
    ['user.email', identity.committer.email],
    ['author.name', identity.author.name],
    ['author.email', identity.author.email],
    ['committer.name', identity.committer.name],
    ['committer.email', identity.committer.email],
  ];
  return pairs.map(([key, value]) => `-c ${key}=${shellQuote(value)}`).join(' ');
}

/** Appends the trailer to the message text; `git commit --trailer` needs git 2.32. */
export function withCoAuthorTrailer(message: string, identity: GitIdentity): string {
  if (!identity.coAuthorTrailer) {
    return message;
  }
  return `${message.replace(/\n+$/, '')}\n\n${identity.coAuthorTrailer}`;
}
