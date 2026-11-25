/**
 * Shapes of `/api/v1/platform/marketplaces` (gateway, web and CLI share them). Dates are ISO strings.
 * Everything that comes from a repository is display-safe text (control and invisible characters
 * replaced) or a value this module validated; error strings are fixed sentences.
 */

export type MarketplaceSourceStatus = 'OK' | 'UPDATE_AVAILABLE' | 'ERROR' | 'DISABLED';

/** Where a marketplace lives. */
export interface MarketplaceLocation {
  host: string;
  owner: string;
  repo: string;
  /** Folder holding `.claude-plugin/marketplace.json`; empty for the repository root. */
  path: string;
  ref: string;
}

/** Where one catalog entry's plugin lives. */
export type EntrySource =
  /** A folder inside the marketplace repository, at the marketplace's own commit. */
  | { kind: 'relative'; path: string }
  /** A GitHub repository on `host` (the marketplace's own unless the entry names another); `sha` is null when the entry names none. */
  | {
      kind: 'github';
      host: string;
      owner: string;
      repo: string;
      ref: string;
      sha: string | null;
      path: string;
    }
  /** Anything else (git URL, npm, another host): listed, never installable. */
  | { kind: 'unsupported'; type: string };

export interface MarketplaceEntry {
  /** Null when the entry has no valid name; such an entry is never installable. */
  name: string | null;
  description: string | null;
  version: string | null;
  source: EntrySource | null;
  /** `false` when the entry says `strict: false`: it stands in for the plugin's own `plugin.json`. */
  strict: boolean;
  /**
   * The `plugin.json` a `strict: false` entry stands for (name, description, version, metadata and
   * the component fields it carries); null for a strict entry. Not part of the admin API's catalog.
   */
  pluginManifest: Record<string, unknown> | null;
  installable: boolean;
  /** A fixed sentence; null when installable. */
  reason: string | null;
  /** Keys of the entry this version reads nothing from. */
  ignoredKeys: string[];
}

export interface ParsedMarketplace {
  name: string;
  ownerName: string | null;
  /** Top-level keys this version reads nothing from. */
  ignoredKeys: string[];
  entries: MarketplaceEntry[];
}

/** One catalog entry as the admin API returns it. */
export interface CatalogEntryDto extends Omit<MarketplaceEntry, 'pluginManifest'> {
  /** The profile approved from this entry of this marketplace, if any. */
  profile: { name: string; status: string; latestVersion: number } | null;
  /** A profile with this entry's name exists that did not come from this entry. */
  nameTaken: boolean;
}

export interface MarketplaceCatalogDto {
  name: string;
  ownerName: string | null;
  ignoredKeys: string[];
  entries: CatalogEntryDto[];
}

export interface MarketplaceSourceDto {
  id: string;
  host: string;
  owner: string;
  repo: string;
  path: string;
  ref: string;
  pinnedSha: string;
  latestSha: string | null;
  lastCheckedAt: string | null;
  /** A fixed server-side string, never repository text. */
  lastError: string | null;
  status: MarketplaceSourceStatus;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  /** Profiles approved from this marketplace. */
  profileCount: number;
}

export interface MarketplaceDetailDto extends MarketplaceSourceDto {
  /** The catalog read at `pinnedSha`; null when it could not be read (see `catalogError`). */
  catalog: MarketplaceCatalogDto | null;
  catalogError: string | null;
}

/** An MCP server a plugin's `.mcp.json` declares. */
export interface PluginMcpServer {
  /** Display-safe. */
  name: string;
  transport: 'http' | 'stdio' | 'sse';
  /** Origin and path only (no credentials, query or fragment); http servers only. */
  url: string | null;
  /** True for an http server. The harness does not load it either way. */
  supported: boolean;
  /**
   * Set by the parser when another server of the same file has the same name after the display
   * sanitising (truncation, hidden characters); every server of such a group carries it.
   */
  ambiguous?: boolean;
}
