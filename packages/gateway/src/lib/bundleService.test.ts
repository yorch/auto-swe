import { generateKeyPairSync } from 'node:crypto';

vi.mock('@auto-swe/shared/db', () => ({
  PrismaClient: vi.fn(),
  prisma: {},
}));

import {
  BUNDLE_SCHEMA_VERSION,
  type BundleEntities,
  type BundleManifest,
  computeContentHash,
  signContentHash,
} from '@auto-swe/shared/bundle';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BundleDependencyError,
  BundleIntegrityError,
  exportBundle,
  installBundle,
} from './bundleService.js';

function manifestFor(
  entities: BundleEntities,
  dependencies: { connectionType: string }[] = [],
  metaOver: { name?: string; version?: string } = {}
): BundleManifest {
  const metadata = {
    createdAt: 'now',
    name: metaOver.name ?? 'test',
    version: metaOver.version ?? '1.0.0',
  };
  return {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    dependencies,
    entities,
    metadata: {
      ...metadata,
      contentHash: computeContentHash({
        bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
        dependencies,
        entities,
        metadata,
      }),
    },
  };
}

const EMPTY: BundleEntities = { agents: [], scannerPatterns: [], skills: [], templates: [] };

/** Smallest runnable spec: entry straight into a terminate node. */
const RUNNABLE_SPEC = {
  description: '',
  entry: 'end',
  name: 'std',
  nodes: { end: { status: 'SUCCESS', type: 'terminate' } },
  schemaVersion: 1,
};

describe('exportBundle', () => {
  it('serializes GLOBAL content, strips locals, and derives the mcp dependency', async () => {
    const prisma = {
      agent: {
        findMany: vi.fn().mockResolvedValue([
          {
            description: 'r',
            inheritsModelFrom: null,
            isVerified: true,
            key: 'reviewer',
            modelSpec: 'anthropic/claude-opus-4-8',
            name: 'Reviewer',
            origin: 'swe-starter',
            skillRefs: [{ skill: { name: 'careful-review' }, sortOrder: 0 }],
            systemPrompt: 'be careful',
            toolKeys: ['bash', 'mcp'],
          },
        ]),
      },
      scannerPattern: { findMany: vi.fn().mockResolvedValue([]) },
      skill: { findMany: vi.fn().mockResolvedValue([]) },
      workflowTemplate: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as Parameters<typeof exportBundle>[0];

    const m = await exportBundle(prisma, { name: 'swe', origin: 'swe-starter', version: '1.0.0' });

    expect(m.entities.agents).toEqual([
      {
        description: 'r',
        inheritsModelFrom: null,
        isVerified: true,
        key: 'reviewer',
        modelSpec: 'anthropic/claude-opus-4-8',
        name: 'Reviewer',
        origin: 'swe-starter',
        skills: [{ skill: 'careful-review', sortOrder: 0 }],
        systemPrompt: 'be careful',
        toolKeys: ['bash', 'mcp'],
      },
    ]);
    expect(m.dependencies).toEqual([{ connectionType: 'mcp' }]);
    expect(m.metadata.contentHash).toBe(computeContentHash(m));
  });
});

describe('installBundle', () => {
  let prisma: ReturnType<typeof newPrisma>;

  function newPrisma() {
    const client = {
      // installBundle wraps all writes in a transaction; the callback receives a
      // tx client — feed it this same mock so the per-model spies still capture calls.
      $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(client)),
      agent: {
        create: vi.fn().mockResolvedValue({ id: 'a1' }),
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({ id: 'a1' }),
      },
      agentSkillRef: { create: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn() },
      installedBundle: { upsert: vi.fn() },
      scannerPattern: { upsert: vi.fn() },
      skill: {
        create: vi.fn().mockResolvedValue({ id: 's1' }),
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      },
      workflowTemplate: {
        create: vi.fn().mockResolvedValue({ id: 't1' }),
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      },
      workflowTemplateVersion: { upsert: vi.fn() },
    };
    return client;
  }

  beforeEach(() => {
    prisma = newPrisma();
  });

  const asArg = () => prisma as unknown as Parameters<typeof installBundle>[0];

  it('throws BundleIntegrityError on a content-hash mismatch', async () => {
    const m = manifestFor({ ...EMPTY, skills: [{ name: 's', promptText: 'p' }] });
    m.metadata.contentHash = 'tampered';
    await expect(installBundle(asArg(), m)).rejects.toBeInstanceOf(BundleIntegrityError);
    expect(prisma.skill.create).not.toHaveBeenCalled();
  });

  it('throws BundleDependencyError on an unsupported connection type (before any write)', async () => {
    const m = manifestFor({ ...EMPTY }, [{ connectionType: 'salesforce' }]);
    await expect(installBundle(asArg(), m)).rejects.toBeInstanceOf(BundleDependencyError);
    expect(prisma.agent.create).not.toHaveBeenCalled();
  });

  it('throws on a malformed (non-schema) bundle', async () => {
    await expect(installBundle(asArg(), { not: 'a bundle' })).rejects.toBeTruthy();
  });

  it('idempotently seeds skills, patterns, agents (+ refs), and templates', async () => {
    // 1st findFirst = skill-seed existence check (none → create); later calls =
    // resolving the agent's skill ref by name (found).
    prisma.skill.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: 's1' });
    const m = manifestFor(
      {
        agents: [
          { key: 'reviewer', name: 'Reviewer', skills: [{ skill: 'careful' }], toolKeys: ['mcp'] },
        ],
        scannerPatterns: [{ label: 'p1', pattern: 'x', type: 'INJECTION' }],
        skills: [{ name: 'careful', promptText: 'p' }],
        templates: [{ name: 'std', spec: RUNNABLE_SPEC }],
      } as unknown as BundleEntities,
      [{ connectionType: 'mcp' }]
    );

    const res = await installBundle(asArg(), m, { allowUnverified: true });

    expect(res.counts).toEqual({ agents: 1, scannerPatterns: 1, skills: 1, templates: 1 });
    expect(prisma.skill.create).toHaveBeenCalledTimes(1);
    expect(prisma.scannerPattern.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.agent.create).toHaveBeenCalledTimes(1);
    expect(prisma.agentSkillRef.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.agentSkillRef.create).toHaveBeenCalledTimes(1);
    expect(prisma.workflowTemplate.create).toHaveBeenCalledTimes(1);
    expect(prisma.workflowTemplateVersion.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.installedBundle.upsert).toHaveBeenCalledTimes(1);
  });

  it('marks a bundle VERIFIED when signed by a trusted key, UNVERIFIED otherwise', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const pubPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

    const signed = manifestFor({ ...EMPTY });
    signed.metadata.signature = signContentHash(privPem, signed.metadata.contentHash);
    const verified = await installBundle(asArg(), signed, {
      trustedKeys: [{ id: 'first-party', publicKeyPem: pubPem }],
    });
    expect(verified.trustState).toBe('VERIFIED');
    expect(verified.signedBy).toBe('first-party');
    expect(prisma.installedBundle.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ trustState: 'VERIFIED' }) })
    );

    const unsigned = await installBundle(asArg(), manifestFor({ ...EMPTY }), {
      allowUnverified: true,
      trustedKeys: [],
    });
    expect(unsigned.trustState).toBe('UNVERIFIED');
    expect(unsigned.signedBy).toBeNull();
  });

  it('refuses to install a signed bundle that was relabelled or version-bumped', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const trustedKeys = [
      {
        id: 'first-party',
        publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      },
    ];

    const honest = manifestFor({ ...EMPTY }, [], { name: 'vendor-pack', version: '1.0.0' });
    honest.metadata.signature = signContentHash(privPem, honest.metadata.contentHash);
    honest.metadata.signedBy = 'first-party';
    await expect(installBundle(asArg(), honest, { trustedKeys })).resolves.toMatchObject({
      trustState: 'VERIFIED',
    });

    // Relabelled to shadow another bundle's registry row: the hash no longer
    // describes the manifest, so install fails outright (not merely UNVERIFIED).
    const relabelled = { ...honest, metadata: { ...honest.metadata, name: 'victim-pack' } };
    await expect(installBundle(asArg(), relabelled, { trustedKeys })).rejects.toBeInstanceOf(
      BundleIntegrityError
    );

    // Re-hashed after the edit: install proceeds, but the old signature no
    // longer covers the new identity, so it can never claim VERIFIED.
    const rehashed = manifestFor({ ...EMPTY }, [], { name: 'victim-pack', version: '1.0.0' });
    rehashed.metadata.signature = honest.metadata.signature;
    rehashed.metadata.signedBy = 'first-party';
    const res = await installBundle(asArg(), rehashed, {
      allowUnverified: true,
      trustedKeys,
    });
    expect(res.trustState).toBe('UNVERIFIED');
    expect(res.signedBy).toBeNull();

    // Same content replayed under a bumped version is likewise not VERIFIED.
    const bumped = manifestFor({ ...EMPTY }, [], { name: 'vendor-pack', version: '2.0.0' });
    bumped.metadata.signature = honest.metadata.signature;
    await expect(
      installBundle(asArg(), bumped, { allowUnverified: true, trustedKeys })
    ).resolves.toMatchObject({
      trustState: 'UNVERIFIED',
    });
  });

  it('rejects a bundle built under the old (v1) trust format', async () => {
    const legacy = { ...manifestFor({ ...EMPTY }), bundleSchemaVersion: 1 };
    // Must come back wrapped as BundleIntegrityError specifically (not just any
    // rejection with a matching message) — the route only maps
    // BundleIntegrityError/BundleDependencyError/ZodError to a 400; an unwrapped
    // BundleSchemaVersionError would fall through to a generic 500.
    await expect(installBundle(asArg(), legacy)).rejects.toBeInstanceOf(BundleIntegrityError);
    await expect(installBundle(asArg(), legacy)).rejects.toThrow(/unsupported bundleSchemaVersion/);
    expect(prisma.installedBundle.upsert).not.toHaveBeenCalled();
  });

  it('rejects an uncompilable scanner pattern before any write, even unsigned', async () => {
    const m = manifestFor({
      ...EMPTY,
      scannerPatterns: [{ flags: 'i', label: 'broken', pattern: '(unclosed', type: 'INJECTION' }],
    } as unknown as BundleEntities);
    await expect(installBundle(asArg(), m)).rejects.toBeInstanceOf(BundleIntegrityError);
    await expect(installBundle(asArg(), m)).rejects.toThrow(/INVALID_REGEX/);
    expect(prisma.scannerPattern.upsert).not.toHaveBeenCalled();
    expect(prisma.installedBundle.upsert).not.toHaveBeenCalled();
  });

  it('rejects a template whose spec does not parse, before any write', async () => {
    const m = manifestFor({
      ...EMPTY,
      templates: [{ name: 'broken', spec: { entry: 'a', nodes: {} } }],
    } as unknown as BundleEntities);
    await expect(installBundle(asArg(), m, { allowUnverified: true })).rejects.toThrow();
    expect(prisma.workflowTemplate.create).not.toHaveBeenCalled();
    expect(prisma.installedBundle.upsert).not.toHaveBeenCalled();
  });

  it('rejects a template that parses but cannot run (no reachable terminate), before any write', async () => {
    const m = manifestFor({
      ...EMPTY,
      templates: [
        {
          name: 'loop',
          spec: {
            ...RUNNABLE_SPEC,
            entry: 'c',
            nodes: { c: { expr: 'true', onFalse: 'c', onTrue: 'c', type: 'cond' } },
          },
        },
      ],
    } as unknown as BundleEntities);
    await expect(installBundle(asArg(), m, { allowUnverified: true })).rejects.toBeInstanceOf(
      BundleIntegrityError
    );
    await expect(installBundle(asArg(), m, { allowUnverified: true })).rejects.toThrow(
      /NO_TERMINAL/
    );
    expect(prisma.workflowTemplate.create).not.toHaveBeenCalled();
    expect(prisma.workflowTemplateVersion.upsert).not.toHaveBeenCalled();
    expect(prisma.installedBundle.upsert).not.toHaveBeenCalled();
  });

  it('rejects a template whose inputSchema is not an object schema', async () => {
    const m = manifestFor({
      ...EMPTY,
      templates: [{ inputSchema: { type: 'string' }, name: 'std', spec: RUNNABLE_SPEC }],
    } as unknown as BundleEntities);
    await expect(installBundle(asArg(), m, { allowUnverified: true })).rejects.toThrow(
      /inputSchema/
    );
    expect(prisma.installedBundle.upsert).not.toHaveBeenCalled();
  });

  it('installs a catastrophic scanner pattern — bounding it is a run-time job', async () => {
    // Bundle validation is pure and synchronous by contract, so it makes no
    // execution-cost claim. A pattern like this installs, and every scanner then
    // runs it under a wall-clock budget that terminates and quarantines it. The
    // honest posture is documented in AGENTS.md §6.
    const m = manifestFor({
      ...EMPTY,
      scannerPatterns: [{ flags: 'i', label: 'redos', pattern: '(a+)+$', type: 'INJECTION' }],
    } as unknown as BundleEntities);
    await expect(installBundle(asArg(), m, { allowUnverified: true })).resolves.toBeDefined();
    expect(prisma.scannerPattern.upsert).toHaveBeenCalled();
  });

  it('still installs an ordinary scanner pattern', async () => {
    const m = manifestFor({
      ...EMPTY,
      scannerPatterns: [
        { flags: 'i', label: 'ok', pattern: 'ignore\\s+previous', type: 'INJECTION' },
      ],
    } as unknown as BundleEntities);
    const res = await installBundle(asArg(), m, { allowUnverified: true });
    expect(res.counts.scannerPatterns).toBe(1);
    expect(prisma.scannerPattern.upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects an UNVERIFIED bundle by default', async () => {
    await expect(installBundle(asArg(), manifestFor({ ...EMPTY }))).rejects.toBeInstanceOf(
      BundleIntegrityError
    );
  });
});
