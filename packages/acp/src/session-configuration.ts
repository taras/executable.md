/**
 * Translate ACP session configuration into core's model and effort choices
 * (specs/acp-client-spec.md §Session configuration).
 *
 * ACP selectors stay inside this package. `AgentOptionSet` preserves exact ids,
 * display names, optional descriptions, groups and provider order. Category takes
 * precedence; the exact id `model` also identifies an uncategorized model selector.
 * Other controls are ignored. Recognized selectors with malformed or ambiguous
 * choices, duplicate ids or a selected value absent from their choices fail the
 * operation rather than reporting an empty option set.
 *
 * Apply model first, refresh its effort choices, then apply effort and verify the
 * result. Omitted settings cause no write. Once a write may have landed, any later
 * failure restores the previous settings in model-first order and preserves the
 * original failure. Unverifiable restoration marks the session unusable for the
 * rest of the run.
 *
 * A model change followed by an effort setting can run on one connection the
 * provider offers for the attempt. There, a selector counts as known only from
 * a response that listed every selector, so restoration rewrites whatever a
 * failed write may have moved and verifies it from the answer to that rewrite.
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
  "executablemd.acp.configuration-failure"?: {
    reason: "selector-unavailable" | "configuration-mismatch";
    setting: "model" | "effort";
  };
}

function configurationFailure(
  message: string,
  reason: "selector-unavailable" | "configuration-mismatch",
  setting: "model" | "effort",
): AcpConfigurationError {
  const error = new AcpConfigurationError(message);
  error["executablemd.acp.configuration-failure"] = { reason, setting };
  return error;
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
  /**
   * Run `body` on one connection to this conversation, closed before this
   * settles; `declined` when the provider routes this attempt the ordinary way.
   * `modelOptionId` is the selector the attempt writes first.
   */
  connect?<T>(
    modelOptionId: string,
    body: (connection: ConfigurationConnection) => Operation<T>,
  ): Operation<{ declined: true } | { declined: false; value: T }>;
}

/** One configuration attempt's connection, as long as `connect` runs its body. */
export interface ConfigurationConnection {
  /** The connected conversation's last saved status. */
  readStatus(): AcpRuntimeStatus;
  /**
   * One saved write; `settled` hears whether the response listed every
   * selector, even when the caller stopped waiting for it.
   */
  write(optionId: string, value: string, settled: (complete: boolean) => void): Operation<void>;
  /** Whether this connection still has the exact conversation it loaded. */
  usable(): boolean;
}

type Setting = "model" | "effort";

/**
 * Put back `prior` on one connection, as far as its own answers can prove.
 *
 * `unknown` names the settings no complete response has reported since a write
 * that may have moved them; each is rewritten rather than trusted, and only a
 * complete answer to that rewrite clears it.
 */
function* restoreConnected(
  connection: ConfigurationConnection,
  prior: { readonly model: string; readonly effort: string | undefined },
  unknown: Set<Setting>,
): Operation<boolean> {
  function* rewrite(optionId: string, value: string, setting: Setting): Operation<void> {
    unknown.add(setting);
    if (setting === "model") {
      unknown.add("effort");
    }
    yield* connection.write(optionId, value, (complete) => {
      if (complete) {
        unknown.clear();
      }
    });
  }
  try {
    if (!connection.usable()) {
      return false;
    }
    const current = readAgentOptions(connection.readStatus());
    if (current.model === null) {
      return false;
    }
    if (unknown.has("model") || current.model.set.selected !== prior.model) {
      yield* rewrite(current.model.optionId, prior.model, "model");
    }
    const refreshed = readAgentOptions(connection.readStatus());
    if (prior.effort !== undefined) {
      if (refreshed.effort === null) {
        return false;
      }
      if (unknown.has("effort") || refreshed.effort.set.selected !== prior.effort) {
        yield* rewrite(refreshed.effort.optionId, prior.effort, "effort");
      }
    }
    const verified = readAgentOptions(connection.readStatus());
    return (
      unknown.size === 0 &&
      verified.model?.set.selected === prior.model &&
      (prior.effort === undefined || verified.effort?.set.selected === prior.effort)
    );
  } catch {
    return false;
  }
}

/** How a connected attempt ended without throwing. */
type ConnectedOutcome =
  | { readonly kind: "configured"; readonly selectors: AgentOptionSelectors }
  /** The model write landed and its answer cannot authorize effort; continue ordinarily. */
  | { readonly kind: "split" };

/**
 * Change the model and then effort on one connection.
 *
 * `owe` records that in-place restoration could not prove the prior settings,
 * so the caller reattaches once the connection has closed.
 */
function* configureConnected(
  connection: ConfigurationConnection,
  target: ConfigurationTarget,
  request: { readonly model: string; readonly effort: string },
  initial: AgentOptionSelectors & { readonly model: RecognizedSelector },
  owe: () => void,
): Operation<ConnectedOutcome> {
  return yield* scoped(function* (): Operation<ConnectedOutcome> {
    const prior = { model: initial.model.set.selected, effort: initial.effort?.set.selected };
    const unknown = new Set<Setting>();
    let touched = false;
    let settled = false;
    let recovered = false;
    let complete = false;

    function* write(optionId: string, value: string, setting: Setting): Operation<boolean> {
      touched = true;
      unknown.add(setting);
      if (setting === "model") {
        unknown.add("effort");
      }
      complete = false;
      yield* connection.write(optionId, value, (answered) => {
        complete = answered;
        if (answered) {
          unknown.clear();
        }
      });
      return complete;
    }

    yield* ensure(function* () {
      if (settled || recovered || !touched) {
        return;
      }
      if (!(yield* restoreConnected(connection, prior, unknown))) {
        owe();
      }
    });

    try {
      const answered = yield* write(initial.model.optionId, request.model, "model");
      if (!answered || !connection.usable()) {
        settled = true;
        return { kind: "split" };
      }
      const refreshed = readAgentOptions(connection.readStatus());
      if (refreshed.model?.set.selected !== request.model) {
        throw configurationFailure(
          `this agent did not apply the model "${request.model}" to session ` +
            `"${target.sessionKey}", and reports "${refreshed.model?.set.selected ?? "nothing"}"`,
          "configuration-mismatch",
          "model",
        );
      }
      const model = refreshed.model.set.selected;
      if (refreshed.effort === null) {
        throw configurationFailure(effortUnavailable(model), "selector-unavailable", "effort");
      }
      if (!refreshed.effort.set.options.some((entry) => entry.id === request.effort)) {
        throw new AcpConfigurationError(invalidEffort(model, request.effort, refreshed.effort.set));
      }
      if (refreshed.effort.set.selected !== request.effort) {
        yield* write(refreshed.effort.optionId, request.effort, "effort");
      }
      const verified = readAgentOptions(connection.readStatus());
      if (verified.effort?.set.selected !== request.effort) {
        throw configurationFailure(
          `this agent did not apply the effort level "${request.effort}" to session ` +
            `"${target.sessionKey}", and reports "${verified.effort?.set.selected ?? "nothing"}"`,
          "configuration-mismatch",
          "effort",
        );
      }
      if (verified.model?.set.selected !== request.model) {
        throw configurationFailure(
          `this agent stopped reporting the model "${request.model}" for session ` +
            `"${target.sessionKey}" while its effort level was applied`,
          "configuration-mismatch",
          "model",
        );
      }
      settled = true;
      return { kind: "configured", selectors: verified };
    } catch (error) {
      if (!touched) {
        recovered = true;
        throw error;
      }
      const restored = yield* restoreConnected(connection, prior, unknown);
      recovered = true;
      if (!restored) {
        owe();
      }
      throw error;
    }
  });
}

function unusableAfter(error: unknown, sessionKey: string): AcpConfigurationError {
  const original = error instanceof Error ? error : new Error(String(error));
  const refused = new AcpConfigurationError(
    `${original.message}\n${restorationFailed(sessionKey)}`,
    { cause: original },
  );
  refused.sessionUnusable = true;
  return refused;
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
    const model = request.model;
    const effort = request.effort;
    const connect = target.connect;
    if (model === undefined || effort === undefined || connect === undefined) {
      return yield* configureOrdinary(target, request, initial, false);
    }
    const selector = validModel(target, model, initial);
    if (selector.set.selected === model) {
      return yield* configureOrdinary(target, request, initial, false);
    }
    const connected = { ...initial, model: selector };
    let owed = false;
    let reattached = false;

    /** One exact reattachment that rewrites both settings and reads the answers. */
    const reattach = function* (): Operation<boolean> {
      reattached = true;
      const prior = { model: selector.set.selected, effort: initial.effort?.set.selected };
      try {
        const outcome = yield* connect(selector.optionId, (connection) =>
          restoreConnected(connection, prior, new Set<Setting>(["model", "effort"])),
        );
        return !outcome.declined && outcome.value;
      } catch {
        return false;
      }
    };

    // Registered before the connection opens: a cancelled attempt whose
    // in-place restoration could not prove itself still owes the reattachment.
    yield* ensure(function* () {
      if (owed && !reattached) {
        let restored = false;
        try {
          restored = yield* reattach();
        } finally {
          if (!restored) {
            target.markUnusable();
          }
        }
      }
    });

    let outcome: { declined: true } | { declined: false; value: ConnectedOutcome };
    try {
      outcome = yield* connect(selector.optionId, (connection) =>
        configureConnected(connection, target, { model, effort }, connected, () => {
          owed = true;
        }),
      );
    } catch (error) {
      if (!owed) {
        throw error;
      }
      let restored = false;
      try {
        restored = yield* reattach();
      } finally {
        if (!restored) {
          target.markUnusable();
        }
      }
      if (restored) {
        throw error;
      }
      throw unusableAfter(error, target.sessionKey);
    }
    if (outcome.declined) {
      return yield* configureOrdinary(target, request, initial, false);
    }
    if (outcome.value.kind === "configured") {
      return outcome.value.selectors;
    }
    return yield* configureOrdinary(target, request, initial, true);
  });
}

/** The requested model's selector, or the refusal that names what is offered. */
function validModel(
  target: ConfigurationTarget,
  model: string,
  initial: AgentOptionSelectors,
): RecognizedSelector {
  if (initial.model === null) {
    throw configurationFailure(modelUnavailable(target.agent), "selector-unavailable", "model");
  }
  if (!initial.model.set.options.some((entry) => entry.id === model)) {
    throw new AcpConfigurationError(unknownModel(target.agent, model, initial.model.set));
  }
  return initial.model;
}

/**
 * Configure through single writes, starting from `initial`.
 *
 * `modelWritten` continues an attempt whose model write already settled on its
 * own connection: the model is not sent again, and a later failure still owes
 * the prior settings read before that write.
 */
function* configureOrdinary(
  target: ConfigurationTarget,
  request: SessionConfiguration,
  initial: AgentOptionSelectors,
  modelWritten: boolean,
): Operation<AgentOptionSelectors> {
  return yield* scoped(function* (): Operation<AgentOptionSelectors> {
    const priorModel = initial.model?.set.selected;
    const priorEffort = initial.effort?.set.selected;
    // A started write is a write that may have landed, so this is set before
    // one is issued rather than after it answers: an adapter that applies the
    // value and then fails its response has still applied it.
    let touched = modelWritten;
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
        const selector = validModel(target, request.model, initial);
        if (!modelWritten && selector.set.selected !== request.model) {
          touched = true;
          yield* target.write(selector.optionId, request.model);
        }
      }

      // The refreshed answer, and the only source of effort choices for the
      // model this conversation is now on.
      const refreshed = request.model === undefined ? initial : yield* read(target);
      if (request.model !== undefined && refreshed.model?.set.selected !== request.model) {
        throw configurationFailure(
          `this agent did not apply the model "${request.model}" to session ` +
            `"${target.sessionKey}", and reports "${refreshed.model?.set.selected ?? "nothing"}"`,
          "configuration-mismatch",
          "model",
        );
      }

      if (request.effort === undefined) {
        settled = true;
        return refreshed;
      }

      const model = refreshed.model?.set.selected;
      if (refreshed.effort === null) {
        throw configurationFailure(effortUnavailable(model), "selector-unavailable", "effort");
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
        throw configurationFailure(
          `this agent did not apply the effort level "${request.effort}" to session ` +
            `"${target.sessionKey}", and reports "${verified.effort?.set.selected ?? "nothing"}"`,
          "configuration-mismatch",
          "effort",
        );
      }
      if (request.model !== undefined && verified.model?.set.selected !== request.model) {
        throw configurationFailure(
          `this agent stopped reporting the model "${request.model}" for session ` +
            `"${target.sessionKey}" while its effort level was applied`,
          "configuration-mismatch",
          "model",
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
      throw unusableAfter(error, target.sessionKey);
    }
  });
}
