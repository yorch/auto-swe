import type { z } from 'zod';
import type { SettingKey } from '../config/registry.js';
import type { InputSchema } from '../lib/inputSchema.js';

/**
 * What starts runs without a person pressing run. `event` automations are generic rules on a
 * repository (`Automation` rows, one per event source); the other kinds keep their own storage
 * and editors and join through the decision ledger (`AutomationFire`) and the shared listing.
 */
export const AUTOMATION_KINDS = [
  'event',
  'schedule',
  'template_webhook',
  'tracker_transition',
] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

/** What an event automation decided about one occurrence. */
export const AUTOMATION_OUTCOMES = [
  'STARTED',
  'SUPPRESSED_OWN_OUTPUT',
  'SUPPRESSED_SAME_SUBJECT',
  'SUPPRESSED_COOLDOWN',
  'SUPPRESSED_IN_FLIGHT',
  'SUPPRESSED_DAILY_CAP',
  'SUPPRESSED_PRECONDITION',
  'SUPPRESSED_BUDGET',
  'FAILED_TO_START',
] as const;
export type AutomationOutcome = (typeof AUTOMATION_OUTCOMES)[number];

/** A field of an event source's filters, as the form renders it. */
export type FilterField =
  | {
      key: string;
      label: string;
      hint?: string;
      /** Pick one or more of fixed values; the stored value is the list of picked values. */
      kind: 'choices';
      options: { value: string; label: string }[];
    }
  | {
      key: string;
      label: string;
      hint?: string;
      /** A comma-separated list of glob patterns (`*`, `**`, `!exclude`). */
      kind: 'globs';
    }
  | {
      key: string;
      label: string;
      hint?: string;
      /** A comma-separated list of plain values. */
      kind: 'list';
    };

/** An option value that is refused at save unless its conditions hold. */
export interface GatedOption {
  key: string;
  values: readonly unknown[];
  /** Only with the source's default template (no template of the automation's own). */
  defaultTemplateOnly: boolean;
  /** A boolean setting, resolved for the repository's team, that must be on. */
  setting: SettingKey;
  /** What the refusal says when the setting is off. */
  disabledMessage: string;
}

/** One input of the "would this fire?" tester. */
export interface TesterField {
  key: string;
  label: string;
  /** A starting value, so the tester answers something before anyone types. */
  initial: string;
  options?: { value: string; label: string }[];
}

/**
 * The keys a decision is made on, derived from an occurrence:
 * - `subject`: what one run is enough for (a commit, an issue). A second occurrence on a
 *   subject that already has a started run is suppressed.
 * - `scope`: what cooldown and in-flight are counted over (a branch, an issue).
 */
export interface DecisionKeys {
  subject: string;
  scope: string;
}

/** What an occurrence contributes to the run it starts. */
export interface OccurrenceRun {
  /** The run's ticket id: a synthetic one names the occurrence. */
  ticketId: string;
  ticketIsSynthetic: boolean;
  description: string;
  /** Payload fields the occurrence fills; they always win over the automation's inputs. */
  fields: Record<string, unknown>;
}

/**
 * An event source: one kind of thing that happens on a repository and can start a run. The
 * descriptor is pure and shared, so the gateway decides with it, the form renders from it and
 * the tester answers with the same `mismatch` the webhook path uses.
 */
export interface EventSource<Filters = unknown, Facts = unknown> {
  /** Stored on the automation: `<host>.<event>.<action>`. */
  key: string;
  /** "When CI fails". */
  label: string;
  /** One sentence for the picker. */
  summary: string;
  filters: z.ZodType<Filters>;
  /**
   * The occurrence as the ledger stores it (`facts`), so a recorded decision can be taken again
   * from the ledger alone. A row that does not parse cannot be retried.
   */
  facts: z.ZodType<Facts>;
  defaultFilters: Filters;
  filterFields: FilterField[];
  /** The filters in a few words, for lists. */
  describe(filters: Filters): string;
  /**
   * What a run of the source's default template will do with these options (anything absent at
   * its default), in a few words for lists. Empty when the source has nothing to say.
   */
  describeInputs?(values: Record<string, unknown>): string;
  /** One occurrence as recorded in the ledger (`facts`), in a line for the history. */
  describeOccurrence(facts: Record<string, unknown>): string;
  /** Why the filters do not select this occurrence, or null when they do. */
  mismatch(filters: Filters, facts: Facts): string | null;
  tester: { fields: TesterField[]; facts(values: Record<string, string>): Facts };
  /** Payload keys the occurrence fills; an automation's inputs may never set them. */
  eventInputKeys: readonly string[];
  run(facts: Facts): OccurrenceRun;
  keys(facts: Facts): DecisionKeys;
  /**
   * The occurrence's identity on its repository (`repoKey` is `<host>/<owner>/<repo>`,
   * lowercased): a redelivery, or a second automation or repository row matching the same
   * occurrence, has the same key and is decided once.
   */
  dedupeKey(repoKey: string, facts: Facts): string;
  /** The run's workflow id is `<prefix>-<automation8>-<part>`. */
  workflowId: { prefix: string; part(facts: Facts): string };
  /** Why the occurrence is never acted on at all — answered before any query, not recorded. */
  ignore?(facts: Facts, ctx: { branchPrefix: string }): string | null;
  /**
   * Why a matched occurrence cannot start a run, recorded as `SUPPRESSED_PRECONDITION`
   * (a pull-request failure with no pull request).
   */
  precondition?(facts: Facts): string | null;
  /** How far back a started run still counts as possibly in flight: longer than one can run. */
  inFlightLookbackMs: number;
  /**
   * Occurrences the filters could select, for checking an automation's options at save time
   * in every shape a real one can take.
   */
  samples(filters: Filters): Facts[];
  /** The payload contract the source's runs are parsed with, beyond the template's schema. */
  contract?: z.ZodType;
  /** Whether a template's declared input schema can take this source's runs. */
  templateCompatible(schema: InputSchema): boolean;
  /** The template an automation with no template starts. */
  defaultTemplate: { name: string };
  /** Per-team / -organization switch that stops every automation of this source. */
  killSwitch: SettingKey;
  /**
   * Option values an automation may only save under conditions: with the source's default
   * template, and where a setting allows it. A save-time early error; the run decides again.
   */
  gatedOptions?: GatedOption[];
}
