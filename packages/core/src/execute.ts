/**
 * Entry point — execute (spec §7).
 *
 * Wires together the boundary scanner, component import, expansion engine,
 * modifier system, and journal infrastructure. `execute` is delivered
 * through the Execution Api so extensions can decorate the execution
 * lifecycle as middleware.
 *
 * Journal runtime integration is concentrated at execution boundaries.
 * See DEC-005 in specs/decisions.md.
 */

import { Err, Ok, scoped, spawn, withResolvers, until } from "effection";
import type { Operation, Result, Stream } from "effection";
import { type Api, createApi, type Operations } from "@effectionx/context-api";
import {
  durableRun,
  createDurableOperation,
  ephemeral,
  preserveJournalProvenance,
  retainEvents,
  StaleInputError,
  type CoroutineId,
  type DurableEvent,
  type DurableStream,
  type Yield,
} from "@executablemd/durable-streams";
import { exec, readTextFile, cwd } from "@executablemd/runtime";
import { cwd as processCwd } from "@effectionx/fs";
import type { Workflow, Json } from "@executablemd/durable-streams";
import { createReplayStream } from "./replay-stream.ts";
import { consumeAtTerminal, issueExecution } from "./execution-request.ts";
import type { CompletionFailure, ExecutionRequest } from "./execution-request.ts";
import { createContext } from "effection";
import type { Context } from "effection";
import type {
  ComponentDefinition,
  ComponentRegistry,
  FunctionComponent,
  FunctionComponentDefinition,
  JsonObject,
  PropsSchema,
  ReturnsSchema,
  Segment,
} from "./types.ts";
import { isJsonObject, parseJson, parseJsonObject } from "./json.ts";
import {
  compilePropsSchema,
  compileReturnsSchema,
  usePropsCompiler,
  validateProps,
} from "./validate.ts";
import { useParseCompiler } from "./components/parse-schema.ts";
import {
  documentOutline,
  isFunctionComponentPath,
  parseMarkdownDefinition,
  parseRootMarkdownDefinition,
  resolveDocumentTarget,
} from "./definition.ts";
import {
  asDocumentTargetError,
  documentTargetError,
  documentTargetFailure,
  findTarget,
  isCanonicalTarget,
  recordedDocumentTargetFailure,
  sameDocumentTargetFailure,
} from "./document-targets.ts";
import type { DocumentOutline, DocumentTargetFailure } from "./document-targets.ts";
import { parseReturnsDeclaration } from "./frontmatter.ts";
import {
  expandSegments,
  expandBody,
  bodyHasOutput,
  isTopLevelReturn,
  resolveReturnValue,
  validateBodyStructure,
  createBlockCounter,
} from "./expand.ts";
import type { BlockCounter } from "./expand.ts";
import {
  DocumentationError,
  documentationError,
  documentationFailure,
  durabilityFailure,
  useSegmentCauses,
} from "./errors.ts";
import { Component, importComponent } from "./component-api.ts";
import { renderSegment } from "./render.ts";
import { DocumentOutput } from "./api.ts";
import {
  composeModifierChain,
  buildCommand,
  createModifierRegistry,
  useCodeBlock,
} from "./modifiers.ts";
import type { ModifierFactory } from "./modifiers.ts";
import { evalFactory } from "./eval-handler.ts";
import { persistFactory } from "./modifiers/persist.ts";
import { timeoutFactory } from "./modifiers/timeout.ts";
import { daemonFactory } from "./modifiers/daemon.ts";
import { ephemeralFactory } from "./modifiers/ephemeral.ts";
import { serviceFactory } from "./modifiers/service.ts";
import {
  DEFAULT_COMPONENT_DIRS,
  effectiveRegistry,
  selectComponent,
  unresolvedMessage,
} from "./components/select.ts";
import type { EvalEnv } from "./types.ts";
import { readRootSource, rootSourcePath } from "./root-source.ts";
import type { RootDocumentSource } from "./root-source.ts";
import { useEvalScope } from "@effectionx/scope-eval";
import { Stdio } from "@effectionx/process";
import { useSecretDetection } from "./secrets/policy.ts";
import { propsEnvironment } from "./eval-env.ts";
import { liveEnvironment } from "./live-env.ts";

export interface ExecuteSettings {
  /** Durable stream for journaling. */
  stream: DurableStream;

  /** JSON values supplied to the root document (default: `{}`). */
  props?: Record<string, Json>;

  /** Component search directories (default: ["./components", "./"]) */
  componentDirs?: string[];

  /** Custom modifier factories to register */
  modifiers?: Record<string, ModifierFactory>;

  /**
   * Detect credentials before durable events persist.
   * Enabled unless the trusted host explicitly supplies `false`.
   */
  secretDetection?: boolean;
}

/**
 * What to execute and how: the root document — a path, or text supplied with
 * its `<eval>` identity — together with the run's settings.
 */
export type ExecuteOptions = RootDocumentSource & ExecuteSettings;

/**
 * What resolving a name decided, in a form the journal can hold.
 *
 * Selection is an observation of the environment — which files exist, what is
 * registered — so it belongs inside the durable operation with the read it
 * leads to. A registration is recorded by origin rather than by value: a
 * function cannot be serialized, so replay restores the origin and looks the
 * implementation up again in the scope that is running now.
 */
type DurableSelection =
  | { kind: "repository"; path: string; content: string; target?: string }
  | { kind: "target-failure"; path: string; content: string; failure: TargetFailureRecord }
  | { kind: "registered"; origin: string; reserved: boolean };

/**
 * A selection that named no single section, as the journal holds it.
 *
 * A failed selection is an observation of the document, not an accident: the
 * text was read, and it does not offer what was asked for. Recording it as data
 * — rather than letting the effect fail and keeping only a serialized message —
 * is what lets a resumed run tell "the same request, failing the same way" from
 * "a different request the recorded run never made", and what lets the failure
 * be rebuilt with its fields intact instead of reduced to prose.
 *
 * `selector` is sanitized invocation metadata. It is never identity: it does
 * not occupy the exact-target field, and it never reaches a workflow
 * definition.
 */
type TargetFailureRecord = {
  kind: string;
  selector: string;
  matches: string[];
  available: string[];
};

function targetFailureRecord(failure: DocumentTargetFailure): TargetFailureRecord {
  return {
    kind: failure.kind,
    selector: failure.selector,
    matches: [...failure.matches],
    available: [...failure.available],
  };
}

function* durableImportComponent(
  name: string,
  root: RootDocumentSource | undefined,
  searchPaths: string[],
  registry: ComponentRegistry,
): Workflow<ComponentDefinition | FunctionComponentDefinition> {
  const selection = (yield createDurableOperation<DurableSelection>(
    { type: "import_component", name },
    function* (): Operation<DurableSelection> {
      if (name === "__root__" && root) {
        // Inside the durable operation, so the journal holds the root's identity
        // and its text: a replay restores both without reading anything, whether
        // the source was a file or supplied.
        //
        // The selector resolves here too, against the text this operation is
        // about to record, so the exact target the run executed is part of the
        // record rather than something a later read has to rediscover. Only the
        // exact target is recorded — a glob describes what the caller asked
        // for, not what ran.
        const path = rootSourcePath(root);
        const content = yield* readRootSource(root);
        if (root.target === undefined) {
          return { kind: "repository", path, content };
        }
        const resolved = resolveDocumentTarget(path, content, root.target);
        if (resolved.ok) {
          return { kind: "repository", path, content, target: resolved.value };
        }
        const failure = asDocumentTargetError(resolved.error);
        if (failure === undefined) {
          throw resolved.error;
        }
        return {
          kind: "target-failure",
          path,
          content,
          failure: targetFailureRecord(failure.data),
        };
      }

      const selected = yield* selectComponent(name, { componentDirs: searchPaths, registry });

      switch (selected.kind) {
        case "repository":
          return {
            kind: "repository",
            path: selected.path,
            content: yield* readTextFile(selected.path),
          };
        case "registered":
          return {
            kind: "registered",
            origin: selected.origin.kind === "registered" ? selected.origin.origin : "",
            reserved: selected.origin.kind === "registered" && selected.origin.reserved,
          };
        case "structural":
          throw new Error(
            `${name} is structural syntax the engine owns, so it never resolves a component`,
          );
        case "unresolved":
          throw new Error(unresolvedMessage(name, selected.searched));
      }
    },
  )) as DurableSelection;

  // Rebuilt here rather than carried out of the durable operation, so a replayed
  // failed selection and a live one raise the same error with the same fields.
  // Parsed rather than trusted: the record is journal data.
  if (selection.kind === "target-failure") {
    const failure = recordedDocumentTargetFailure(selection.failure);
    if (failure === undefined) {
      throw new Error(UNREADABLE_ROOT_RECORD);
    }
    throw documentTargetError(failure);
  }

  if (selection.kind === "registered") {
    // The function was never journaled. Find the implementation the recorded
    // origin names in the registry this run has; refusing when it is gone is
    // what keeps a replay from quietly invoking somebody else's component.
    const entry = effectiveRegistry(registry).get(name);
    const found = selection.reserved ? entry?.reserved : entry?.default;
    if (!found || found.origin !== selection.origin) {
      const kind = selection.reserved ? "reserved registration" : "registration";
      throw new Error(
        `Component ${name} was recorded as the ${kind} "${selection.origin}", which is not ` +
          `registered in this run${found ? ` — "${found.origin}" is registered instead` : ""}.`,
      );
    }
    return found.definition;
  }

  const { path, content, target } = selection;

  // Function component: .ts file — import() the module
  if (isFunctionComponentPath(path)) {
    // Against the process's directory, not the contextual `Env.cwd`: the search
    // that chose this path stats there too, so a component that rebinds `cwd`
    // for its content — `<TempDir>` — does not change which components that
    // content can resolve, or leave a selected path unloadable.
    const currentDir = yield* ephemeral(processCwd());
    const absolutePath = path.startsWith("/") ? path : `${currentDir}/${path}`;
    const mod = yield* ephemeral(until(import(`file://${absolutePath}`)));
    if (typeof mod !== "object" || mod === null) {
      throw new Error(`Function component "${name}" at ${path} did not load a module`);
    }

    const defaultExport = "default" in mod ? mod.default : undefined;
    if (!isFunctionComponent(defaultExport)) {
      throw new Error(
        `Function component "${name}" at ${path} must have a default export that is a generator function`,
      );
    }

    const propsExport = "props" in mod ? mod.props : undefined;
    const props: PropsSchema =
      propsExport === undefined
        ? { type: "object", properties: {}, additionalProperties: false }
        : parseJsonObject(propsExport);
    yield* ephemeral(compilePropsSchema(props));

    const definition: FunctionComponentDefinition = {
      kind: "function",
      name,
      props,
      fn: defaultExport,
    };

    if ("returns" in mod && mod.returns !== undefined) {
      const returns = parseReturnsDeclaration(mod.returns);
      yield* ephemeral(compileReturnsSchema(returns));
      definition.returns = returns;
    }

    return definition;
  }

  // Markdown component: parse at runtime — deterministic from content.
  // A recorded target projects the recorded content, so a resumed run executes
  // the same section from the same text the first run recorded, whatever the
  // file on disk says now.
  if (target !== undefined) {
    return (yield* ephemeral(parseRootMarkdownDefinition(name, path, content, target))).definition;
  }
  return yield* ephemeral(parseMarkdownDefinition(name, path, content));
}

function isFunctionComponent(value: unknown): value is FunctionComponent {
  return typeof value === "function";
}

/**
 * What one run's selector decided: the whole document, one exact section, or a
 * failure that named none.
 *
 * Selection is compared as an outcome rather than as a target string, because a
 * failed selection is an outcome too. Without the third case a journal written
 * by one selector that matched nothing would answer a later request for a
 * section that does exist.
 */
type SelectionOutcome =
  | { kind: "whole" }
  | { kind: "exact"; target: string }
  | { kind: "failed"; failure: DocumentTargetFailure };

/**
 * What the fixed diagnostic says when a recorded root import cannot be read,
 * and all it says.
 *
 * Cause-free: the record is journal data, and quoting it back would put
 * whatever it holds into a diagnostic.
 */
const UNREADABLE_ROOT_RECORD = "The recorded root document import cannot be read by this version.";

/** The coroutine a document execution's own terminal result belongs to. */
const ROOT_COROUTINE = "root";

/**
 * What a recorded event turned out to be.
 *
 * "Not the root import" and "the root import, malformed" are deliberately
 * different answers. Collapsing them into one absent value is what would let a
 * corrupted record fall through to the recorded terminal result, which is the
 * failure this distinction exists to prevent.
 */
type RootImportRecord =
  | { kind: "unrelated" }
  | { kind: "malformed" }
  | { kind: "read"; outline: DocumentOutline; selection: SelectionOutcome };

const UNRELATED: RootImportRecord = { kind: "unrelated" };
const MALFORMED: RootImportRecord = { kind: "malformed" };

/**
 * Read a value that may refuse to be read.
 *
 * Every value this boundary touches comes from the journal, and a journal is
 * data: a property may be an accessor that throws, a key list may come from a
 * Proxy that refuses, and content may be markdown whose frontmatter no parser
 * accepts. None of those is a failure of this run — they are ways of saying the
 * record cannot be read — so none of them may travel as an error of its own.
 *
 * Synchronous throughout, so nothing an Effection scope owns passes through
 * here: this cannot swallow a cancellation or a durability failure, because
 * neither can arise inside a synchronous parse.
 */
function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Parse a recorded root import as a closed protocol.
 *
 * Two selection shapes are supported and nothing else: a repository selection
 * with an optional canonical target, and a failed selection with an exact
 * failure record. An unknown kind, a missing or mistyped member, an extra
 * member, a noncanonical target, and failure data that no selection could have
 * produced are each malformed rather than absent.
 *
 * A result that is not `ok` is left alone. A root import can fail for reasons
 * that have nothing to do with selection — an unreadable file — and those
 * recorded failures are not this protocol's to interpret.
 */
/**
 * A value the journal refused to produce.
 *
 * Distinct from `undefined`, which is an ordinary absent value. Reading a
 * member and finding nothing there, and reading a member that will not say what
 * is there, are different facts about a record, and one of them is a refusal:
 * conflating them is how "the root import will not say what it settled to"
 * became "this is not the root import" and fell through to terminal-result
 * reuse.
 */
const UNREADABLE: unique symbol = Symbol("unreadable");

/** One read of journal-controlled data: its value, or a refusal. */
function read<T>(get: () => T): T | typeof UNREADABLE {
  try {
    return get();
  } catch {
    return UNREADABLE;
  }
}

/** The settlements the protocol recognizes as an ordinary failed root import. */
const SETTLED_FAILURES: readonly string[] = ["err", "cancelled"];

function recordedRootImport(event: Yield): RootImportRecord {
  // Identification first. An event that will not say what it is cannot be
  // claimed as the root import, so it stays unrelated.
  const description = read(() => event.description);
  if (description === UNREADABLE) {
    return UNRELATED;
  }
  const type = read(() => description.type);
  const name = read(() => description.name);
  if (type !== "import_component" || name !== "__root__") {
    return UNRELATED;
  }

  // Identified. From here the event owes this protocol an answer, and every way
  // of not giving one is malformed — except the ordinary failed settlement,
  // which is a root import that failed for reasons selection knows nothing
  // about.
  const result = read(() => event.result);
  if (result === UNREADABLE || typeof result !== "object" || result === null) {
    return MALFORMED;
  }
  const status = read(() => result.status);
  if (status !== "ok") {
    return typeof status === "string" && SETTLED_FAILURES.includes(status) ? UNRELATED : MALFORMED;
  }
  const value = read(() => ("value" in result ? result.value : undefined));
  if (value === UNREADABLE || value === undefined) {
    return MALFORMED;
  }
  return attempt(() => readRootSelection(value)) ?? MALFORMED;
}

function readRootSelection(value: unknown): RootImportRecord {
  // Parsed rather than read in place. `parseJson` walks every property once and
  // rebuilds the record, so a trap that throws or a value that is not JSON is
  // discovered here — and every read below is of this run's own copy rather
  // than of an object the journal still controls.
  const record = parseJson(value);
  if (!isJsonObject(record)) {
    return MALFORMED;
  }
  const content = record["content"];
  const path = record["path"];
  if (typeof content !== "string" || typeof path !== "string") {
    return MALFORMED;
  }
  const kind = record["kind"];
  const members = Object.keys(record).length;
  // Parsing the recorded content is part of reading the record, for every
  // shape. It is what the verification below compares against, and doing it
  // here means a later read of the same content cannot be the first to
  // discover that it does not parse.
  const outline = documentOutline(path, content);

  if (kind === "repository") {
    const target = record["target"];
    if (target === undefined) {
      return members === 3 ? { kind: "read", outline, selection: { kind: "whole" } } : MALFORMED;
    }
    if (members !== 4 || typeof target !== "string" || !isCanonicalTarget(target)) {
      return MALFORMED;
    }
    // The recorded content is here, so the target is verified against it rather
    // than merely parsed: a well-formed target the recorded document does not
    // offer describes a selection that never happened.
    const resolved = findTarget(outline, target);
    if (!resolved.ok || resolved.value.target !== target) {
      return MALFORMED;
    }
    return { kind: "read", outline, selection: { kind: "exact", target } };
  }

  if (kind === "target-failure") {
    const failure = recordedDocumentTargetFailure(record["failure"]);
    if (members !== 4 || failure === undefined) {
      return MALFORMED;
    }
    // Same standard for a failure: the recorded selector must fail against the
    // recorded content in exactly the way the record claims. That verifies the
    // catalog and the matches too, which no amount of shape checking could.
    const rederived = findTarget(outline, failure.selector);
    if (rederived.ok) {
      return MALFORMED;
    }
    const actual = asDocumentTargetError(rederived.error);
    if (actual === undefined || !sameDocumentTargetFailure(actual.data, failure)) {
      return MALFORMED;
    }
    return { kind: "read", outline, selection: { kind: "failed", failure } };
  }

  return MALFORMED;
}

/**
 * What this run's selector decides against the outline the journal recorded.
 *
 * Takes the outline the record already produced rather than the content, so
 * this cannot be the call that discovers unparseable recorded markdown — that
 * discovery belongs to reading the record, where it is malformed rather than an
 * error of this run's own.
 */
function requestedSelection(root: RootDocumentSource, outline: DocumentOutline): SelectionOutcome {
  if (root.target === undefined) {
    return { kind: "whole" };
  }
  const found = findTarget(outline, root.target);
  if (found.ok) {
    return { kind: "exact", target: found.value.target };
  }
  const failure = asDocumentTargetError(found.error);
  // A failure this module did not build is not a selection outcome that can be
  // compared, so it cannot be shown compatible with anything.
  return failure === undefined
    ? { kind: "failed", failure: documentTargetFailure("invalid-selector", root.target, [], []) }
    : { kind: "failed", failure: failure.data };
}

function sameSelection(recorded: SelectionOutcome, requested: SelectionOutcome): boolean {
  if (recorded.kind === "whole" || requested.kind === "whole") {
    return recorded.kind === requested.kind;
  }
  if (recorded.kind === "exact" || requested.kind === "exact") {
    return (
      recorded.kind === "exact" &&
      requested.kind === "exact" &&
      recorded.target === requested.target
    );
  }
  return sameDocumentTargetFailure(recorded.failure, requested.failure);
}

function describeSelection(selection: SelectionOutcome): string {
  switch (selection.kind) {
    case "whole":
      return "the whole document";
    case "exact":
      return `the target ${JSON.stringify(selection.target)}`;
    case "failed":
      return `a selector that names no single target (${selection.failure.kind})`;
  }
}

/**
 * The journal a document execution reads and appends through, with the
 * definition-identity check that a resumed run must pass built into the read.
 *
 * **This authority is not middleware.** Exact canonical target is
 * workflow-definition identity, and identity may not be decided by anything a
 * document, a component, or an enclosing scope can replace. A public
 * `ReplayGuard` handler installed further out can decline to call `next`, which
 * is exactly what composable policy is allowed to do — and exactly why the
 * comparison cannot live there. Here it is a step inside `readAll`, owned by
 * the execution, reachable through no context and replaceable by nothing.
 *
 * It runs where a journal first becomes readable, so it is ahead of everything
 * a wrong answer could reach: public guard policy, any retained Yield reaching
 * execution, a retained Close being reused, authored work, and any append.
 *
 * It also owns the retained snapshot. The events it validates are the events it
 * returns, so the identity and settlement it decided on are what every later
 * phase observes rather than a second reading of the backend's own objects.
 *
 * It is a trusted wrapping site, and says so explicitly. Journal provenance is
 * not transitive: a wrapper is unproven unless a wrapping site carries its
 * source's witness onto it, and a run whose journal is unproven is refused by a
 * Workspace provider before any transaction. This wrapper qualifies because
 * core installs it before any document code exists and it delegates every
 * append to the exact stream it was handed. What it transfers is only the
 * witness that exact source already has — it establishes none, so an unproven
 * source stays unproven and a wrapper somebody else built gains nothing.
 */
function guardedJournal(
  stream: DurableStream,
  root: RootDocumentSource,
  coroutineId: CoroutineId,
  admissions: readonly JournalAdmission[],
): DurableStream {
  const admitting: DurableStream = {
    *readAll(): Operation<DurableEvent[]> {
      const retained = retainEvents(yield* stream.readAll());
      // What the trusted host required of this history, on the retained
      // snapshot every later phase reads, in the order it was captured and
      // stopping at the first refusal. Ahead of root-history admission,
      // ReplayGuard, terminal reuse, authored work and any append.
      for (const admission of admissions) {
        yield* admission(retained);
      }
      admitRootHistory(retained, root, coroutineId);
      return retained;
    },
    append: (event: DurableEvent) => stream.append(event),
  };
  return preserveJournalProvenance(stream, admitting);
}

/**
 * Decide whether this run may replay the history it was handed.
 *
 * Synchronous and total over journal-provided values: every way the history can
 * refuse to be read is the one fixed diagnostic, and the retained events it
 * reads are the ones the caller keeps.
 */
function admitRootHistory(
  retained: readonly DurableEvent[],
  root: RootDocumentSource,
  coroutineId: CoroutineId,
): void {
  const imports: Yield[] = [];
  let terminal = false;
  for (const event of retained) {
    // The retained history has already settled every discriminator, so one that
    // still refuses is a history this run cannot describe — not an event to
    // skip past on the way to reusing a terminal result.
    const kind = attempt(() => event.type);
    if (kind === undefined) {
      throw new Error(UNREADABLE_ROOT_RECORD);
    }
    if (kind === "close") {
      // Any recorded completion at all, not only this coroutine's. A Close
      // means some coroutine of this document execution finished, and every
      // coroutine it has exists because the root document was imported — so a
      // history holding one while the import that authorized it is absent
      // describes a run that never happened, whichever coroutine the Close
      // claims to belong to.
      //
      // Its result is recognized here as well as its coroutine. The retained
      // history has already settled both, and forcing them now is what makes a
      // refusal this run's fixed diagnostic rather than a failure surfacing
      // later, out of some other phase's hands.
      if (attempt(() => event.coroutineId) === undefined) {
        throw new Error(UNREADABLE_ROOT_RECORD);
      }
      if (attempt(() => event.result) === undefined) {
        throw new Error(UNREADABLE_ROOT_RECORD);
      }
      terminal = true;
      continue;
    }
    if (event.type !== "yield") {
      continue;
    }
    if (isRootImport(event)) {
      imports.push(event);
    }
  }

  // A journal that recorded no completion replays what it has and then
  // continues live, so a root import it does not contain is one this run
  // performs. A journal that recorded one is standing behind a selection: a
  // history that recorded no import, recorded two, or recorded one belonging to
  // some other coroutine establishes nothing for this coroutine to stand
  // behind.
  if (terminal) {
    const owned = imports.filter((event) => attempt(() => event.coroutineId) === coroutineId);
    if (imports.length !== 1 || owned.length !== 1) {
      throw new Error(UNREADABLE_ROOT_RECORD);
    }
  }

  for (const event of imports) {
    admitRootSelection(event, root);
  }
}

/** Whether a retained event is recognizably the root import. */
function isRootImport(event: DurableEvent): boolean {
  return (
    attempt(
      () =>
        event.type === "yield" &&
        event.description.type === "import_component" &&
        event.description.name === "__root__",
    ) === true
  );
}

/**
 * Hold a resumed run to the selection its journal recorded.
 *
 * Only `type` and `name` decide whether a journal entry matches, and the root
 * import's name is the same for every selector — so without this, resuming with
 * a different one would restore the recorded content and then project a section
 * the recorded run never executed, or restore a recorded selection failure as
 * the answer to a request that would have succeeded.
 *
 * The current selector is resolved against the *recorded* content, so what is
 * compared is what each run decided, not what each caller typed: a different
 * glob naming the same section replays, and so does the same failing selector,
 * while any difference in outcome is stale input.
 *
 * A recorded failed selection is reproduced here, not left for later. Nothing
 * later would reproduce it with its fields intact — `durableRun` reuses a
 * recorded root Close before any effect is replayed, and that path restores a
 * deserialized error — so a recorded failure is rebuilt from its structural
 * record and raised ahead of that reuse. Either way no authored effect runs.
 *
 * Partial histories are held to the same rule: a recorded root import that
 * names another section is refused before replay continues into it.
 */
function admitRootSelection(event: Yield, root: RootDocumentSource): void {
  const recorded = recordedRootImport(event);
  if (recorded.kind === "unrelated") {
    return;
  }
  if (recorded.kind === "malformed") {
    throw new Error(UNREADABLE_ROOT_RECORD);
  }
  const requested = requestedSelection(root, recorded.outline);
  if (!sameSelection(recorded.selection, requested)) {
    throw new StaleInputError(
      `the recorded root document import ran ${describeSelection(recorded.selection)}, and ` +
        `this run asks for ${describeSelection(requested)}. Re-run the document from the ` +
        "start rather than resuming from a journal that recorded another selection.",
      { coroutineId: event.coroutineId, description: event.description },
    );
  }
  if (recorded.selection.kind === "failed") {
    throw documentTargetError(recorded.selection.failure);
  }
}

const execFactory: ModifierFactory = (_params) => (_args, _next) =>
  (function* () {
    const context = yield* useCodeBlock();
    const command = buildCommand(context.language, context.content);
    const result = (yield createDurableOperation<Json>(
      {
        type: "exec",
        name: `exec:${context.content.slice(0, 40).replace(/\n/g, " ")}`,
        command: command as unknown as Json,
      },
      function* (): Operation<Json> {
        const execResult = yield* exec({
          command,
          cwd: yield* cwd(),
          timeout: 30_000,
        });
        return execResult as unknown as Json;
      },
    )) as unknown as { exitCode: number; stdout: string; stderr: string };

    return {
      output: result.stdout,
      exitCode: result.exitCode,
      stderr: result.stderr,
    };
  })();

// `silent` suppresses output; it does not convert failure into success (#307).
// The outcome it hands back is the inner chain's, so a silenced command that
// failed is still a failure — carrying the exit code and the stderr that say
// so, with only the channel the author asked to hide removed.
const silentFactory: ModifierFactory = (_params) => (_args, next) =>
  (function* () {
    const result = yield* next(); // inner chain runs — exec journals its result
    return { ...result, output: "" };
  })();

/**
 * What a document run produces. `output` is rendered body text — the
 * observability channel — and a completed run adds its return value: the same
 * rendered text for a text root, the validated JSON for a value root. The pair
 * is journaled together so replay restores both; only `value` is public.
 */
export type DocumentResult = DocumentSuccess | DocumentFailureResult;

type DocumentSuccess = {
  status: "ok";
  output: string;
  value: Json;
};

/**
 * A document that decided it failed. This is an outcome, not an accident: the
 * run is over, what it rendered first is part of the record, and the journal
 * closes `ok` around it so a replay restores both without re-executing
 * anything. A durability failure is the opposite case and never arrives here
 * (§6.11) — it says the journal no longer describes this run, so recording it
 * as the run's own result would write onto a journal already known to be wrong.
 */
type DocumentFailureResult = {
  status: "err";
  output: string;
  error: DocumentFailure;
};

/**
 * What crosses the journal about a failure. Everything here is JSON: object
 * identity, stacks, and the cause graph stay behind, which is why the live path
 * resolves the original error instead of this description (`LiveFailure`).
 *
 * A field is absent when the failure had nothing to say there, and present when
 * it did. The distinction is load-bearing for `cause`: an absent key says the
 * failure had no own cause, while `"undefined"` says it had one whose value was
 * `undefined` — a component may throw exactly that.
 */
type DocumentFailure = {
  name: string;
  message: string;
  segment: { message: string; source?: string };
  cause?: string;
  errors?: { name: string; message: string }[];
};

/**
 * Where one execution leaves the failure it caught, for its own completion.
 *
 * The handoff is short and entirely inside a run: the workflow's catch fills
 * this, and the completion takes it. A live run therefore reports the failure it
 * actually caught — same object, same type, same `cause`, same aggregate
 * members — while a replayed run never enters the workflow, leaves the slot
 * empty, and reports the account the journal kept. The empty slot is the signal;
 * nothing asks whether it is replaying.
 *
 * The slot belongs to the run's scope, so it is gone when the run is.
 */
interface LiveFailureSlot {
  failure?: unknown;
}

const LiveFailure: Context<LiveFailureSlot | undefined> = createContext<
  LiveFailureSlot | undefined
>("execution.liveFailure", undefined);

function* rememberLiveFailure(error: unknown): Operation<void> {
  const slot = yield* LiveFailure.get();
  if (slot) {
    slot.failure = error;
  }
}

/** The live failure this run recorded, taken so it answers exactly once. */
function* takeLiveFailure(slot: LiveFailureSlot): Operation<unknown> {
  const live = slot.failure;
  slot.failure = undefined;
  return live;
}

function describeFailure(caught: unknown, documentation: DocumentationError): DocumentFailure {
  const wrapper = caught instanceof Error ? caught : new Error(String(caught));
  return {
    name: wrapper.name,
    message: wrapper.message,
    segment: {
      message: documentation.segment.message,
      ...(documentation.segment.source === undefined
        ? {}
        : { source: documentation.segment.source }),
    },
    // An own property, not an inherited one: every Error inherits `cause` from
    // nowhere useful, and what this records is what this failure was given.
    ...(Object.hasOwn(wrapper, "cause") ? { cause: describeCause(wrapper.cause) } : {}),
    ...(wrapper instanceof AggregateError
      ? {
          errors: wrapper.errors.map((member: unknown) => ({
            name: member instanceof Error ? member.name : "Error",
            message: member instanceof Error ? member.message : String(member),
          })),
        }
      : {}),
  };
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The error a completion reports for a failed document: the original one on a
 * live run, and otherwise the documented reconstruction of it.
 */
function failureError(failure: DocumentFailure, live: unknown): unknown {
  if (live !== undefined) {
    return live;
  }
  const members = failure.errors;
  const replayed = members
    ? new AggregateError(
        members.map((member) => withName(new Error(member.message), member.name)),
        failure.message,
      )
    : new Error(failure.message);
  if (failure.cause !== undefined) {
    replayed.cause = failure.cause;
  }
  return withName(replayed, failure.name);
}

function withName(error: Error, name: string): Error {
  error.name = name;
  return error;
}

/**
 * Narrow what the journal or the workflow handed back, field by field.
 *
 * The result is parsed rather than trusted: a journal is data, and a replayed
 * run must fail on a shape it cannot read instead of carrying it further. The
 * live failure is looked up from the value `durableRun` returned, before this
 * runs, so parsing is free to build its own object.
 */
function parseDocumentResult(value: unknown): DocumentResult {
  const candidate = parseJsonObject(value);
  const output = candidate["output"];
  if (typeof output !== "string") {
    throw new Error("A document result must carry its rendered output as a string.");
  }
  const status = candidate["status"];
  if (status === "ok") {
    return { status: "ok", output, value: parseJson(candidate["value"]) };
  }
  if (status === "err") {
    return { status: "err", output, error: parseFailure(candidate["error"]) };
  }
  throw new Error(
    `A document result records its outcome as "ok" or "err", and this one records ` +
      `${JSON.stringify(status)}. A journal written before the outcome contract ` +
      `(#318) has no status at all and cannot be replayed by this version.`,
  );
}

function parseFailure(value: unknown): DocumentFailure {
  const candidate = parseJsonObject(value);
  const name = candidate["name"];
  const message = candidate["message"];
  if (typeof name !== "string" || typeof message !== "string") {
    throw new Error("A failure description carries a name and a message.");
  }
  const segment = parseJsonObject(candidate["segment"]);
  const segmentMessage = segment["message"];
  if (typeof segmentMessage !== "string") {
    throw new Error("A failure description carries the message of the segment that failed.");
  }
  // An optional field is absent or well-formed. Anything else is a journal this
  // run cannot read, and coercing it to "absent" would report a failure that
  // quietly disagrees with the one recorded.
  const source = optionalString(segment, "source", "The source of a failed segment");
  const cause = optionalString(candidate, "cause", "The cause of a failure");
  const errors = candidate["errors"];
  if (errors !== undefined && !Array.isArray(errors)) {
    throw new Error("The aggregate members of a failure are a list.");
  }
  return {
    name,
    message,
    segment: { message: segmentMessage, ...(source === undefined ? {} : { source }) },
    ...(cause === undefined ? {} : { cause }),
    ...(errors === undefined ? {} : { errors: errors.map(parseFailureMember) }),
  };
}

function optionalString(holder: JsonObject, key: string, subject: string): string | undefined {
  const value = holder[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${subject} is text when it is recorded at all.`);
  }
  return value;
}

function parseFailureMember(value: Json): { name: string; message: string } {
  const member = parseJsonObject(value);
  const name = member["name"];
  const message = member["message"];
  if (typeof name !== "string" || typeof message !== "string") {
    throw new Error("An aggregate member carries a name and a message.");
  }
  return { name, message };
}

/**
 * Run a value root (spec §5.4). Its body executes completely under fail-fast,
 * so no printed error can pass for a result, while rendered text still reaches the
 * output stream as observability. `<Return>` selects the value at its position
 * and the body continues past it.
 */
function* runValueRoot(
  root: ComponentDefinition,
  returns: ReturnsSchema,
  validatedProps: Record<string, Json>,
  counter: BlockCounter,
  /** What this root emitted, held by the caller so a failure still finds it. */
  chunks: string[],
  path: string,
): Operation<DocumentResult> {
  let produced: { value: Json } | undefined;

  yield* scoped(function* () {
    yield* Component.around(
      {
        *raise([error], _next) {
          throw yield* documentationError(error, "throw");
        },
      },
      { at: "min" },
    );

    for (const segment of root.bodySegments) {
      if (isTopLevelReturn(segment)) {
        produced = { value: yield* resolveReturnValue("__root__", returns, segment) };
        continue;
      }
      const expanded = yield* expandSegments(
        [segment],
        root.meta,
        validatedProps,
        new Set(),
        counter,
        undefined,
        path,
      );
      for (const resolved of expanded) {
        const text = renderSegment(resolved);
        if (text) {
          yield* ephemeral(DocumentOutput.operations.output(text));
          chunks.push(text);
        }
      }
    }
  });

  if (!produced) {
    throw new Error("The root document declares `returns` but produced no <Return> value.");
  }
  return { status: "ok", output: chunks.join(""), value: produced.value };
}

function* documentWorkflow(props: Record<string, Json>): Workflow<DocumentResult> {
  // Import root — same pipeline as any component. The provider middleware
  // installed by execute maps "__root__" to the run's root document source.
  // The ephemeral() wrapper bridges typing only — the import inside remains a
  // durable, journaled operation.
  const root = yield* ephemeral(importComponent("__root__"));

  if (root.kind === "function") {
    throw new Error("Root document must be a markdown file, not a function component");
  }

  const validatedProps = yield* ephemeral(validateProps("__root__", props, root.props));

  const rootEnv: EvalEnv = propsEnvironment(validatedProps);
  liveEnvironment(rootEnv);

  // Per-root-segment emission loop (spec §9).
  // Mutable counter preserves deterministic blockIds across
  // per-segment expansion calls (see spec §6.1).
  const counter = createBlockCounter();

  // What the document rendered before it stopped, held outside the expansion
  // scope so a failure still leaves it here (§6.9 Partial output). The buffered
  // root fills `selected`; every streaming root has already emitted `streamed`.
  const selected: Segment[] = [];
  const streamed: string[] = [];
  const produced: Segment[] = [];
  let emittedThrough = 0;

  // The root binding environment is installed as scope-local middleware
  // around the entire loop so all segments share it. Resources spawned by
  // `persist` blocks are retained in the eval scope until expansion
  // completes, then torn down.
  // No frame for the root document itself: every element the root's body holds
  // carries that document's path in its own source position, so two roots are
  // already two identities. A frame here would add nothing an assertion could
  // ever observe (§5.6).
  const rootPath = "";

  const scopedExpansion: Operation<DocumentResult> = scoped(function* () {
    yield* Component.around({ env: () => rootEnv }, { at: "min" });
    // Structural preflight (spec §6.9, §6.10): a structurally invalid root
    // executes no body side effects. A text root renders the aggregate
    // printed error as a comment (root error mode is "print"); a value root has no
    // rendered result to fall back on, so the printed error fails the execution.
    const structureError = validateBodyStructure(root.bodySegments, root.returns);
    if (structureError) {
      if (root.returns !== undefined) {
        throw new Error(structureError.message);
      }
      const text = renderSegment(structureError);
      yield* ephemeral(DocumentOutput.operations.output(text));
      streamed.push(text);
      return { status: "ok", output: text, value: text };
    }

    if (root.returns !== undefined) {
      return yield* runValueRoot(root, root.returns, validatedProps, counter, streamed, rootPath);
    }

    // A root declaring top-level <Output> buffers completely (spec §5.4):
    // execute the whole body, then emit the selected regions once. The owner is
    // allocated outside this expansion so that a failure partway still leaves
    // this frame holding what the regions rendered before it.
    if (bodyHasOutput(root.bodySegments)) {
      yield* expandBody(
        root.bodySegments,
        [],
        root.meta,
        validatedProps,
        new Set(),
        counter,
        undefined,
        undefined,
        selected,
        rootPath,
      );
      const text = selected.map(renderSegment).join("");
      // An empty buffered root emits no output event.
      if (text) {
        yield* ephemeral(DocumentOutput.operations.output(text));
      }
      return { status: "ok", output: text, value: text };
    }

    // Per-root-segment emission loop for roots without <Output> (spec §5.4).
    // The loop owns the segments, so a component whose own region fails partway
    // has still handed over what it rendered — the root emits that before the
    // failure is reported, exactly as a buffered root does.
    for (const segment of root.bodySegments) {
      yield* expandSegments(
        [segment],
        root.meta,
        validatedProps,
        new Set(),
        counter,
        produced,
        rootPath,
      );

      while (emittedThrough < produced.length) {
        const resolved = produced[emittedThrough];
        emittedThrough += 1;
        const text = resolved === undefined ? "" : renderSegment(resolved);
        if (text) {
          // Emit through the Document Output Api (spec §9).
          // ephemeral() bridges from Workflow (durable) to Operation
          // (non-durable) — output emission is a derived side effect,
          // not journaled.
          yield* ephemeral(DocumentOutput.operations.output(text));
          streamed.push(text);
        }
      }
    }

    const text = streamed.join("");
    return { status: "ok", output: text, value: text };
  });

  // The catch is outside the `yield*`, not inside the scope: the expansion's
  // teardown — the invocation being dismantled, retained work, and whatever
  // aggregate the platform builds from a body failure and a teardown failure
  // together — finishes as this returns. Describing the failure any earlier
  // would describe an error whose account of itself is not complete yet.
  try {
    return yield* ephemeral(scopedExpansion);
  } catch (error) {
    // What the failing segment handed over but never reached the emission step.
    // Emitted here whatever the failure turns out to be: a consumer reading
    // chunks is who the preservation is for, and the completion path only emits
    // for a run that streamed nothing at all — which stops being true as soon
    // as an earlier segment went out.
    const tail = produced.slice(emittedThrough).map(renderSegment).join("");
    if (tail) {
      yield* ephemeral(DocumentOutput.operations.output(tail));
    }
    // A durability failure is not something the document did, so it never
    // becomes the document's own outcome (§6.11).
    if (durabilityFailure(error) !== undefined) {
      throw error;
    }
    const documentation = documentationFailure(error);
    if (documentation === undefined) {
      throw error;
    }
    // Everything the document rendered: the buffered selection, or what the
    // streaming loop emitted together with that tail.
    const rendered =
      selected.length > 0 ? selected.map(renderSegment).join("") : streamed.join("") + tail;
    yield* ephemeral(rememberLiveFailure(error));
    return { status: "err", output: rendered, error: describeFailure(error, documentation) };
  }
}

/**
 * A running document execution.
 *
 * `yield* execution` waits for completion and returns a `Result<Json>`:
 * `Ok(value)` on success, `Err(error)` on document, infrastructure, or
 * middleware failure. Completion never throws once the handle exists. The
 * successful value is the document's return value — its rendered Markdown for
 * a text root, the validated JSON for a root declaring `returns` (§5.4).
 *
 * `execution.output` is a `Stream<string, string>` for consuming chunks as
 * they arrive. It carries rendered body text for both kinds of root — for a
 * value root it is observability, never the result. The close value is the
 * complete rendered output, or the partial output rendered before a failure.
 */
export interface DocumentExecution extends Operation<Result<Json>> {
  /** Stream of output chunks. Close value is the full (or partial) output. */
  output: Stream<string, string>;
}

/**
 * Execute a markdown document as a durable workflow.
 *
 * Returns a `DocumentExecution` — an operation you can `yield*` for the
 * completion `Result<Json>`, with a `.output` stream for chunk-by-chunk
 * consumption. Once the handle exists, completion never throws: every
 * later failure — document, infrastructure, or middleware — closes
 * `output` (with the complete or partial rendered text) and resolves
 * `Err(error)`.
 *
 * Simple — get the outcome:
 *
 * ```ts
 * const execution = yield* execute(options);
 * const result = yield* execution;
 * if (result.ok) {
 *   console.log(result.value);
 * }
 * ```
 *
 * Streaming — consume chunks as they arrive:
 *
 * ```ts
 * const execution = yield* execute(options);
 * const output = yield* forEach(function* (chunk) {
 *   process.stdout.write(chunk);
 * }, execution.output);
 * ```
 */
function* executeDocument(
  options: ExecuteOptions,
  admissions: readonly JournalAdmission[] = [],
  completions: readonly CompletionFailure[] = [],
): Operation<DocumentExecution> {
  const {
    stream,
    props = {},
    componentDirs = [...DEFAULT_COMPONENT_DIRS],
    modifiers: customModifiers = {},
    secretDetection,
  } = options;

  // Carried through exactly as supplied. Rewriting an identity here would let
  // the same value inspect and execute under different ones.
  const root: RootDocumentSource = options;

  // Build modifier registry — pure data, no scope side effects.
  const registry = createModifierRegistry();
  registry.set("exec", execFactory);
  registry.set("silent", silentFactory);
  registry.set("eval", evalFactory);
  registry.set("persist", persistFactory);
  registry.set("timeout", timeoutFactory);
  registry.set("daemon", daemonFactory);
  registry.set("ephemeral", ephemeralFactory);
  registry.set("service", serviceFactory);
  for (const [name, handler] of Object.entries(customModifiers)) {
    registry.set(name, handler);
  }

  // Replay-safe transport: late subscribers receive every chunk and the
  // close value, so subscription readiness before first emission is never
  // required (spec §9; see replay-stream.ts).
  const channel = createReplayStream<string, string>();
  const { operation, resolve } = withResolvers<Result<Json>>();

  yield* spawn(function* () {
    let emitted = false;
    let emittedText = "";

    // The ENTIRE setup and workflow sit inside one error boundary: once the
    // handle exists, any failure closes output (with whatever rendered so
    // far) and resolves Err — completion never throws.
    try {
      // No compiler is installed here. Which one suits the host is the
      // entrypoint's decision, and installing one from inside this task would
      // shadow whatever the caller installed outside it. A document with no
      // eval blocks never reaches API.Env.compile at all.

      // DocumentOutput → channel bridge (innermost middleware — output flows
      // through caller-installed normalize/terminal middleware first, then here).
      yield* DocumentOutput.around({
        *output([text]) {
          emitted = true;
          emittedText += text;
          yield* channel.send(text);
        },
      });

      // The discard provider is the base so an attached-service observer can
      // authenticate and forward its own process output without unsilencing
      // unrelated document subprocesses.
      yield* Stdio.around(
        {
          *stdout() {},
          *stderr() {},
        },
        { at: "min" },
      );

      // The state this run owns: the table its printed errors record their
      // causes in, the schema compilers, and the slot its completion reads its
      // failure from. All created here and reclaimed with this task, so nothing
      // a run decided outlives it.
      yield* useSegmentCauses();
      yield* usePropsCompiler();
      yield* useParseCompiler();
      const liveFailure: LiveFailureSlot = {};
      yield* LiveFailure.set(liveFailure);

      // Create per-document eval scope (spec §3.1).
      // Created in the same scope as durableRun so that DurableContext
      // (set by durableRun) is visible to eval code that calls
      // renderChildren → importComponent → createDurableOperation.
      const rootEvalScope = yield* useEvalScope();

      // Install the document's runtime Component providers before durableRun
      // so the workflow inherits them: component import, modifier execution,
      // and the root eval scope.
      yield* Component.around(
        {
          *importComponent([name], _next) {
            // Read per import, in the invoking scope, so a component registered
            // by a nested scope is visible to what that scope expands.
            const registered = yield* Component.operations.registry;
            return yield* durableImportComponent(
              name,
              name === "__root__" ? root : undefined,
              componentDirs,
              registered,
            );
          },
          *applyModifiers([modifiers, context], _next) {
            const chain = composeModifierChain(modifiers, context, registry);
            return yield* chain();
          },
          evalScope: () => rootEvalScope,
        },
        { at: "min" },
      );

      // The policy is selected here — before the durable run and before any
      // document, frontmatter, prop, component, or eval code exists — so the
      // root component import is already behind the gate. What comes back is
      // the stream to journal through; the policy itself stays inside the
      // execution that owns it.
      const journal = yield* useSecretDetection(secretDetection, stream);

      // The journal is wrapped before it reaches `durableRun`, so the identity
      // check happens inside the read that every phase downstream depends on
      // rather than in middleware anything could replace.
      const returned = yield* durableRun(() => Execution.operations.document(props), {
        stream: guardedJournal(journal, root, ROOT_COROUTINE, admissions),
      });
      // Taken rather than read, so the handoff belongs to the run that made it.
      const live = yield* takeLiveFailure(liveFailure);
      const result = parseDocumentResult(returned);

      // Preserve output for any completion path that did not emit through the
      // streaming API — a replayed run restores its body text from the journal
      // instead of re-executing, and callback consumers only ever see chunks,
      // never the close value. A failed document takes the same path, so what
      // it rendered first reaches consumers before its failure does.
      if (!emitted && result.output) {
        yield* DocumentOutput.operations.output(result.output);
      }

      yield* channel.close(result.output);
      if (result.status === "err") {
        const failure = failureError(result.error, live);
        resolve(Err(failure instanceof Error ? failure : new Error(String(failure))));
        return;
      }
      resolve(settleCompletion(Ok(result.value), completions));
    } catch (error) {
      // Close with everything already emitted — printed errors produced before
      // an abort stay visible to consumers of the close value.
      yield* channel.close(emittedText);
      resolve(Err(error instanceof Error ? error : new Error(String(error))));
    }
  });

  return {
    *[Symbol.iterator]() {
      return yield* operation;
    },
    output: channel,
  };
}

/**
 * What an installation requires of the retained history, decided inside the
 * execution's own journal read.
 *
 * Refusal-only: it throws or it returns. It is handed the exact retained
 * snapshot and hands nothing back, so it cannot substitute a history, and it
 * never receives a `next` to decline.
 */
export type JournalAdmission = (retained: readonly DurableEvent[]) => Operation<void>;

/**
 * What a trusted host attaches to one execution.
 *
 * `install` runs contextual behavior the document inherits. `admissions` is
 * copied by canonical execution *before* `install` runs, so nothing an
 * installation does afterwards — including anything it composes — can add to,
 * remove from or observe the collection that ends up authoritative.
 */
export interface ExecutionInstallation {
  readonly admissions?: readonly JournalAdmission[];
  install?(): Operation<void>;
}

/**
 * Execution Api — a policy surface around document execution.
 *
 * A handler is given an `ExecutionRequest`, not the execution. It may inspect
 * the options, narrow or replace them with `withOptions()`, register an
 * additive completion failure, install contextual behavior the document will
 * inherit, refuse by throwing, and delegate. It returns nothing, and whatever
 * it returns is ignored: only canonical execution completes a document.
 */
export interface ExecutionApi {
  execute(request: ExecutionRequest): Operation<void>;
  /**
   * The document's expansion, as `durableRun` runs it.
   *
   * A layer here wraps the whole document while the durable stream is still
   * live and before the root Close is written — the only place work that has to
   * outlast every element but still be journaled can go.
   */
  document(props: Record<string, Json>): Operation<DocumentResult>;
}

/**
 * The canonical terminal.
 *
 * It records what the chain settled on and consumes the request. It does not
 * run the document: that happens after the chain unwinds, in the invocation
 * that issued the request, which is what keeps a handler from completing an
 * execution by answering instead of delegating.
 */
export const Execution: Api<ExecutionApi> = createApi<ExecutionApi>("Execution", {
  // deno-lint-ignore require-yield
  *execute(request: ExecutionRequest): Operation<void> {
    consumeAtTerminal(request);
  },
  *document(props: Record<string, Json>): Operation<DocumentResult> {
    return yield* documentWorkflow(props);
  },
});

/**
 * Run one document execution, authoritatively.
 *
 * The order is the contract. Admissions are copied and frozen first, so what
 * ends up authoritative is fixed before any installation, any middleware and
 * any document code exists. Installations then run, then the chain is invoked
 * with one opaque request, then the request must have reached the terminal
 * exactly once, and only then does canonical core execute the document with the
 * options the terminal recorded.
 */
function* runInvocation(
  options: ExecuteOptions,
  installations: readonly ExecutionInstallation[],
): Operation<DocumentExecution> {
  const admissions = Object.freeze(
    installations.flatMap((installation) => [...(installation.admissions ?? [])]),
  );

  for (const installation of installations) {
    if (installation.install) {
      yield* installation.install();
    }
  }

  const issued = issueExecution(options);
  // Whatever a handler returns is not an execution, so it is not read.
  yield* Execution.operations.execute(issued.request);

  return yield* executeDocument(issued.settle(), admissions, issued.completions());
}

/** The ordinary entrypoint: one execution, nothing installed around it. */
export function execute(options: ExecuteOptions): Operation<DocumentExecution> {
  return runInvocation(options, []);
}

/**
 * The trusted-host entrypoint.
 *
 * Reached through `@executablemd/core/host`, because attaching an admission is
 * infrastructure rather than authoring: the value crosses as a function the
 * host holds and passes, so a separately loaded workflow package composes by
 * handing its closure over rather than by agreeing on a name.
 */
export function executeInstalled(
  options: ExecuteOptions,
  installations: readonly ExecutionInstallation[],
): Operation<DocumentExecution> {
  return runInvocation(options, [...installations]);
}

/**
 * Apply every additive completion policy, in registration order.
 *
 * Additive means one direction only: the first policy that reports a failure
 * turns a success into that failure, and nothing after it can turn a failure
 * back into a success or replace it with a different one.
 */
function settleCompletion(
  result: Result<Json>,
  completions: readonly CompletionFailure[],
): Result<Json> {
  let settled = result;
  for (const completion of completions) {
    if (!settled.ok) {
      return settled;
    }
    const failure = completion();
    if (failure !== undefined) {
      settled = Err(failure);
    }
  }
  return settled;
}
