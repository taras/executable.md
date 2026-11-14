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
 * provider offers for the attempt. Recovery uses live selectors and restores
 * the saved preferences after verifying the prior settings.
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
   * Run the body on an exact cold connection and join its close and save.
   * A declined initial connection leaves ordinary configuration in charge.
   */
  connect?<T>(
    modelOptionId: string,
    phase: "model" | "effort" | "recovery",
    body: (connection: ConfigurationConnection) => Operation<T>,
  ): Operation<{ declined: true } | { declined: false; value: T }>;
  recordCleanupFailure?(error: Error): void;
}

interface SavedConfigurationPreferences {
  readonly model: string | undefined;
  readonly options: Readonly<Record<string, string>>;
}

/** One configuration attempt's connection, as long as its body runs. */
export interface ConfigurationConnection {
  readStatus(): AcpRuntimeStatus;
  observedStatus(): AcpRuntimeStatus | undefined;
  savedPreferences(): SavedConfigurationPreferences;
  restorePreferences(
    prior: SavedConfigurationPreferences,
    affected: ReadonlySet<string>,
  ): Operation<void>;
  write(optionId: string, value: string, started: () => void, restoring?: boolean): Operation<void>;
  usable(): boolean;
}

type Setting = "model" | "effort";

/** Reuse the same validation and verification for ordinary, connected and split writes. */
function* configureEffort(
  target: ConfigurationTarget,
  request: SessionConfiguration,
  refreshed: AgentOptionSelectors,
  write: (optionId: string, value: string) => Operation<void>,
  readBack: () => Operation<AgentOptionSelectors>,
): Operation<AgentOptionSelectors> {
  if (request.model !== undefined && refreshed.model?.set.selected !== request.model) {
    throw configurationFailure(
      `this agent did not apply the model "${request.model}" to session ` +
        `"${target.sessionKey}", and reports "${refreshed.model?.set.selected ?? "nothing"}"`,
      "configuration-mismatch",
      "model",
    );
  }
  if (request.effort === undefined) {
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
    yield* write(refreshed.effort.optionId, request.effort);
  }
  const verified = yield* readBack();
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
  return verified;
}

function observed(connection: ConfigurationConnection): AgentOptionSelectors | undefined {
  const status = connection.observedStatus();
  return status === undefined ? undefined : readAgentOptions(status);
}

function collectSelectors(
  selectors: AgentOptionSelectors | undefined,
  affected: Set<string>,
): void {
  for (const selector of [selectors?.model, selectors?.effort]) {
    if (selector) {
      affected.add(selector.optionId);
    }
  }
}

type Recovery = "restored" | "reopen" | "unverified";

function* restoreConnected(
  connection: ConfigurationConnection,
  prior: { readonly model: string; readonly effort: string | undefined },
  saved: SavedConfigurationPreferences,
  affected: Set<string>,
  restoring: Set<Setting>,
  modelAddress?: string,
): Operation<Recovery> {
  if (!connection.usable()) {
    return "unverified";
  }
  let current = observed(connection);
  collectSelectors(current, affected);
  if (current?.model?.set.selected !== prior.model) {
    const optionId = current === undefined ? modelAddress : current.model?.optionId;
    if (optionId === undefined || restoring.has("model")) {
      return "unverified";
    }
    yield* connection.write(optionId, prior.model, () => restoring.add("model"), true);
    current = observed(connection);
    collectSelectors(current, affected);
    if (current === undefined) {
      return "reopen";
    }
    if (current.model?.set.selected !== prior.model) {
      return "unverified";
    }
  }
  if (prior.effort !== undefined && current?.effort?.set.selected !== prior.effort) {
    if (!current?.effort || restoring.has("effort") || !connection.usable()) {
      return "unverified";
    }
    yield* connection.write(
      current.effort.optionId,
      prior.effort,
      () => restoring.add("effort"),
      true,
    );
    current = observed(connection);
    collectSelectors(current, affected);
    if (current === undefined) {
      return "reopen";
    }
  }
  if (
    current?.model?.set.selected !== prior.model ||
    (prior.effort !== undefined && current.effort?.set.selected !== prior.effort)
  ) {
    return "unverified";
  }
  yield* connection.restorePreferences(saved, affected);
  return "restored";
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
  const initial = yield* read(target);
  const { model, effort } = request;
  const connect = target.connect;
  if (model === undefined || effort === undefined || connect === undefined) {
    return yield* configureOrdinary(target, request, initial);
  }
  const requestedModel = model;
  const selector = validModel(target, requestedModel, initial);
  if (selector.set.selected === model) {
    return yield* configureOrdinary(target, request, initial);
  }

  const affected = new Set<string>();
  const restoring = new Set<Setting>();
  let prior:
    | {
        readonly model: string;
        readonly effort: string | undefined;
        readonly saved: SavedConfigurationPreferences;
      }
    | undefined;
  let touched = false;
  let accepted = false;
  let restored = false;
  let failure: Error | undefined;
  const recoveryErrors: Error[] = [];

  function* recover(
    connection: ConfigurationConnection,
    modelAddress?: string,
  ): Operation<Recovery> {
    if (prior === undefined) {
      return "unverified";
    }
    return yield* restoreConnected(
      connection,
      prior,
      prior.saved,
      affected,
      restoring,
      modelAddress,
    );
  }

  function forward(
    connection: ConfigurationConnection,
    phase: "model" | "effort",
  ): Operation<AgentOptionSelectors | undefined> {
    return scoped(function* () {
      // Forward effort may use the saved selector when the exact load omits it.
      const loaded = observed(connection) ?? readAgentOptions(connection.readStatus());
      collectSelectors(loaded, affected);
      let modelAddress = loaded.model?.optionId;
      let finished = false;
      yield* ensure(function* () {
        if (touched && !finished) {
          try {
            restored = (yield* recover(connection, modelAddress)) === "restored";
          } catch (error) {
            recoveryErrors.push(asError(error));
          }
        }
      });

      function write(optionId: string, value: string): Operation<void> {
        return connection.write(optionId, value, () => {
          touched = true;
          affected.add(optionId);
        });
      }

      let refreshed = loaded;
      if (phase === "model") {
        const current = validModel(target, requestedModel, loaded);
        prior = {
          model: current.set.selected,
          effort: loaded.effort?.set.selected,
          saved: connection.savedPreferences(),
        };
        if (current.set.selected !== requestedModel) {
          yield* write(current.optionId, requestedModel);
          const answered = observed(connection);
          collectSelectors(answered, affected);
          if (answered === undefined || !connection.usable()) {
            finished = true;
            return;
          }
          refreshed = answered;
          modelAddress = refreshed.model?.optionId;
        }
      }
      const result = yield* configureEffort(target, request, refreshed, write, function* () {
        const status = observed(connection);
        collectSelectors(status, affected);
        return status ?? readAgentOptions(connection.readStatus());
      });
      finished = true;
      return result;
    });
  }

  try {
    return yield* scoped(function* () {
      // Only this finalizer starts exact recovery. It runs after the forward
      // manager joins and cannot be interrupted into sending a write twice.
      yield* ensure(function* () {
        if (!touched || accepted) {
          return;
        }
        if (!restored) {
          try {
            const restore = (connection: ConfigurationConnection) => recover(connection);
            let result = yield* connect(selector.optionId, "recovery", restore);
            if (!result.declined && result.value === "reopen") {
              result = yield* connect(selector.optionId, "recovery", restore);
            }
            restored = !result.declined && result.value === "restored";
          } catch (error) {
            recoveryErrors.push(asError(error));
          }
        }
        if (!restored) {
          target.markUnusable();
        }
        if (restored || failure === undefined) {
          for (const error of recoveryErrors) {
            target.recordCleanupFailure?.(error);
          }
        }
      });
      try {
        const first = yield* connect(selector.optionId, "model", (connection) =>
          forward(connection, "model"),
        );
        if (first.declined) {
          return yield* configureOrdinary(target, request, initial);
        }
        let verified = first.value;
        if (verified === undefined) {
          const split = yield* connect(selector.optionId, "effort", (connection) =>
            forward(connection, "effort"),
          );
          if (split.declined || split.value === undefined) {
            throw new AcpConfigurationError(
              "The exact session could not settle its effort setting.",
            );
          }
          verified = split.value;
        }
        accepted = true;
        return verified;
      } catch (error) {
        failure = asError(error);
        throw failure;
      }
    });
  } catch (error) {
    if (!touched || restored) {
      throw error;
    }
    const original = asError(error);
    throw unusableAfter(
      recoveryErrors.length === 0
        ? original
        : new AggregateError([original, ...recoveryErrors], original.message, { cause: original }),
      target.sessionKey,
    );
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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

/** Configure through single writes, starting from `initial`. */
function* configureOrdinary(
  target: ConfigurationTarget,
  request: SessionConfiguration,
  initial: AgentOptionSelectors,
): Operation<AgentOptionSelectors> {
  return yield* scoped(function* (): Operation<AgentOptionSelectors> {
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
        const selector = validModel(target, request.model, initial);
        if (selector.set.selected !== request.model) {
          touched = true;
          yield* target.write(selector.optionId, request.model);
        }
      }

      const refreshed = request.model === undefined ? initial : yield* read(target);
      const verified = yield* configureEffort(
        target,
        request,
        refreshed,
        function* (optionId, value) {
          touched = true;
          yield* target.write(optionId, value);
        },
        () => read(target),
      );
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
