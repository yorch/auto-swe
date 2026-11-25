'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import {
  type HarnessProfileDetailWithSources,
  type PluginMcpMappingRow,
  type PluginMcpServerDecl,
  useRemoveMcpMapping,
  useSetMcpMapping,
} from '@/hooks/useHarnessProfiles';
import { useMcpConnections } from '@/hooks/useMcpConnections';
import { ApiError } from '@/lib/api';
import { visibleText } from '@/lib/visibleText';
import { keyed } from './profileDisplay';

const ERROR_TEXT: Record<string, string> = {
  HARNESS_PROFILE_DISABLED: 'This plugin is disabled. Re-enable it before changing MCP mappings.',
  MCP_CONNECTION_INVALID:
    'That connection cannot be used: it is inactive, unavailable or not an mcp connection. Pick another.',
  MCP_SERVER_AMBIGUOUS:
    'More than one plugin of this profile declares that server name, so it cannot be mapped.',
  MCP_SERVER_NOT_DECLARED: 'The latest version of this plugin does not declare that server.',
  MCP_SERVER_UNSUPPORTED: 'Only http MCP servers can be mapped. This server cannot be loaded.',
};

/** A specific message per refusal code; any other failure gets a generic one. */
export function describeMcpMappingError(err: unknown): string {
  if (err instanceof ApiError && err.code && ERROR_TEXT[err.code]) {
    return ERROR_TEXT[err.code] as string;
  }
  return 'Failed to change the MCP mapping. Try again.';
}

interface Row {
  key: string;
  server: PluginMcpServerDecl;
}

function ServerRow({
  profileName,
  server,
  mapping,
  disabled,
  connections,
}: {
  profileName: string;
  server: PluginMcpServerDecl;
  mapping: PluginMcpMappingRow | undefined;
  disabled: boolean;
  connections: { value: string; label: string }[];
}) {
  const set = useSetMcpMapping();
  const remove = useRemoveMcpMapping();
  const [choice, setChoice] = useState('');
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = visibleText(server.name);
  const pending = set.isPending || remove.isPending;
  const blocked = server.duplicate ? 'ambiguous' : server.supported ? null : 'unsupported';

  async function save() {
    setError(null);
    try {
      await set.mutateAsync({ connectionId: choice, name: profileName, serverName: server.name });
      setChoice('');
      setChanging(false);
    } catch (err) {
      setError(describeMcpMappingError(err));
    }
  }

  async function drop() {
    setError(null);
    try {
      await remove.mutateAsync({ name: profileName, serverName: server.name });
    } catch (err) {
      setError(describeMcpMappingError(err));
    }
  }

  const picker = (
    <div className="flex flex-wrap items-end gap-2">
      <Select
        aria-label={`Connection for ${label}`}
        compact
        disabled={disabled || pending}
        onChange={setChoice}
        options={connections}
        placeholder="Choose a connection"
        value={choice}
      />
      <Button
        disabled={disabled || pending || choice === ''}
        onClick={save}
        size="sm"
        variant="primary"
      >
        {set.isPending ? 'Saving…' : 'Map'}
      </Button>
      {changing && (
        <Button
          disabled={pending}
          onClick={() => {
            setChanging(false);
            setChoice('');
          }}
          size="sm"
        >
          Cancel
        </Button>
      )}
    </div>
  );

  return (
    <li className="space-y-1.5 rounded-md border border-ink-600 p-3" data-testid="mcp-server">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-paper-200">{label}</span>
        <Badge tone="neutral" variant="outline">
          {server.transport}
        </Badge>
        <span className="text-xs text-paper-500">from {visibleText(server.plugin)}</span>
        {server.url && (
          <span className="font-mono text-xs text-paper-400 break-all">
            {visibleText(server.url)}
          </span>
        )}
      </div>
      {blocked === 'unsupported' && (
        <p className="text-xs text-paper-400">
          Not loadable: only http servers can be relayed, so a {server.transport} server cannot be
          mapped.
        </p>
      )}
      {blocked === 'ambiguous' && (
        <p className="text-xs text-warning-400">
          More than one plugin of this profile declares a server named {label}, so it is ambiguous
          and cannot be mapped.
        </p>
      )}
      {blocked === null && mapping && !changing && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge dot tone="success">
            Mapped
          </Badge>
          <span className="text-sm text-paper-200">
            {mapping.connectionName ? visibleText(mapping.connectionName) : 'Unnamed connection'}
          </span>
          <Button disabled={disabled || pending} onClick={() => setChanging(true)} size="sm">
            Change
          </Button>
          <Button
            aria-label={`Remove mapping for ${label}`}
            disabled={disabled || pending}
            onClick={drop}
            size="sm"
          >
            Remove
          </Button>
        </div>
      )}
      {blocked === null && mapping && changing && picker}
      {blocked === null && !mapping && (
        <div className="space-y-1">
          <Badge dot tone="muted">
            Not mapped
          </Badge>
          {picker}
        </div>
      )}
      {error && <Alert variant="error">{error}</Alert>}
    </li>
  );
}

function OrphanRow({
  profileName,
  mapping,
  disabled,
}: {
  profileName: string;
  mapping: PluginMcpMappingRow;
  disabled: boolean;
}) {
  const remove = useRemoveMcpMapping();
  const [error, setError] = useState<string | null>(null);
  const label = visibleText(mapping.serverName);
  return (
    <li className="space-y-1 rounded-md border border-ink-600 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-paper-200">{label}</span>
        <span className="text-sm text-paper-300">
          {mapping.connectionName ? visibleText(mapping.connectionName) : 'Unnamed connection'}
        </span>
        <Button
          aria-label={`Remove mapping for ${label}`}
          disabled={disabled || remove.isPending}
          onClick={async () => {
            setError(null);
            try {
              await remove.mutateAsync({ name: profileName, serverName: mapping.serverName });
            } catch (err) {
              setError(describeMcpMappingError(err));
            }
          }}
          size="sm"
        >
          Remove
        </Button>
      </div>
      {error && <Alert variant="error">{error}</Alert>}
    </li>
  );
}

/**
 * The MCP servers a plugin's latest version declares and which `mcp` Connection (if any) an admin
 * mapped each to. The harness never loads the plugin's own `.mcp.json`; only a mapped connection is
 * relayed, so every mapped server keeps that connection's allowlist and result screening.
 */
export function McpMappings({ profile }: { profile: HarnessProfileDetailWithSources }) {
  const connections = useMcpConnections();
  const servers = profile.mcpServers ?? [];
  const unreadable = profile.mcpUnreadable ?? [];
  const mappings = profile.mcpMappings ?? [];
  const disabled = profile.status === 'DISABLED';
  const options = (connections.data ?? []).map((c) => ({
    label: visibleText(c.name ?? 'Unnamed server'),
    value: c.id,
  }));
  const byName = new Map(mappings.map((m) => [m.serverName, m]));
  const orphans = mappings.filter((m) => !m.declared);
  const rows: Row[] = keyed(servers.map((s) => `${s.plugin}/${s.name}`)).map((k, i) => ({
    key: k.key,
    server: servers[i] as PluginMcpServerDecl,
  }));
  const unreadableKeys = keyed(unreadable.map((u) => `${u.plugin}/${u.file}`));

  return (
    <section aria-label="MCP servers" className="space-y-3">
      <h3 className="text-sm font-semibold text-paper-100">MCP servers</h3>
      <p className="text-xs text-paper-500">
        The harness never loads a plugin’s <code>.mcp.json</code>. The platform relays only the
        connections you map here, with each connection’s own tool allowlist and result screening, to
        agents bound to this plugin on claude-code.
      </p>
      {disabled && (
        <Alert announce={false} variant="warning">
          This plugin is disabled, so its MCP mappings cannot be changed. Re-enable it first.
        </Alert>
      )}
      {connections.isError && <Alert>Failed to load the MCP connections.</Alert>}
      {servers.length === 0 && unreadable.length === 0 && orphans.length === 0 && (
        <p className="text-xs text-paper-500">The latest version declares no MCP servers.</p>
      )}
      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((r) => (
            <ServerRow
              connections={options}
              disabled={disabled}
              key={r.key}
              mapping={r.server.duplicate ? undefined : byName.get(r.server.name)}
              profileName={profile.name}
              server={r.server}
            />
          ))}
        </ul>
      )}
      {unreadable.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-paper-300">Declarations not loaded</h4>
          <ul className="space-y-1">
            {unreadable.map((u, i) => (
              <li className="text-xs text-warning-400" key={unreadableKeys[i]?.key}>
                <span className="font-mono">
                  {visibleText(u.plugin)}/{visibleText(u.file)}
                </span>{' '}
                could not be read and is not loaded: {visibleText(u.reason)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {orphans.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-paper-300">
            No longer declared by the latest version
          </h4>
          <ul className="space-y-2">
            {orphans.map((m) => (
              <OrphanRow
                disabled={disabled}
                key={m.serverName}
                mapping={m}
                profileName={profile.name}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
