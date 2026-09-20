/**
 * The one configuration a durable record carries, read and written strictly
 * (specs/acp-client-spec.md §Journaling and replay).
 *
 * A record says what its conversation was running under, as one member. There
 * is no requested value beside it and no observation beside that: an operation
 * that could not put the conversation under what was asked never ran, so a
 * record that names settings is a record of work that happened under them.
 *
 * ## What a released record may carry instead
 *
 * Two members predate this one on a launch preparation, and neither means what
 * this one means. `model` was written on every launch as observational
 * evidence — the model the provider happened to be using, which nobody chose —
 * and `requestedModel` could have been persisted by a provider whose
 * preparation core then rejected. Reading either as a configuration would
 * change what that history says and would make a replay apply settings nobody
 * asked for.
 *
 * So they are read and dropped: validated, because a member that does not read
 * back means the record is not the record it claims to be, and then discarded.
 * Neither is ever written again, and a record carrying one *beside* a canonical
 * configuration is ambiguous about which account is current — which is a
 * refusal rather than a precedence rule.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";
import type { SessionConfiguration } from "./agent-api.ts";
import type { Json } from "../types.ts";

/** The member a record carries, and the only one this build writes. */
export const CONFIGURATION_MEMBER = "configuration";

/** Members a released launch preparation may carry, and this build never does. */
export const WITHDRAWN_MEMBERS: readonly string[] = ["model", "requestedModel"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An exact provider id: a non-empty string, or nothing that is one. */
function choice(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Why a record's configuration does not read back. */
class ConfigurationUnreadable extends Error {
  override name = "ConfigurationUnreadable";
}

function unreadable(why: string): Result<SessionConfiguration | undefined> {
  return Err(new ConfigurationUnreadable(why));
}

/**
 * Read the configuration one durable record carries.
 *
 * Exact members: at least one of `model` and `effort`, nothing else, and every
 * present value a non-empty string. An empty object is refused rather than read
 * as an unconfigured operation, because an operation that asked for nothing
 * retains no member at all — and the two are different histories.
 */
export function readConfiguration(
  record: Record<string, unknown>,
): Result<SessionConfiguration | undefined> {
  const carried = record[CONFIGURATION_MEMBER];
  const withdrawn = WITHDRAWN_MEMBERS.filter((member) => record[member] !== undefined);
  for (const member of withdrawn) {
    // Validated and dropped. A malformed one is not a member this build may
    // read past: the record is describing something it cannot state.
    if (choice(record[member]) === undefined) {
      return unreadable(`the released "${member}" member does not name a choice`);
    }
  }
  if (carried === undefined) {
    return Ok(undefined);
  }
  if (withdrawn.length > 0) {
    // Two accounts of what this conversation ran under, and nothing here can
    // say which one the run acted on.
    return unreadable(
      `this record carries both a configuration and the released "${withdrawn[0]}" member`,
    );
  }
  if (!isRecord(carried)) {
    return unreadable("this record's configuration is not a set of settings");
  }
  const { model, effort, ...rest } = carried;
  if (Object.keys(rest).length > 0) {
    return unreadable("this record's configuration carries a member this build cannot read");
  }
  const configuration: { model?: string; effort?: string } = {};
  if (model !== undefined) {
    const parsed = choice(model);
    if (parsed === undefined) {
      return unreadable("this record's configuration names no model");
    }
    configuration.model = parsed;
  }
  if (effort !== undefined) {
    const parsed = choice(effort);
    if (parsed === undefined) {
      return unreadable("this record's configuration names no effort level");
    }
    configuration.effort = parsed;
  }
  if (configuration.model === undefined && configuration.effort === undefined) {
    return unreadable("this record's configuration names nothing at all");
  }
  return Ok(configuration);
}

/** The member as a record writes it, or nothing for an unconfigured one. */
export function serializeConfiguration(
  configuration: SessionConfiguration | undefined,
): Record<string, Json> {
  if (configuration === undefined) {
    return {};
  }
  return {
    [CONFIGURATION_MEMBER]: {
      ...(configuration.model === undefined ? {} : { model: configuration.model }),
      ...(configuration.effort === undefined ? {} : { effort: configuration.effort }),
    },
  };
}
