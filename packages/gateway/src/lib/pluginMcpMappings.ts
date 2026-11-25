import type { PrismaClient } from '@auto-swe/shared';
import { declaredPluginMcpServers, unpackFiles } from '@auto-swe/shared/lib/harnessProfile';
import type { PluginMcpMappingDto, PluginMcpServerDto } from '@auto-swe/shared/types/api';

/** A declared server the profile's latest version no longer (or never) names, or that is mapped. */
export type PluginMcpMappingView = PluginMcpMappingDto & { declared: boolean; supported: boolean };

export interface DeclaredMcp {
  servers: PluginMcpServerDto[];
  unreadable: Array<{ plugin: string; file: string; reason: string }>;
}

/**
 * The MCP servers the plugins of a stored snapshot declare. Never throws: a snapshot that cannot be
 * unpacked reads as declaring nothing.
 */
export function declaredFromSnapshot(
  files: unknown,
  manifest: unknown
): { declared: DeclaredMcp; readable: boolean } {
  try {
    const out = declaredPluginMcpServers(
      unpackFiles(files as never),
      (manifest ?? {}) as { plugins?: string[] }
    );
    return {
      declared: {
        servers: out.servers.map((s) => ({
          duplicate: s.duplicate,
          name: s.name,
          plugin: s.plugin,
          supported: s.supported,
          transport: s.transport,
          url: s.url ?? null,
        })),
        unreadable: out.unreadable.map((u) => ({
          file: u.file,
          plugin: u.plugin,
          reason: u.reason,
        })),
      },
      readable: true,
    };
  } catch {
    return { declared: { servers: [], unreadable: [] }, readable: false };
  }
}

type MappingRow = {
  serverName: string;
  connectionId: string;
  updatedAt: Date;
  connection: { name: string | null } | null;
  mappedBy: { name: string | null; email: string } | null;
};

export const MAPPING_SELECT = {
  connection: { select: { name: true } },
  connectionId: true,
  mappedBy: { select: { email: true, name: true } },
  serverName: true,
  updatedAt: true,
} as const;

export function mappingDto(row: MappingRow): PluginMcpMappingDto {
  return {
    connectionId: row.connectionId,
    connectionName: row.connection?.name ?? null,
    mappedAt: row.updatedAt.toISOString(),
    mappedBy: row.mappedBy ? (row.mappedBy.name ?? row.mappedBy.email) : null,
    serverName: row.serverName,
  };
}

/** What `GET /:name` adds: the latest version's declared servers and every stored mapping. */
export async function pluginMcpDetail(
  prisma: PrismaClient,
  profileId: string,
  latest: { files: unknown; manifest: unknown } | null
): Promise<{
  mcpServers: PluginMcpServerDto[];
  mcpUnreadable: DeclaredMcp['unreadable'];
  mcpMappings: PluginMcpMappingView[];
}> {
  const { declared } = latest
    ? declaredFromSnapshot(latest.files, latest.manifest)
    : { declared: { servers: [], unreadable: [] } as DeclaredMcp };
  const rows = await prisma.pluginMcpMapping.findMany({
    orderBy: { serverName: 'asc' },
    select: MAPPING_SELECT,
    where: { profileId },
  });
  const byName = new Map(declared.servers.map((s) => [s.name, s]));
  return {
    mcpMappings: rows.map((r) => {
      const s = byName.get(r.serverName);
      return { ...mappingDto(r), declared: s !== undefined, supported: s?.supported ?? false };
    }),
    mcpServers: declared.servers,
    mcpUnreadable: declared.unreadable,
  };
}
