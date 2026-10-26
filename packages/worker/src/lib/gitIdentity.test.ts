import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const teamFindUnique = vi.fn();
const userFindUnique = vi.fn();
const membershipFindUnique = vi.fn();
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    team: { findUnique: (...a: unknown[]) => teamFindUnique(...a) },
    teamMembership: { findUnique: (...a: unknown[]) => membershipFindUnique(...a) },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
  },
}));

const resolveSettings = vi.fn();
vi.mock('@auto-swe/shared/config', () => ({
  resolveSettings: (...a: unknown[]) => resolveSettings(...a),
}));

const currentRunLaunchContext = vi.fn();
vi.mock('./runLauncher.js', () => ({
  currentRunLaunchContext: () => currentRunLaunchContext(),
}));

const { DEFAULT_GIT_IDENTITY, gitIdentityFlags, resolveGitIdentity, withCoAuthorTrailer } =
  await import('./gitIdentity.js');

const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const CONFIGURED = { email: 'bot@acme.example', name: 'Acme Bot' };
const VERIFIED_LAUNCHER = { email: 'ada@acme.example', emailVerified: true, name: 'Ada Lovelace' };

function settings(mode: string, identity = CONFIGURED) {
  resolveSettings.mockResolvedValue({
    'git.authorEmail': identity.email,
    'git.authorName': identity.name,
    'git.launcherAttribution': mode,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  teamFindUnique.mockResolvedValue({ orgId: 'org-1' });
  currentRunLaunchContext.mockResolvedValue({
    launchedById: 'user-1',
    workflowTemplateId: 'tpl-1',
  });
  userFindUnique.mockResolvedValue(VERIFIED_LAUNCHER);
  membershipFindUnique.mockResolvedValue({ id: 'membership-1' });
  settings('none');
});

describe('resolveGitIdentity scope', () => {
  it('reads the settings with the team, its organization and the run template', async () => {
    await resolveGitIdentity({ teamId: 'team-1' });
    expect(resolveSettings).toHaveBeenCalledWith(
      ['git.authorName', 'git.authorEmail', 'git.launcherAttribution'],
      { orgId: 'org-1', teamId: 'team-1', workflowTemplateId: 'tpl-1' }
    );
    expect(teamFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'team-1' } })
    );
  });

  it('resolves from the team and organization alone outside a workflow run', async () => {
    currentRunLaunchContext.mockResolvedValue(null);
    settings('co-author-trailer');
    const identity = await resolveGitIdentity({ teamId: 'team-1' });
    expect(resolveSettings).toHaveBeenCalledWith(expect.anything(), {
      orgId: 'org-1',
      teamId: 'team-1',
      workflowTemplateId: undefined,
    });
    expect(identity.coAuthorTrailer).toBeUndefined();
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it('throws for a team that does not exist rather than resolving a broader scope', async () => {
    teamFindUnique.mockResolvedValue(null);
    await expect(resolveGitIdentity({ teamId: 'team-gone' })).rejects.toThrow(/team-gone/);
    expect(resolveSettings).not.toHaveBeenCalled();
  });

  it('skips the team lookup and resolves from the global tier for a null team', async () => {
    await resolveGitIdentity({ teamId: null });
    expect(teamFindUnique).not.toHaveBeenCalled();
    expect(resolveSettings).toHaveBeenCalledWith(expect.anything(), {
      orgId: undefined,
      teamId: undefined,
      workflowTemplateId: 'tpl-1',
    });
  });

  it('resolves a null team with no template outside a workflow run, and attributes no one', async () => {
    currentRunLaunchContext.mockResolvedValue(null);
    settings('author');
    const identity = await resolveGitIdentity({ teamId: null });
    expect(resolveSettings).toHaveBeenCalledWith(expect.anything(), {
      orgId: undefined,
      teamId: undefined,
      workflowTemplateId: undefined,
    });
    expect(identity.author).toEqual(CONFIGURED);
  });

  it('omits the organization for a team that has none', async () => {
    teamFindUnique.mockResolvedValue({ orgId: null });
    await resolveGitIdentity({ teamId: 'team-1' });
    expect(resolveSettings).toHaveBeenCalledWith(expect.anything(), {
      orgId: undefined,
      teamId: 'team-1',
      workflowTemplateId: 'tpl-1',
    });
  });
});

describe('resolveGitIdentity configured identity', () => {
  it('is auto-swe <auto-swe@localhost> as author and committer by default', async () => {
    settings('none', { email: 'auto-swe@localhost', name: 'auto-swe' });
    const identity = await resolveGitIdentity({ teamId: 'team-1' });
    expect(identity).toEqual(DEFAULT_GIT_IDENTITY);
    expect(DEFAULT_GIT_IDENTITY).toEqual({
      author: { email: 'auto-swe@localhost', name: 'auto-swe' },
      committer: { email: 'auto-swe@localhost', name: 'auto-swe' },
    });
  });

  it('gives author and committer the resolved override', async () => {
    const identity = await resolveGitIdentity({ teamId: 'team-1' });
    expect(identity.author).toEqual(CONFIGURED);
    expect(identity.committer).toEqual(CONFIGURED);
    expect(identity.coAuthorTrailer).toBeUndefined();
  });

  it('lets a settings database error throw instead of using a fallback identity', async () => {
    resolveSettings.mockRejectedValue(new Error('connection reset'));
    await expect(resolveGitIdentity({ teamId: 'team-1' })).rejects.toThrow('connection reset');
  });

  it('lets a team lookup error throw', async () => {
    teamFindUnique.mockRejectedValue(new Error('connection reset'));
    await expect(resolveGitIdentity({ teamId: 'team-1' })).rejects.toThrow('connection reset');
  });

  it('lets a launcher lookup error throw', async () => {
    settings('author');
    userFindUnique.mockRejectedValue(new Error('connection reset'));
    await expect(resolveGitIdentity({ teamId: 'team-1' })).rejects.toThrow('connection reset');
  });
});

describe('resolveGitIdentity launcher attribution', () => {
  it('adds no trailer and keeps the configured author in none mode', async () => {
    const identity = await resolveGitIdentity({ teamId: 'team-1' });
    expect(identity.coAuthorTrailer).toBeUndefined();
    expect(identity.author).toEqual(CONFIGURED);
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it('adds a Co-authored-by trailer and keeps the configured identity in trailer mode', async () => {
    settings('co-author-trailer');
    const identity = await resolveGitIdentity({ teamId: 'team-1' });
    expect(identity.coAuthorTrailer).toBe('Co-authored-by: Ada Lovelace <ada@acme.example>');
    expect(identity.author).toEqual(CONFIGURED);
    expect(identity.committer).toEqual(CONFIGURED);
  });

  it('makes the launcher the author and keeps the configured committer in author mode', async () => {
    settings('author');
    const identity = await resolveGitIdentity({ teamId: 'team-1' });
    expect(identity.author).toEqual({ email: 'ada@acme.example', name: 'Ada Lovelace' });
    expect(identity.committer).toEqual(CONFIGURED);
    expect(identity.coAuthorTrailer).toBeUndefined();
  });

  it('uses the email address as the name when the launcher has no name', async () => {
    settings('co-author-trailer');
    userFindUnique.mockResolvedValue({ ...VERIFIED_LAUNCHER, name: '' });
    const identity = await resolveGitIdentity({ teamId: 'team-1' });
    expect(identity.coAuthorTrailer).toBe('Co-authored-by: ada@acme.example <ada@acme.example>');
  });

  it.each(['co-author-trailer', 'author'])(
    'uses the configured identity with no trailer when the launcher email is unverified (%s)',
    async (mode) => {
      settings(mode);
      userFindUnique.mockResolvedValue({ ...VERIFIED_LAUNCHER, emailVerified: false });
      const identity = await resolveGitIdentity({ teamId: 'team-1' });
      expect(identity.author).toEqual(CONFIGURED);
      expect(identity.committer).toEqual(CONFIGURED);
      expect(identity.coAuthorTrailer).toBeUndefined();
    }
  );

  it.each([
    ['co-author-trailer', { launchedById: null, workflowTemplateId: 'tpl-1' }],
    ['author', { launchedById: null, workflowTemplateId: 'tpl-1' }],
    ['co-author-trailer', null],
    ['author', null],
  ])('uses the configured identity when there is no launcher (%s)', async (mode, context) => {
    settings(mode);
    currentRunLaunchContext.mockResolvedValue(context);
    const identity = await resolveGitIdentity({ teamId: 'team-1' });
    expect(identity.author).toEqual(CONFIGURED);
    expect(identity.coAuthorTrailer).toBeUndefined();
  });

  it.each(['co-author-trailer', 'author'])(
    'uses the configured identity when the launcher row no longer exists (%s)',
    async (mode) => {
      settings(mode);
      userFindUnique.mockResolvedValue(null);
      const identity = await resolveGitIdentity({ teamId: 'team-1' });
      expect(identity.author).toEqual(CONFIGURED);
      expect(identity.coAuthorTrailer).toBeUndefined();
    }
  );

  it('strips newlines and angle brackets from the launcher name so no extra trailer line exists', async () => {
    settings('co-author-trailer');
    userFindUnique.mockResolvedValue({
      ...VERIFIED_LAUNCHER,
      name: `Eve <x@y.z>\nCo-authored-by: Mallory <m@evil.example>${LINE_SEPARATOR}`,
    });
    const identity = await resolveGitIdentity({ teamId: 'team-1' });
    const trailer = identity.coAuthorTrailer ?? '';
    expect(trailer).not.toMatch(new RegExp(`[\\r\\n${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, 'u'));
    expect(trailer.startsWith('Co-authored-by: ')).toBe(true);
    expect(trailer.endsWith(' <ada@acme.example>')).toBe(true);
    const name = trailer.slice('Co-authored-by: '.length, -' <ada@acme.example>'.length);
    expect(name).not.toMatch(/[<>\n\r]/);
  });

  it('strips newlines and angle brackets from the launcher name used as the author', async () => {
    settings('author');
    userFindUnique.mockResolvedValue({ ...VERIFIED_LAUNCHER, name: 'Eve\n<evil>' });
    const identity = await resolveGitIdentity({ teamId: 'team-1' });
    expect(identity.author.name).toBe('Eveevil');
  });

  it('falls back to the email address when stripping leaves the launcher name empty', async () => {
    settings('author');
    userFindUnique.mockResolvedValue({ ...VERIFIED_LAUNCHER, name: '<>\n' });
    const identity = await resolveGitIdentity({ teamId: 'team-1' });
    expect(identity.author.name).toBe('ada@acme.example');
  });

  it('caps the launcher name at 100 characters like the configured name', async () => {
    settings('author');
    userFindUnique.mockResolvedValue({ ...VERIFIED_LAUNCHER, name: 'n'.repeat(300) });
    const identity = await resolveGitIdentity({ teamId: 'team-1' });
    expect(identity.author.name).toBe('n'.repeat(100));
  });

  it.each([
    'a b@acme.example',
    'a\tb@acme.example',
    'a<b@acme.example',
    'a​b@acme.example',
    'ada@acme.example\n',
    'no-at-sign',
    `${'a'.repeat(250)}@acme.example`,
  ])('refuses to rewrite the launcher email %j, using the configured identity', async (email) => {
    for (const mode of ['author', 'co-author-trailer']) {
      settings(mode);
      userFindUnique.mockResolvedValue({ ...VERIFIED_LAUNCHER, email });
      const identity = await resolveGitIdentity({ teamId: 'team-1' });
      expect(identity.author).toEqual(CONFIGURED);
      expect(identity.coAuthorTrailer).toBeUndefined();
    }
  });
});

describe('resolveGitIdentity owning-team rule', () => {
  it.each(['co-author-trailer', 'author'])(
    'credits a launcher who is a member of the owning team (%s)',
    async (mode) => {
      settings(mode);
      const identity = await resolveGitIdentity({ teamId: 'team-1' });
      expect(membershipFindUnique).toHaveBeenCalledWith({
        select: { id: true },
        where: { userId_teamId: { teamId: 'team-1', userId: 'user-1' } },
      });
      if (mode === 'author') {
        expect(identity.author.email).toBe('ada@acme.example');
      } else {
        expect(identity.coAuthorTrailer).toContain('ada@acme.example');
      }
    }
  );

  it.each(['co-author-trailer', 'author'])(
    'uses the configured identity with no trailer for a launcher outside the owning team (%s)',
    async (mode) => {
      settings(mode);
      membershipFindUnique.mockResolvedValue(null);
      const identity = await resolveGitIdentity({ teamId: 'team-1' });
      expect(identity.author).toEqual(CONFIGURED);
      expect(identity.committer).toEqual(CONFIGURED);
      expect(identity.coAuthorTrailer).toBeUndefined();
    }
  );

  it.each(['co-author-trailer', 'author'])(
    'attributes no one when the repository has no team (%s)',
    async (mode) => {
      settings(mode);
      const identity = await resolveGitIdentity({ teamId: null });
      expect(identity.author).toEqual(CONFIGURED);
      expect(identity.coAuthorTrailer).toBeUndefined();
    }
  );

  it('runs no membership query in none mode', async () => {
    await resolveGitIdentity({ teamId: 'team-1' });
    expect(membershipFindUnique).not.toHaveBeenCalled();
  });

  it('lets a membership lookup error throw', async () => {
    settings('author');
    membershipFindUnique.mockRejectedValue(new Error('connection reset'));
    await expect(resolveGitIdentity({ teamId: 'team-1' })).rejects.toThrow('connection reset');
  });

  it.each([',;', '"', '. ,', '\\'])(
    'falls back to the email when the launcher name %j is only characters git refuses',
    async (name) => {
      settings('author');
      userFindUnique.mockResolvedValue({ ...VERIFIED_LAUNCHER, name });
      const identity = await resolveGitIdentity({ teamId: 'team-1' });
      expect(identity.author.name).toBe('ada@acme.example');
    }
  );

  it('does not split a surrogate pair when capping the name at 100 code points', async () => {
    settings('author');
    userFindUnique.mockResolvedValue({ ...VERIFIED_LAUNCHER, name: '\u{1F600}'.repeat(150) });
    const { name } = (await resolveGitIdentity({ teamId: 'team-1' })).author;
    expect(Array.from(name)).toHaveLength(100);
    expect(name).not.toMatch(/\p{Cs}/u);
  });
});

describe('gitIdentityFlags', () => {
  const identity = {
    author: { email: 'a@x.example', name: 'Author Name' },
    committer: { email: 'c@x.example', name: 'Committer Name' },
  };

  it('emits the user, author and committer keys for name and email', () => {
    const flags = gitIdentityFlags(identity);
    expect(flags).toContain("-c user.name='Committer Name'");
    expect(flags).toContain("-c user.email='c@x.example'");
    expect(flags).toContain("-c committer.name='Committer Name'");
    expect(flags).toContain("-c committer.email='c@x.example'");
    expect(flags).toContain("-c author.name='Author Name'");
    expect(flags).toContain("-c author.email='a@x.example'");
  });

  it("quotes an apostrophe so O'Brien survives intact", () => {
    const flags = gitIdentityFlags({
      author: { email: 'o@x.example', name: "O'Brien" },
      committer: { email: 'o@x.example', name: "O'Brien" },
    });
    expect(flags).toContain("-c author.name='O'\\''Brien'");
  });

  describe('against a real shell and git', () => {
    const run = (cwd: string, flags: string) =>
      execFileSync('sh', ['-c', `git ${flags} commit --allow-empty -q -m msg`], {
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
    const show = (cwd: string, format: string) =>
      execFileSync('git', ['log', '-1', `--format=${format}`], { cwd })
        .toString()
        .replace(/\n$/, '');

    it('records an apostrophe name exactly and runs no command from a metacharacter name', () => {
      const dir = mkdtempSync(join(tmpdir(), 'gitident-'));
      const marker = join(dir, 'pwned');
      try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        const hostile = `x $(touch ${marker})\`touch ${marker}\`'; touch ${marker}; ' y`;
        run(
          dir,
          gitIdentityFlags({
            author: { email: 'o@x.example', name: "O'Brien" },
            committer: { email: 'bot@x.example', name: hostile },
          })
        );
        expect(existsSync(marker)).toBe(false);
        expect(show(dir, '%an')).toBe("O'Brien");
        expect(show(dir, '%cn')).toBe(hostile);
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    });

    it('treats a name with a leading dash as a value, not an option', () => {
      const dir = mkdtempSync(join(tmpdir(), 'gitident-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        run(
          dir,
          gitIdentityFlags({
            author: { email: 'a@x.example', name: '--amend' },
            committer: { email: 'a@x.example', name: '--amend' },
          })
        );
        expect(show(dir, '%an')).toBe('--amend');
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    });
  });
});

describe('withCoAuthorTrailer', () => {
  const base = {
    author: { email: 'a@x.example', name: 'A' },
    committer: { email: 'a@x.example', name: 'A' },
  };

  it('appends a blank line and the trailer to the message', () => {
    const identity = { ...base, coAuthorTrailer: 'Co-authored-by: Ada <ada@x.example>' };
    expect(withCoAuthorTrailer('fix: thing', identity)).toBe(
      'fix: thing\n\nCo-authored-by: Ada <ada@x.example>'
    );
  });

  it('does not stack blank lines when the message already ends in a newline', () => {
    const identity = { ...base, coAuthorTrailer: 'Co-authored-by: Ada <ada@x.example>' };
    expect(withCoAuthorTrailer('fix: thing\n', identity)).toBe(
      'fix: thing\n\nCo-authored-by: Ada <ada@x.example>'
    );
  });

  it('returns the message unchanged when there is no trailer', () => {
    expect(withCoAuthorTrailer('fix: thing', base)).toBe('fix: thing');
  });
});
