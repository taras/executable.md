/**
 * Reading and applying one conversation's model and effort
 * (specs/acp-client-spec.md §Session configuration).
 *
 * ACP advertises configuration as `configOptions` on a session's status: a list
 * of selectors, each with an id, a name, a current value and either a flat list
 * of values or a list of groups (`SessionConfigOption` in
 * `@agentclientprotocol/sdk`). None of that vocabulary leaves this package. What
 * crosses into core is `AgentOptionSet` — exact ids, display names, optional
 * descriptions, and the group each value was filed under — in the order the
 * provider gave them.
 *
 * Two selectors are recognized and no others. Category is the preferred signal
 * because ACP says a category is a presentation hint rather than a correctness
 * requirement, so an agent that files its model selector under no category is
 * still recognized by the exact id `model`. `model_config`, booleans, unknown
 * categories and every other control are not this feature and are passed over.
 *
 * Reading is strict about the selector it recognized and incurious about the
 * rest. A recognized selector that does not read back — the wrong type, two
 * equally preferred candidates, a malformed value, a duplicate id, a current
 * value that is not one of the choices — fails the operation rather than
 * degrading to an empty list, because an empty list reads as "this agent offers
 * you nothing", which is a different answer from "this run could not tell".
 *
 * ## Applying
 *
 * Model first, then effort, because effort choices belong to a model: an agent
 * asked to change model answers with that model's levels, and validating effort
 * against the previous model's would accept a value the new one does not have.
 * So the sequence is read, validate, write model, refresh, validate effort
 * against the refreshed choices, write effort, refresh, verify — and a request
 * that omits a setting writes nothing for it.
 *
 * Once a write may have happened, any later failure restores what was there
 * before, in the same model-first order, and the original failure is what the
 * caller is told. A restoration that cannot be verified leaves a conversation
 * whose configuration nobody can state, so the session is marked unusable for
 * the rest of the run rather than being prompted under a configuration the
 * document did not ask for.
 */

import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import type { AgentOption, AgentOptionSet, SessionConfiguration } from "@executablemd/core";
import type { AcpRuntimeStatus } from "./acpx-runtime.ts";

/** One selector this run recognized, and the ACP id a write names it by. */
export interface RecognizedSelector {
  readonly optionId: string;
  readonly set: AgentOptionSet;
}

/** What one status says about the two settings XMD configures. */
export interface AgentOptionSelectors {
  readonly model: RecognizedSelector | null;
  readonly effort: RecognizedSelector | null;
}

/**
 * Why a conversation is not running under what the document asked for.
 *
 * `sessionUnusable` says the prior configuration could not be put back, which
 * is the one failure that outlives the operation: the conversation is in a
 * state nobody can state, so nothing may use it again during this run.
 */
export class AcpConfigurationError extends Error {
  override name = "AcpConfigurationError";
  sessionUnusable = false;
}

function malformed(message: string): AcpConfigurationError {
  return new AcpConfigurationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A description the provider supplied, or nothing it said about one. */
function describe(value: unknown, where: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw malformed(`${where} has a description that is not text`);
  }
  return value;
}

/** The raw selector list, as far as scanning it requires. */
function advertised(status: AcpRuntimeStatus): Record<string, unknown>[] | undefined {
  const details = status.details;
  if (!isRecord(details) || details.configOptions === undefined || details.configOptions === null) {
    return undefined;
  }
  if (!Array.isArray(details.configOptions)) {
    throw malformed("this agent advertised session configuration that is not a list of selectors");
  }
  return details.configOptions.filter(isRecord);
}

/**
 * The one selector that answers to `category`, or to `id` when nothing does.
 *
 * Two equally preferred candidates is a refusal rather than a choice: picking
 * the first would make which model a conversation runs under depend on the
 * order an agent happened to list its controls in.
 */
function candidate(
  entries: Record<string, unknown>[],
  setting: string,
  category: string,
  id: string,
): Record<string, unknown> | undefined {
  const byCategory = entries.filter((entry) => entry.category === category);
  const byId = entries.filter((entry) => entry.id === id);
  const found = byCategory.length > 0 ? byCategory : byId;
  if (found.length > 1) {
    throw malformed(
      `this agent advertised more than one ${setting} selector, so which one a session is ` +
        `configured through is not something this run can decide`,
    );
  }
  return found[0];
}

/** One value the provider offered, flattened out of its group if it had one. */
function option(
  raw: unknown,
  setting: string,
  group: { readonly id: string; readonly name: string } | null,
): AgentOption {
  if (!isRecord(raw)) {
    throw malformed(`this agent's ${setting} selector offers a choice that is not an option`);
  }
  const id = text(raw.value);
  const name = text(raw.name);
  if (id === undefined || name === undefined) {
    throw malformed(
      `this agent's ${setting} selector offers a choice with no id or no name, which names ` +
        `nothing a document could write`,
    );
  }
  return { id, name, description: describe(raw.description, `a ${setting} choice`), group };
}

/** Every value a recognized selector offers, in the provider's own order. */
function choices(raw: unknown, setting: string): AgentOption[] {
  if (!Array.isArray(raw)) {
    throw malformed(`this agent's ${setting} selector advertises no list of choices`);
  }
  const flattened: AgentOption[] = [];
  for (const member of raw) {
    if (isRecord(member) && member.group !== undefined) {
      const id = text(member.group);
      const name = text(member.name);
      if (id === undefined || name === undefined) {
        throw malformed(`this agent's ${setting} selector has a group with no id or no name`);
      }
      if (!Array.isArray(member.options)) {
        throw malformed(`this agent's ${setting} selector has a group that offers no choices`);
      }
      for (const entry of member.options) {
        flattened.push(option(entry, setting, { id, name }));
      }
      continue;
    }
    flattened.push(option(member, setting, null));
  }
  const seen = new Set<string>();
  for (const entry of flattened) {
    if (seen.has(entry.id)) {
      throw malformed(
        `this agent offers the ${setting} "${entry.id}" twice, so writing it would name two ` +
          `different choices`,
      );
    }
    seen.add(entry.id);
  }
  return flattened;
}

/** One recognized selector, read strictly. */
function recognize(
  entries: Record<string, unknown>[],
  setting: string,
  category: string,
  id: string,
): RecognizedSelector | null {
  const found = candidate(entries, setting, category, id);
  if (found === undefined) {
    return null;
  }
  const optionId = text(found.id);
  if (optionId === undefined) {
    throw malformed(`this agent advertised a ${setting} selector with no id`);
  }
  if (found.type !== "select") {
    throw malformed(
      `this agent's ${setting} selector is not a list of choices, so there is nothing to ` +
        `select from it`,
    );
  }
  const selected = text(found.currentValue);
  if (selected === undefined) {
    throw malformed(`this agent's ${setting} selector reports no current value`);
  }
  const options = choices(found.options, setting);
  if (!options.some((entry) => entry.id === selected)) {
    throw malformed(
      `this agent reports the ${setting} "${selected}" as current and does not offer it, so ` +
        `what this conversation is running under is not something it stated`,
    );
  }
  return { optionId, set: { selected, options } };
}

/**
 * What one status says about model and effort.
 *
 * Absence is `null` and says so. Everything else about a selector this run
 * recognized is read strictly, because a selector read past is a selector
 * written to by guesswork.
 */
export function readAgentOptions(status: AcpRuntimeStatus): AgentOptionSelectors {
  const entries = advertised(status);
  if (entries === undefined) {
    return { model: null, effort: null };
  }
  return {
    model: recognize(entries, "model", "model", "model"),
    effort: recognize(entries, "effort", "thought_level", "effort"),
  };
}

/** The available-ids line both prevalidation diagnostics end with. */
function available(set: AgentOptionSet): string {
  return `Available options are: ${set.options.map((entry) => entry.id).join(", ")}`;
}

export function unknownModel(agent: string, model: string, set: AgentOptionSet): string {
  return `Unknown model "${model}" for agent "${agent}".\n${available(set)}`;
}

export function invalidEffort(model: string, effort: string, set: AgentOptionSet): string {
  return `Invalid effort level "${effort}" for model "${model}".\n${available(set)}`;
}

export function modelUnavailable(agent: string): string {
  return `Model choices are unavailable for ${agent}.`;
}

export function effortUnavailable(model: string | undefined): string {
  return model === undefined
    ? "Effort choices are unavailable for the current model."
    : `Effort choices are unavailable for model "${model}".`;
}

export function restorationFailed(sessionKey: string): string {
  return (
    `Restoring the prior configuration failed. Session "${sessionKey}" may remain ` +
    `reconfigured and will not be used again during this run.`
  );
}

export function sessionUnusable(sessionKey: string): string {
  return (
    `Session "${sessionKey}" may remain reconfigured after a failed restoration and will ` +
    `not be used again during this run.`
  );
}

/**
 * The conversation being configured, as this operation reaches it.
 *
 * Reading and writing are supplied rather than taken, because the handle, the
 * runtime that made it and the queue they are used under all belong to the
 * provider. `markUnusable` is how a restoration failure outlives this
 * operation: the state it describes is the provider's, not this module's.
 */
export interface ConfigurationTarget {
  readonly agent: string;
  readonly sessionKey: string;
  readStatus(): Operation<AcpRuntimeStatus>;
  write(optionId: string, value: string): Operation<void>;
  markUnusable(): void;
}

function* read(target: ConfigurationTarget): Operation<AgentOptionSelectors> {
  return readAgentOptions(yield* target.readStatus());
}

/**
 * Put `request` into effect on this conversation, or fail.
 *
 * There is nothing to report back about what it is running under: every
 * requested value is verified to be exactly the value asked for, so an
 * operation that returns has put the conversation under the request and one
 * that could not has thrown. What comes back is the last status this operation
 * read, normalized, because an inspection needs the choices themselves.
 *
 * An empty request writes nothing and reads once, which is what makes
 * "configured with nothing" indistinguishable to the provider from a session
 * nobody configured.
 */
export function* applySessionConfiguration(
  target: ConfigurationTarget,
  request: SessionConfiguration,
): Operation<AgentOptionSelectors> {
  return yield* scoped(function* (): Operation<AgentOptionSelectors> {
    const initial = yield* read(target);
    const priorModel = initial.model?.set.selected;
    const priorEffort = initial.effort?.set.selected;
    // A started write is a write that may have landed, so this is set before
    // one is issued rather than after it answers: an adapter that applies the
    // value and then fails its response has still applied it.
    let touched = false;
    let settled = false;
    let recovered = false;

    /** Put back what was there, in the order the choices depend on. */
    function* restore(): Operation<boolean> {
      try {
        const current = yield* read(target);
        if (priorModel !== undefined && current.model !== null) {
          if (current.model.set.selected !== priorModel) {
            yield* target.write(current.model.optionId, priorModel);
          }
        }
        const refreshed = yield* read(target);
        if (priorEffort !== undefined && refreshed.effort !== null) {
          if (refreshed.effort.set.selected !== priorEffort) {
            yield* target.write(refreshed.effort.optionId, priorEffort);
          }
        }
        const verified = yield* read(target);
        const modelBack = priorModel === undefined || verified.model?.set.selected === priorModel;
        const effortBack =
          priorEffort === undefined || verified.effort?.set.selected === priorEffort;
        return modelBack && effortBack;
      } catch {
        return false;
      }
    }

    // Registered before the first write, because a cancellation runs no catch:
    // an operation halted between issuing a write and reading its answer is
    // exactly the case where the conversation is left somewhere nobody asked
    // for it to be. It also picks up a restoration the failure path below
    // started and did not finish, which is why `recovered` is set only once
    // that path has actually put the conversation somewhere.
    yield* ensure(function* () {
      if (settled || recovered || !touched) {
        return;
      }
      let restored = false;
      try {
        restored = yield* restore();
      } finally {
        // Synchronous, so a cleanup that is itself cancelled still leaves this
        // session refusing rather than silently reconfigured.
        if (!restored) {
          target.markUnusable();
        }
      }
    });

    try {
      if (request.model !== undefined) {
        if (initial.model === null) {
          throw new AcpConfigurationError(modelUnavailable(target.agent));
        }
        if (!initial.model.set.options.some((entry) => entry.id === request.model)) {
          throw new AcpConfigurationError(
            unknownModel(target.agent, request.model, initial.model.set),
          );
        }
        if (initial.model.set.selected !== request.model) {
          touched = true;
          yield* target.write(initial.model.optionId, request.model);
        }
      }

      // The refreshed answer, and the only source of effort choices for the
      // model this conversation is now on.
      const refreshed = request.model === undefined ? initial : yield* read(target);
      if (request.model !== undefined && refreshed.model?.set.selected !== request.model) {
        throw new AcpConfigurationError(
          `this agent did not apply the model "${request.model}" to session ` +
            `"${target.sessionKey}", and reports "${refreshed.model?.set.selected ?? "nothing"}"`,
        );
      }

      if (request.effort === undefined) {
        settled = true;
        return refreshed;
      }

      const model = refreshed.model?.set.selected;
      if (refreshed.effort === null) {
        throw new AcpConfigurationError(effortUnavailable(model));
      }
      if (!refreshed.effort.set.options.some((entry) => entry.id === request.effort)) {
        throw new AcpConfigurationError(
          invalidEffort(model ?? "the current model", request.effort, refreshed.effort.set),
        );
      }
      if (refreshed.effort.set.selected !== request.effort) {
        touched = true;
        yield* target.write(refreshed.effort.optionId, request.effort);
      }

      const verified = yield* read(target);
      if (verified.effort?.set.selected !== request.effort) {
        throw new AcpConfigurationError(
          `this agent did not apply the effort level "${request.effort}" to session ` +
            `"${target.sessionKey}", and reports "${verified.effort?.set.selected ?? "nothing"}"`,
        );
      }
      if (request.model !== undefined && verified.model?.set.selected !== request.model) {
        throw new AcpConfigurationError(
          `this agent stopped reporting the model "${request.model}" for session ` +
            `"${target.sessionKey}" while its effort level was applied`,
        );
      }
      settled = true;
      return verified;
    } catch (error) {
      if (!touched) {
        recovered = true;
        throw error;
      }
      // Marked handled only once restoration has settled one way or the other.
      // A cancellation delivered while this is still running leaves it unset,
      // and the cleanup above takes the conversation the rest of the way.
      const restored = yield* restore();
      recovered = true;
      if (restored) {
        throw error;
      }
      target.markUnusable();
      const original = error instanceof Error ? error : new Error(String(error));
      const refused = new AcpConfigurationError(
        `${original.message}\n${restorationFailed(target.sessionKey)}`,
        { cause: original },
      );
      refused.sessionUnusable = true;
      throw refused;
    }
  });
}
