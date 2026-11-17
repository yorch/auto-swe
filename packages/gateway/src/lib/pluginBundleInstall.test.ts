vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSetting: vi.fn(async () => true),
}));
vi.mock('@auto-swe/shared/db', () => ({ PrismaClient: vi.fn(), prisma: {} }));
vi.mock('@auto-swe/shared/lib/skillScanner', () => ({
  scanSkillContent: vi.fn(async () => ({ incomplete: false, safe: true, warnings: [] })),
}));
const { projectPluginSkills } = vi.hoisted(() => ({ projectPluginSkills: vi.fn() }));
vi.mock('@auto-swe/shared/lib/harnessProfile', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  projectPluginSkills,
}));

import {
  BUNDLE_SCHEMA_VERSION,
  type BundleEntities,
  type BundleManifest,
  computeContentHash,
} from '@auto-swe/shared/bundle';
import { type ProfileFile, packFiles, validateProfile } from '@auto-swe/shared/lib/harnessProfile';
import { normaliseLocation, SkillSourceError } from '@auto-swe/shared/lib/skillSource';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleRoutes } from '../routes/bundles.js';
import {
  BundlePluginCollisionError,
  BundlePluginFetchError,
  BundlePluginHashMismatchError,
  BundlePluginWarningsError,
  BundleProtectedContentError,
  installBundle,
  previewBundle,
} from './bundleService.js';
import type { PluginReader } from './pluginBundleInstall.js';

const SHA = 'a'.repeat(40);

const files: ProfileFile[] = [
  {
    bytes: Buffer.from(
      JSON.stringify({ description: 'Acme pack', name: 'acme-pack', plugins: ['plugins/acme'] })
    ),
    mode: '100644',
    path: 'profile.json',
  },
  {
    bytes: Buffer.from(JSON.stringify({ name: 'acme' })),
    mode: '100644',
    path: 'plugins/acme/.claude-plugin/plugin.json',
  },
];
const validated = (() => {
  const v = validateProfile(files);
  if (!v.ok) {
    throw new Error('fixture invalid');
  }
  return v;
})();

/** A reader that returns the fixture folder (with the given structure/scan warnings). */
function reader(warnings: string[] = []): PluginReader & ReturnType<typeof vi.fn> {
  return vi.fn(async (location, opts) => ({
    files,
    location: normaliseLocation(location),
    sha: opts.atSha,
    validated,
    warnings,
  })) as never;
}

const plugin = (over: Record<string, unknown> = {}) => ({
  bindings: [{ agentKey: 'implementer' }],
  contentHash: validated.contentHash,
  name: 'acme-pack',
  sha: SHA,
  source: { owner: 'Acme', path: 'plugins', repo: 'Tools' },
  ...over,
});

function manifestFor(entities: Partial<BundleEntities>): BundleManifest {
  const full = {
    agents: [],
    scannerPatterns: [],
    skills: [],
    templates: [],
    ...entities,
  } as BundleEntities;
  const metadata = { createdAt: 'now', name: 'pack', version: '1.0.0' };
  return {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    dependencies: [],
    entities: full,
    metadata: {
      ...metadata,
      contentHash: computeContentHash({
        bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
        dependencies: [],
        entities: full,
        metadata,
      }),
    },
  };
}

const head = (over: Record<string, unknown> = {}) => ({
  channelId: null,
  credentialId: null,
  description: null,
  harnessProfiles: [],
  id: 'ag-1',
  inheritsModelFrom: null,
  isActive: true,
  isBuiltIn: false,
  isVerified: false,
  key: 'implementer',
  mcpConnectionId: null,
  modelSpec: 'anthropic/claude-opus-5-5',
  name: 'Implementer',
  orgId: null,
  origin: null,
  reasoning: null,
  runtime: 'claude-code',
  scope: 'GLOBAL',
  skillRefs: [{ skillId: 's1', sortOrder: 2 }],
  systemPrompt: null,
  teamId: null,
  toolKeys: null,
  version: 3,
  workflowTemplateId: null,
  ...over,
});

function newPrisma() {
  const client = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(client)),
    agent: {
      create: vi.fn().mockResolvedValue({ id: 'ag-2' }),
      findFirst: vi.fn().mockResolvedValue(head()),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({ id: 'ag-1' }),
    },
    agentSkillRef: { create: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() },
    harnessProfile: {
      create: vi.fn().mockResolvedValue({ id: 'hp-1' }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    harnessProfileVersion: { findFirst: vi.fn().mockResolvedValue(null) },
    installedBundle: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: 'ib-1' }),
    },
    scannerPattern: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
    skill: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
    workflowTemplate: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  return client;
}

type Prisma = ReturnType<typeof newPrisma>;
let prisma: Prisma;
const asArg = () => prisma as unknown as Parameters<typeof installBundle>[0];

beforeEach(() => {
  vi.clearAllMocks();
  prisma = newPrisma();
  projectPluginSkills.mockResolvedValue({ created: ['acme:review'], refused: [], updated: [] });
});

describe('installBundle with plugin references', () => {
  it('reads the pinned commit, creates the profile with hooks off and binds the agent by cutting a version', async () => {
    const read = reader();
    const res = await installBundle(asArg(), manifestFor({ plugins: [plugin()] }), {
      allowUnverified: true,
      installedById: 'u1',
      pluginReader: read,
    });

    expect(read).toHaveBeenCalledWith(
      { host: 'github.com', owner: 'Acme', path: 'plugins', ref: 'HEAD', repo: 'Tools' },
      { atSha: SHA }
    );
    const created = prisma.harnessProfile.create.mock.calls[0]?.[0].data;
    expect(created).toMatchObject({
      hooksEnabled: false,
      host: 'github.com',
      name: 'acme-pack',
      owner: 'acme',
      versions: {
        create: {
          approvedById: 'u1',
          commitSha: SHA,
          contentHash: validated.contentHash,
          version: 1,
        },
      },
    });

    // A new agent version on top of the head; the old version is never updated.
    expect(prisma.agent.update).not.toHaveBeenCalled();
    expect(prisma.agent.create.mock.calls[0]?.[0].data).toMatchObject({
      harnessProfiles: ['acme-pack'],
      key: 'implementer',
      runtime: 'claude-code',
      version: 4,
    });
    expect(prisma.agentSkillRef.createMany).toHaveBeenCalledWith({
      data: [{ agentId: 'ag-2', skillId: 's1', sortOrder: 2 }],
    });

    expect(res.counts.plugins).toBe(1);
    expect(res.plugins).toEqual({ created: ['acme-pack'], reused: [] });
    expect(projectPluginSkills).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        commitSha: SHA,
        profileId: 'hp-1',
        profileName: 'acme-pack',
        version: 1,
      })
    );
    expect(res.warnings.join('\n')).toContain("plugin 'acme-pack' is created with hooks off");
    expect(res.warnings.join('\n')).toContain('projected 1 new');
  });

  it('refuses a content hash that differs, before anything is written', async () => {
    await expect(
      installBundle(asArg(), manifestFor({ plugins: [plugin({ contentHash: 'f'.repeat(64) })] }), {
        allowUnverified: true,
        pluginReader: reader(),
      })
    ).rejects.toBeInstanceOf(BundlePluginHashMismatchError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.harnessProfile.create).not.toHaveBeenCalled();
  });

  it('turns a refused or failed fetch into a fixed-string error', async () => {
    const failing = vi.fn(async () => {
      throw new SkillSourceError('NETWORK');
    }) as never;
    const err = await installBundle(asArg(), manifestFor({ plugins: [plugin()] }), {
      allowUnverified: true,
      pluginReader: failing,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BundlePluginFetchError);
    expect(err.message).not.toMatch(/ECONN|undefined/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('requires an acknowledgement for the warnings of a profile it would create', async () => {
    const m = manifestFor({ plugins: [plugin()] });
    const err = await installBundle(asArg(), m, {
      allowUnverified: true,
      pluginReader: reader(['ships a script']),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BundlePluginWarningsError);
    expect(err.warnings).toEqual(["plugin 'acme-pack': ships a script"]);
    expect(prisma.$transaction).not.toHaveBeenCalled();

    const ok = await installBundle(asArg(), m, {
      acknowledgeWarnings: true,
      allowUnverified: true,
      pluginReader: reader(['ships a script']),
    });
    expect(ok.warnings).toContain("plugin 'acme-pack': ships a script");
  });

  it('reuses an approved profile with the same content and leaves its hook switch alone', async () => {
    prisma.harnessProfile.findMany.mockResolvedValue([
      { id: 'hp-9', name: 'acme-pack', status: 'OK' },
    ]);
    prisma.harnessProfileVersion.findFirst.mockResolvedValue({ version: 4 });
    const res = await installBundle(asArg(), manifestFor({ plugins: [plugin()] }), {
      allowUnverified: true,
      pluginReader: reader(['ships a script']),
    });
    expect(prisma.harnessProfile.create).not.toHaveBeenCalled();
    expect(prisma.harnessProfile.update).not.toHaveBeenCalled();
    expect(res.plugins).toEqual({ created: [], reused: ['acme-pack'] });
    // Approved earlier: no acknowledgement needed, and no hooks-off note.
    expect(res.warnings.join('\n')).not.toContain('created with hooks off');
    expect(projectPluginSkills).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ profileId: 'hp-9', version: 4 })
    );
  });

  it('is a conflict, not an overwrite, when the name is approved with different content', async () => {
    prisma.harnessProfile.findMany.mockResolvedValue([
      { id: 'hp-9', name: 'acme-pack', status: 'OK' },
    ]);
    const err = await installBundle(asArg(), manifestFor({ plugins: [plugin()] }), {
      allowUnverified: true,
      overwriteProtected: true,
      pluginReader: reader(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BundleProtectedContentError);
    expect(err.conflicts.plugins).toEqual(['acme-pack']);
    expect(prisma.harnessProfile.create).not.toHaveBeenCalled();
    expect(prisma.installedBundle.upsert).not.toHaveBeenCalled();
  });

  it('warns instead of binding an agent that is missing or not on claude-code', async () => {
    prisma.agent.findFirst.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === 'ghost' ? null : head({ runtime: 'mastra' })
    );
    const res = await installBundle(
      asArg(),
      manifestFor({
        plugins: [plugin({ bindings: [{ agentKey: 'implementer' }, { agentKey: 'ghost' }] })],
      }),
      { acknowledgeWarnings: true, allowUnverified: true, pluginReader: reader() }
    );
    expect(prisma.agent.create).not.toHaveBeenCalled();
    const text = res.warnings.join('\n');
    expect(text).toContain("agent 'implementer' does not run on the claude-code runtime");
    expect(text).toContain("agent 'ghost' is not installed");
  });

  it('does not cut a version for an agent that already has the plugin', async () => {
    prisma.agent.findFirst.mockResolvedValue(head({ harnessProfiles: ['acme-pack'] }));
    await installBundle(asArg(), manifestFor({ plugins: [plugin()] }), {
      allowUnverified: true,
      pluginReader: reader(),
    });
    expect(prisma.agent.create).not.toHaveBeenCalled();
  });

  it('reports a projection that throws as a warning; the install stands', async () => {
    projectPluginSkills.mockRejectedValue(new Error('db secret text'));
    const res = await installBundle(asArg(), manifestFor({ plugins: [plugin()] }), {
      allowUnverified: true,
      pluginReader: reader(),
    });
    expect(res.warnings).toContain("plugin 'acme-pack': its skills could not be projected");
    expect(res.warnings.join('\n')).not.toContain('db secret');
  });

  it('installs a bundle with no plugins without reading anything', async () => {
    const read = reader();
    const res = await installBundle(asArg(), manifestFor({}), {
      allowUnverified: true,
      pluginReader: read,
    });
    expect(read).not.toHaveBeenCalled();
    expect(res.plugins).toBeUndefined();
    expect(res.counts.plugins).toBeUndefined();
  });
});

describe('previewBundle with plugin references', () => {
  it('reports what each plugin would do, with warnings, bindings and the hooks-off note', async () => {
    const res = await previewBundle(asArg(), manifestFor({ plugins: [plugin()] }), {
      allowUnverified: true,
      pluginReader: reader(['ships a script']),
    });
    expect(res.plugins).toEqual([
      {
        action: 'create',
        bindings: [{ agentKey: 'implementer', outcome: 'bind' }],
        contentHash: validated.contentHash,
        hooksEnabled: false,
        name: 'acme-pack',
        sha: SHA,
        warnings: ["plugin 'acme-pack': ships a script"],
      },
    ]);
    expect(res.warnings.join('\n')).toContain("plugin 'acme-pack' is created with hooks off");
    expect(prisma.harnessProfile.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a hash it would refuse at install, and blocks on a conflict', async () => {
    await expect(
      previewBundle(asArg(), manifestFor({ plugins: [plugin({ contentHash: 'f'.repeat(64) })] }), {
        allowUnverified: true,
        pluginReader: reader(),
      })
    ).rejects.toBeInstanceOf(BundlePluginHashMismatchError);

    prisma.harnessProfile.findMany.mockResolvedValue([
      { id: 'hp-9', name: 'acme-pack', status: 'OK' },
    ]);
    const res = await previewBundle(asArg(), manifestFor({ plugins: [plugin()] }), {
      allowUnverified: true,
      pluginReader: reader(),
    });
    expect(res.plugins[0]?.action).toBe('conflict');
    expect(res.blockedReason).toContain('acme-pack');
  });

  it('predicts the binding from the bundle’s own agent runtime', async () => {
    prisma.agent.findFirst.mockResolvedValue(head({ runtime: 'mastra' }));
    const res = await previewBundle(
      asArg(),
      manifestFor({
        agents: [{ key: 'implementer', name: 'I', runtime: 'claude-code' }],
        plugins: [plugin()],
      }),
      { allowUnverified: true, pluginReader: reader() }
    );
    expect(res.plugins[0]?.bindings).toEqual([{ agentKey: 'implementer', outcome: 'bind' }]);
  });
});

describe('plugin name collisions on bind', () => {
  /** The agent already carries `other-kit`, whose latest snapshot holds a plugin named `plugin`. */
  function otherKitHolds(plugin: string) {
    const manifest = { description: 'd', name: 'other-kit', plugins: ['plugins/p'] };
    prisma.agent.findFirst.mockResolvedValue(head({ harnessProfiles: ['other-kit'] }));
    (prisma.harnessProfile as Record<string, unknown>).findUnique = vi
      .fn()
      .mockResolvedValue({ id: 'hp-other', latestVersion: 1 });
    (prisma.harnessProfileVersion as Record<string, unknown>).findUnique = vi
      .fn()
      .mockResolvedValue({
        files: new Uint8Array(
          packFiles([
            { bytes: Buffer.from(JSON.stringify(manifest)), mode: '100644', path: 'profile.json' },
            {
              bytes: Buffer.from(JSON.stringify({ name: plugin })),
              mode: '100644',
              path: 'plugins/p/.claude-plugin/plugin.json',
            },
          ])
        ),
        manifest,
      });
  }

  it('refuses the install before any write when a bound plugin has the same name, naming both', async () => {
    otherKitHolds('Acme');
    const err = await installBundle(asArg(), manifestFor({ plugins: [plugin()] }), {
      allowUnverified: true,
      pluginReader: reader(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BundlePluginCollisionError);
    expect(err.code).toBe('PROFILE_NAME_COLLISION');
    expect(err.message).toContain("'other-kit'");
    expect(err.message).toContain("'acme-pack'");
    expect(err.message).toContain("'acme'");
    expect(prisma.harnessProfile.create).not.toHaveBeenCalled();
    expect(prisma.agent.create).not.toHaveBeenCalled();
  });

  it('installs when the names differ, and previews the block as a blockedReason', async () => {
    otherKitHolds('different');
    const ok = await installBundle(asArg(), manifestFor({ plugins: [plugin()] }), {
      allowUnverified: true,
      pluginReader: reader(),
    });
    expect(ok.plugins?.created).toEqual(['acme-pack']);
    otherKitHolds('acme');
    const preview = await previewBundle(asArg(), manifestFor({ plugins: [plugin()] }), {
      allowUnverified: true,
      pluginReader: reader(),
    });
    expect(preview.blockedReason).toContain("'other-kit'");
    expect(preview.blockedReason).toContain("'acme-pack'");
  });

  it('refuses a plugin listed twice, or bound to one agent twice, before any write', async () => {
    for (const plugins of [
      [plugin(), plugin()],
      [plugin({ bindings: [{ agentKey: 'implementer' }, { agentKey: 'implementer' }] })],
    ]) {
      await expect(
        installBundle(asArg(), manifestFor({ plugins }), {
          allowUnverified: true,
          pluginReader: reader(),
        })
      ).rejects.toThrow();
    }
    expect(prisma.harnessProfile.create).not.toHaveBeenCalled();
    expect(prisma.agent.create).not.toHaveBeenCalled();
  });

  it('answers 400 PROFILE_NAME_COLLISION from the install route', async () => {
    vi.stubEnv('BUNDLE_ALLOW_UNVERIFIED', '1');
    otherKitHolds('acme');
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate(
      'prisma',
      Object.assign(prisma, { configAuditLog: { create: vi.fn().mockResolvedValue({}) } }) as never
    );
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ADMIN', sub: 'admin-1' }),
    } as never);
    await app.register(bundleRoutes, { pluginReader: reader(), prefix: '/api/v1/other' });
    await app.ready();
    const res = await app.inject({
      body: { bundle: manifestFor({ plugins: [plugin()] }) },
      headers: { authorization: 'Bearer fake' },
      method: 'POST',
      url: '/api/v1/other/bundles/install',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('PROFILE_NAME_COLLISION');
    await app.close();
    vi.unstubAllEnvs();
  });
});

describe('bundle routes with plugin references', () => {
  async function buildApp(pluginReader: PluginReader) {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate(
      'prisma',
      Object.assign(prisma, {
        configAuditLog: { create: vi.fn().mockResolvedValue({}) },
      }) as never
    );
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ADMIN', sub: 'admin-1' }),
    } as never);
    await app.register(bundleRoutes, { prefix: '/api/v1/platform' });
    await app.register(bundleRoutes, { pluginReader, prefix: '/api/v1/other' });
    await app.ready();
    return app;
  }
  const AUTH = { authorization: 'Bearer fake' };

  it('answers 400 BUNDLE_PLUGIN_HASH_MISMATCH naming the plugin', async () => {
    vi.stubEnv('BUNDLE_ALLOW_UNVERIFIED', '1');
    const app = await buildApp(reader());
    const res = await app.inject({
      body: { bundle: manifestFor({ plugins: [plugin({ contentHash: 'f'.repeat(64) })] }) },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/other/bundles/install',
    });
    expect(res.statusCode).toBe(400);
    const error = JSON.parse(res.payload).error;
    expect(error.code).toBe('BUNDLE_PLUGIN_HASH_MISMATCH');
    expect(error.message).toContain('acme-pack');
    expect(prisma.harnessProfile.create).not.toHaveBeenCalled();
    await app.close();
    vi.unstubAllEnvs();
  });

  it('answers 409 WARNINGS_UNACKNOWLEDGED, then installs once acknowledged', async () => {
    vi.stubEnv('BUNDLE_ALLOW_UNVERIFIED', '1');
    const app = await buildApp(reader(['ships a script']));
    const bundle = manifestFor({ plugins: [plugin()] });
    const first = await app.inject({
      body: { bundle },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/other/bundles/install',
    });
    expect(first.statusCode).toBe(409);
    expect(JSON.parse(first.payload).error).toMatchObject({
      code: 'WARNINGS_UNACKNOWLEDGED',
      details: { warnings: ["plugin 'acme-pack': ships a script"] },
    });
    const second = await app.inject({
      body: { acknowledgeWarnings: true, bundle },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/other/bundles/install',
    });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.payload).data.plugins).toEqual({
      created: ['acme-pack'],
      reused: [],
    });
    await app.close();
    vi.unstubAllEnvs();
  });

  it('answers 409 PROTECTED_CONTENT_OVERWRITE for a name approved with other content', async () => {
    vi.stubEnv('BUNDLE_ALLOW_UNVERIFIED', '1');
    prisma.harnessProfile.findMany.mockResolvedValue([
      { id: 'hp-9', name: 'acme-pack', status: 'OK' },
    ]);
    const app = await buildApp(reader());
    const res = await app.inject({
      body: { bundle: manifestFor({ plugins: [plugin()] }), overwriteProtected: true },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/other/bundles/install',
    });
    expect(res.statusCode).toBe(409);
    const error = JSON.parse(res.payload).error;
    expect(error.code).toBe('PROTECTED_CONTENT_OVERWRITE');
    expect(error.conflicts.plugins).toEqual(['acme-pack']);
    await app.close();
    vi.unstubAllEnvs();
  });
});
