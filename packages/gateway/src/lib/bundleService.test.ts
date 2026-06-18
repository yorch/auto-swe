import { generateKeyPairSync } from 'node:crypto';
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
  dependencies: { connectionType: string }[] = []
): BundleManifest {
  return {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    dependencies,
    entities,
    metadata: {
      contentHash: computeContentHash({ dependencies, entities }),
      createdAt: 'now',
      name: 'test',
      version: '1.0.0',
    },
  };
}

const EMPTY: BundleEntities = { agents: [], scannerPatterns: [], skills: [], templates: [] };

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
    expect(m.metadata.contentHash).toBe(
      computeContentHash({ dependencies: m.dependencies, entities: m.entities })
    );
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
        templates: [{ name: 'std', spec: { entry: 'a', nodes: {} } }],
      } as unknown as BundleEntities,
      [{ connectionType: 'mcp' }]
    );

    const res = await installBundle(asArg(), m);

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

    const unsigned = await installBundle(asArg(), manifestFor({ ...EMPTY }), { trustedKeys: [] });
    expect(unsigned.trustState).toBe('UNVERIFIED');
    expect(unsigned.signedBy).toBeNull();
  });
});
