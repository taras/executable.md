/**
 * What a provider says it is constructing a session under.
 *
 * Values, not a fingerprint. A conversation reopened a week later has to be
 * continued under the configuration it was created with, and a digest can only
 * say that two things differ — it cannot say what differs, and it cannot be
 * read back by anything that wants to know what a session actually holds.
 *
 * It describes what construction will attempt. It asserts nothing about what
 * the backend accepted, what an adapter applied, or what the provider's own
 * defaults are: a member this provider did not state is not an empty set, and
 * there is no value here standing for "whatever the agent does by default".
 * Native identity is established by the canonical assertion a turn records, and
 * nothing here can manufacture one.
 *
 * Core holds it as JSON. The provider validates and normalizes its own
 * construction inputs — MCP connection shapes and permission spellings are its
 * vocabulary, not Core's — and Core keeps exactly what it was handed, detached
 * and frozen, so the container the provider still owns cannot change what was
 * admitted.
 */

import type { Json, JsonObject } from "../types.ts";
import { parseJson } from "../json.ts";
import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";

/** Active provider configuration saved for session creation and continuation. */
export interface ProviderSessionConfiguration {
  /** The configured coding-agent tools. An empty array means none. */
  readonly providerTools: readonly string[];
  /** MCP server connection configurations. An empty array means none. */
  readonly mcpServers: readonly JsonObject[];
  /** The provider's permission configuration for this session. */
  readonly permissions: JsonObject;
  /** System-prompt replacement or addition; null keeps the provider's default. */
  readonly systemPrompt: string | { readonly append: string } | null;
}

/**
 * What a retained conversation requires before its provider does any work.
 *
 * Bound to one issuance by the conversation that opened it, and reached only
 * through the setup the coordinator delivers. An ordinary issuance carries
 * none, which is what makes the requirement a property of the conversation
 * rather than a flag anything routing a request could read or set.
 */
export type AdmitProviderConfiguration = (
  provider: string,
  agentCommand: string,
  configuration: ProviderSessionConfiguration | undefined,
) => Operation<Result<void>>;

/**
 * Why one configuration is not a statement of what a session is built under.
 *
 * Its own class, and not exported, because nobody refuses with this: a
 * conversation answers its caller in its own terms, and a provider that cannot
 * state its own construction inputs is a different failure from a history that
 * cannot be continued. It carries the detail those refusals quote.
 */
class ProviderConfigurationUnstated extends Error {
  override name = "ProviderConfigurationUnstated";
}

/** Refuse one configuration, saying which member is not a statement. */
function unstated(why: string): Result<JsonObject> {
  return Err(new ProviderConfigurationUnstated(why));
}

/**
 * Read one configuration into frozen JSON, with every member required.
 *
 * Required all four, and absence is never a default: a configuration missing
 * its tool list would be saved as one that said nothing about tools, and the
 * reopening that compared against it would accept any tool set at all. An
 * empty list is a statement; a missing one is not.
 */
export function parseProviderConfiguration(
  configuration: ProviderSessionConfiguration | undefined,
): Result<JsonObject> {
  if (configuration === undefined || configuration === null) {
    return unstated("no active provider configuration was named");
  }
  const tools = configuration.providerTools;
  if (!Array.isArray(tools)) {
    return unstated("providerTools is not a list of the agent's own tool names");
  }
  if (tools.some((tool) => typeof tool !== "string")) {
    return unstated("providerTools holds something that is not a tool name");
  }
  const servers = configuration.mcpServers;
  if (!Array.isArray(servers)) {
    return unstated("mcpServers is not a list of connection configurations");
  }
  const permissions = configuration.permissions;
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return unstated("permissions is not a permission configuration");
  }
  const prompt = configuration.systemPrompt;
  if (!statedPrompt(prompt)) {
    return unstated(
      "systemPrompt is neither a replacement, an addition nor null — and null is what says " +
        "the provider's own prompt stands",
    );
  }
  // Parsed as one value, so a non-JSON member anywhere inside a connection
  // configuration or a permission setting is refused here rather than at the
  // append that would have had to serialize it.
  try {
    const parsed = parseJson({
      providerTools: [...tools],
      mcpServers: [...servers],
      permissions,
      systemPrompt: prompt,
    });
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return unstated("this active provider configuration is not a JSON object");
    }
    freezeJson(parsed);
    return Ok(parsed);
  } catch (error) {
    return unstated(
      `this active provider configuration is not JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Whether `value` is a stated system prompt: a replacement, an addition, or none. */
function statedPrompt(value: unknown): boolean {
  if (value === null || typeof value === "string") {
    return true;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const append = Reflect.get(value, "append");
  return typeof append === "string";
}

/**
 * Whether two saved configurations say the same thing.
 *
 * JSON values, not object identity and not member order: the provider builds
 * this record from its own inputs each time it constructs, so two runs that
 * stated the same configuration must compare equal however their objects were
 * assembled. Array order is kept, because the provider normalized it and a
 * reordered tool or server list is a different list to whoever reads it.
 */
export function sameJson(left: Json, right: Json): boolean {
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((member, index) => sameJson(member, right[index] ?? null))
    );
  }
  if (Array.isArray(right)) {
    return false;
  }
  if (left === null || right === null) {
    return left === right;
  }
  if (typeof left === "object") {
    if (typeof right !== "object") {
      return false;
    }
    const keys = Object.keys(left).sort();
    const others = Object.keys(right).sort();
    return (
      keys.length === others.length &&
      keys.every((key, index) => key === others[index]) &&
      keys.every((key) => sameJson(left[key] ?? null, right[key] ?? null))
    );
  }
  return left === right;
}

/**
 * Freeze one parsed value and everything inside it.
 *
 * `parseJson` already copied it out of whatever the provider holds, so this
 * seals the copy rather than somebody else's data. Both halves matter: the copy
 * is why the provider's own container can keep changing, and the freeze is why
 * nothing that is later handed this value can change what was admitted.
 *
 * In place, because the value is already this module's own copy: returning a
 * second one would leave the unfrozen first one reachable by whoever built it.
 */
export function freezeJson(value: Json): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const member of Array.isArray(value) ? value : Object.values(value)) {
    freezeJson(member);
  }
  Object.freeze(value);
}
