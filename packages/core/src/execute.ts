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

import { Err, Ok, ensure, scoped, spawn, withResolvers, until } from "effection";
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
import { API, readTextFile, cwd, timeoutExec } from "@executablemd/runtime";
import type { ProcessOutcome } from "@executablemd/runtime";
import { cwd as processCwd } from "@effectionx/fs";
import type { Workflow, Json } from "@executablemd/durable-streams";
import { createReplayStream } from "./replay-stream.ts";
import { ExecutionProtocolError, issueExecution } from "./execution-request.ts";
import { DocumentProtocolError, issueDocument } from "./document-request.ts";
import { claimBoundExec } from "./bound-exec.ts";
import type { DocumentSettlement, IssuedDocument } from "./document-request.ts";
import type { DocumentRequest, DurablePreparation } from "./document-request.ts";
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
  SourcePosition,
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
  ErrorMode,
  filesFatalFailure,
  useSegmentCauses,
} from "./errors.ts";
import { Component, importComponent, raise } from "./component-api.ts";
import { sourceDescription } from "./source-position.ts";
import { renderSegment } from "./render.ts";
import { DocumentOutput } from "./api.ts";
import {
  composeBoundExecChain,
  composeModifierChain,
  buildCommand,
  createModifierRegistry,
  useCodeBlock,
} from "./modifiers.ts";
import type { BoundExecChain, CodeBlockWorkflow, ModifierFactory } from "./modifiers.ts";
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
import { installedBundle } from "./components/bundle.ts";
import type { WorkflowComponentBundle, WorkflowImportAuthority } from "./components/bundle.ts";
import type { CodeBlockContext, CodeBlockResult, EvalEnv } from "./types.ts";
import { readRootSource, rootSourcePath } from "./root-source.ts";
import type { RootDocumentSource } from "./root-source.ts";
import { useEvalScope } from "@effectionx/scope-eval";
import { declaredRouting, FOREGROUND, route, withRouting } from "./foreground.ts";
import type { ForegroundRouting } from "./foreground.ts";
import { checkedFailureLedger } from "./component-failures.ts";
import type { CheckedFailures } from "./component-failures.ts";
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

  /**
   * Retain each foreground command's stdout and stderr in its durable record.
   *
   * Defaults to `true`, so a caller that hands over a durable stream keeps the
   * record it has always had. A host that wants no diagnostic record — the CLI
   * without `--journal` — passes `false`, and the run then keeps exit status
   * alone and never accumulates the bytes on their way to the reader (#441).
   */
  retainProcessOutput?: boolean;
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
  | { kind: "registered"; origin: string; reserved: boolean }
  /**
   * A component the workflow definition is closed over.
   *
   * The exact pinned source is retained, as a repository selection retains what
   * it read, so a replay reconstructs the component from the record instead of
   * resolving a name again. `path` is the canonical repository-relative path of
   * the blob, never the declaration a root document wrote, and the hash is the
   * blob's own object id — which is what a trusted host verifies the retained
   * selection against before any of it is replayed.
   */
  | { kind: "workflow"; path: string; sourceHash: string; content: string };

/**
 * What a recorded import decided, read as a closed protocol.
 *
 * Journal data, so it is parsed rather than asserted: every variant declares
 * exactly its own members, an unknown kind is malformed rather than absent, and
 * a value that will not be read — an accessor that throws, a proxy that traps —
 * is malformed too. Nothing it holds reaches a diagnostic.
 */
function readDurableSelection(value: unknown): DurableSelection | undefined {
  const record = attempt(() => parseJson(value));
  if (record === undefined || !isJsonObject(record)) {
    return undefined;
  }
  const members = Object.keys(record).length;
  const kind = record["kind"];

  if (kind === "registered") {
    const origin = record["origin"];
    const reserved = record["reserved"];
    if (members !== 3 || typeof origin !== "string" || typeof reserved !== "boolean") {
      return undefined;
    }
    return { kind: "registered", origin, reserved };
  }

  const path = record["path"];
  const content = record["content"];
  if (typeof path !== "string" || typeof content !== "string") {
    return undefined;
  }

  if (kind === "workflow") {
    const sourceHash = record["sourceHash"];
    if (members !== 4 || typeof sourceHash !== "string") {
      return undefined;
    }
    return { kind: "workflow", path, sourceHash, content };
  }

  if (kind === "repository") {
    const target = record["target"];
    if (target === undefined) {
      return members === 3 ? { kind: "repository", path, content } : undefined;
    }
    if (members !== 4 || typeof target !== "string" || !isCanonicalTarget(target)) {
      return undefined;
    }
    return { kind: "repository", path, content, target };
  }

  if (kind === "target-failure") {
    const failure = recordedDocumentTargetFailure(record["failure"]);
    if (members !== 4 || failure === undefined) {
      return undefined;
    }
    return {
      kind: "target-failure",
      path,
      content,
      failure: {
        kind: failure.kind,
        selector: failure.selector,
        matches: [...failure.matches],
        available: [...failure.available],
      },
    };
  }

  return undefined;
}

/**
 * What a resumed run says when a recorded component import cannot be read.
 *
 * Fixed: the record is journal data, and describing what it holds would put
 * whatever a hostile history planted into a diagnostic.
 */
const UNREADABLE_IMPORT_RECORD = "A recorded component import cannot be read by this version.";

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
  position: Readonly<SourcePosition> | undefined,
  bundle: WorkflowImportAuthority | undefined,
): Workflow<ComponentDefinition | FunctionComponentDefinition> {
  const recorded = yield createDurableOperation<DurableSelection>(
    // The root import is the run's own entry rather than an authored element,
    // so it carries no source however it was reached.
    { type: "import_component", name, ...(root ? {} : sourceDescription(position)) },
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

      const selected = yield* selectComponent(name, {
        componentDirs: searchPaths,
        registry,
        ...(bundle === undefined ? {} : { workflow: bundle }),
      });

      switch (selected.kind) {
        case "repository":
          return {
            kind: "repository",
            path: selected.path,
            content: yield* readTextFile(selected.path),
          };
        case "workflow":
          // The exact pinned source, already in hand: the bundle was read from
          // the definition's own commit before this run existed, so recording it
          // reads nothing and a replay reconstructs it without resolving a name.
          return {
            kind: "workflow",
            path: selected.path,
            sourceHash: selected.sourceHash,
            content: selected.content,
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
  );

  // Parsed rather than asserted: a replay hands back whatever the journal holds,
  // and a history somebody else wrote is not a `DurableSelection` because it
  // type-checked on the way in.
  const selection = readDurableSelection(recorded);
  if (selection === undefined) {
    throw new Error(name === "__root__" ? UNREADABLE_ROOT_RECORD : UNREADABLE_IMPORT_RECORD);
  }

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

  if (selection.kind === "workflow") {
    // Reconstructed from the record's own source. Selection already decided
    // this name, and a bundled component is Markdown by construction, so
    // nothing here reads a file or imports a module.
    return yield* ephemeral(parseMarkdownDefinition(name, selection.path, selection.content));
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
/**
 * What a resumed run says when the history it was handed failed before
 * importing a root document, and that document was not this one.
 *
 * Fixed, like the unreadable-record diagnostic beside it: what the record names
 * is journal data, and naming it back would put it into a message.
 */
const DIFFERENT_PRE_ROOT_DOCUMENT =
  "The recorded run failed before importing its root document, and it recorded a " +
  "different root document than this one.";

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
      // Frozen before anyone is offered it, and offered to everyone. `readonly`
      // is a compile-time claim: without this an admission could splice, reorder
      // or empty the history in place, and every later admission, root-history
      // validation and the replay itself would consume what it left behind.
      // The events themselves are the retained graph's own, already sealed.
      const retained: readonly DurableEvent[] = Object.freeze(
        retainEvents(yield* stream.readAll()),
      );
      // What the trusted host required of this history, on that exact snapshot,
      // in the order it was captured and stopping at the first refusal. Ahead of
      // root-history admission, ReplayGuard, terminal reuse, authored work and
      // any append.
      for (const admission of admissions) {
        yield* admission(retained);
      }
      admitRootHistory(retained, root, coroutineId);
      // The same objects the admissions were held to. `readAll` is declared
      // mutable by the protocol, so this is a fresh array over the identical
      // sealed events rather than a second reading of the backend.
      return [...retained];
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
    if (imports.length === 0) {
      // No import at all. The one history this describes rather than
      // contradicts is one whose terminal core wrote before importing anything,
      // and said so.
      admitPreRootTerminal(retained, root, coroutineId);
    } else if (imports.length !== 1 || owned.length !== 1) {
      throw new Error(UNREADABLE_ROOT_RECORD);
    }
  }

  for (const event of imports) {
    admitRootSelection(event, root);
  }
}

/**
 * The member a terminal recorded before the root import carries.
 *
 * A run can fail before it has imported anything — a document handler that
 * refuses, a protocol violation, a preparation that will not prepare. The
 * durable root still records that outcome, and the history it leaves behind has
 * a terminal and no root import. Without something in that terminal saying
 * which document it was about, the only safe answer on replay is to refuse it,
 * which is what made a journal canonical core had just written unreadable to
 * the identical execution.
 *
 * So core writes the identity into the terminal it creates. It is core's own:
 * the value is built here, from the root source this execution was given, and
 * parsed here on the way back in. Nothing a host, a document or a middleware
 * package supplies reaches it, and a terminal that does not carry one stays
 * exactly as unreusable as it was.
 */
const ROOT_BINDING = "root_binding";

/** Which root document a pre-root terminal was about. */
interface RootBinding {
  readonly path: string;
  /**
   * The supplied text for an inline root, and nothing for a file root.
   *
   * Every inline root reports the same path, so the path alone would let one
   * supplied document reuse a terminal another one recorded. The text is the
   * identity there, and the journal already keeps it for any run that got as
   * far as importing.
   */
  readonly source: string | null;
  /** The requested selector as written, or nothing when the whole document. */
  readonly target: string | null;
}

function rootBinding(root: RootDocumentSource): RootBinding {
  return {
    path: rootSourcePath(root),
    source: root.source ?? null,
    target: root.target ?? null,
  };
}

/** The own enumerable keys of a journal value, in a fixed order, or nothing. */
function recordedKeys(value: object): string | undefined {
  const keys = read(() => Object.keys(value).sort().join(","));
  return typeof keys === "string" ? keys : undefined;
}

/** A recorded member, read once through the refusal-tolerant boundary. */
function recordedMember(value: object, name: string): unknown {
  const member: unknown = read(() => Reflect.get(value, name));
  return member === UNREADABLE ? undefined : member;
}

/** A recorded value that is an object, or nothing. */
function recordedObject(value: unknown): object | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

/**
 * The complete terminal canonical core writes when it fails before importing a
 * root document, parsed, or nothing.
 *
 * A binding on its own establishes nothing. Core can only reach this lifecycle
 * position by failing, so the only history it can have written here is a
 * *failed* document result carrying a binding — and a recorded success that
 * carries a copied binding is a record core could not have produced. Parsing
 * the whole form is what tells those apart, so every member of it is checked,
 * exactly, including the ones this run has no other use for.
 *
 * Total over journal-provided values: a member that refuses to be read, a wrong
 * type and an extra member are each "not this form" rather than an error of
 * their own, and "not this form" is refused by the caller.
 */
function recordedPreRootTerminal(event: DurableEvent): RootBinding | undefined {
  const settlement = recordedObject(read(() => event.result));
  if (settlement === undefined || recordedKeys(settlement) !== "status,value") {
    return undefined;
  }
  // The outer settlement is `ok`: the body *returned* this record rather than
  // throwing it, which is the whole mechanism that makes it replayable.
  if (recordedMember(settlement, "status") !== "ok") {
    return undefined;
  }
  const result = recordedObject(recordedMember(settlement, "value"));
  if (result === undefined || recordedKeys(result) !== "error,output,root_binding,status") {
    return undefined;
  }
  // Never "ok". Canonical core arrives here only by failing.
  if (recordedMember(result, "status") !== "err") {
    return undefined;
  }
  if (recordedMember(result, "output") !== "") {
    return undefined;
  }
  if (!recordedPreRootFailure(recordedObject(recordedMember(result, "error")))) {
    return undefined;
  }
  return recordedBinding(recordedObject(recordedMember(result, ROOT_BINDING)));
}

/** Whether a recorded failure is the shape a pre-root terminal describes. */
function recordedPreRootFailure(failure: object | undefined): boolean {
  if (failure === undefined) {
    return false;
  }
  const keys = recordedKeys(failure);
  if (keys !== "message,name,segment" && keys !== "cause,message,name,segment") {
    return false;
  }
  if (typeof recordedMember(failure, "name") !== "string") {
    return false;
  }
  if (typeof recordedMember(failure, "message") !== "string") {
    return false;
  }
  if (keys.startsWith("cause") && typeof recordedMember(failure, "cause") !== "string") {
    return false;
  }
  const segment = recordedObject(recordedMember(failure, "segment"));
  if (segment === undefined || recordedKeys(segment) !== "message") {
    return false;
  }
  // Nothing was imported, so no segment failed and the description core writes
  // repeats the failure's own message in both places. A record whose two
  // messages disagree is one core could not have written, whatever else about
  // it looks well formed.
  return recordedMember(segment, "message") === recordedMember(failure, "message");
}

/** The binding a recorded pre-root terminal carries, or nothing. */
function recordedBinding(carried: object | undefined): RootBinding | undefined {
  if (carried === undefined || recordedKeys(carried) !== "path,source,target") {
    return undefined;
  }
  const path: unknown = recordedMember(carried, "path");
  const source: unknown = recordedMember(carried, "source");
  const target: unknown = recordedMember(carried, "target");
  if (typeof path !== "string") {
    return undefined;
  }
  if (source !== null && typeof source !== "string") {
    return undefined;
  }
  if (target !== null && typeof target !== "string") {
    return undefined;
  }
  return { path, source, target };
}

/**
 * The name and message a pre-root failure is recorded under when the failure
 * itself will not say.
 *
 * Fixed and core-owned. A failure raised before the root import is whatever a
 * handler or a preparation threw, which is to say: anything. It may be a
 * `Proxy` whose `Symbol.toPrimitive` throws, an `Error` subclass whose `message`
 * accessor refuses, or a value that is not an error at all. None of that may
 * decide whether this run can record a replayable terminal.
 */
const UNDESCRIBED_PRE_ROOT_NAME = "Error";
const UNDESCRIBED_PRE_ROOT_MESSAGE =
  "The document execution failed before importing its root document, and the " +
  "failure could not be described.";

/**
 * A string a value will give up willingly, or nothing.
 *
 * Never coerces. `String(value)` is a call into whatever the value decides
 * `Symbol.toPrimitive` means, and a description step that can be made to throw
 * is a description step that stops a terminal from being written at all.
 */
function safeText(get: () => unknown): string | undefined {
  const value = read(get);
  return typeof value === "string" ? value : undefined;
}

/**
 * Describe a failure raised before the root import, whatever it turns out to be.
 *
 * Total: every read goes through the same refusal-tolerant boundary the journal
 * protocol uses, and a member that will not be read is simply absent. What comes
 * out is JSON this run wrote, never a value the failure supplied — so nothing
 * planted in a trap reaches the journal, the diagnostic, or a later replay.
 */
function describePreRootFailure(error: unknown): DocumentFailure {
  const name = safeText(() => (error instanceof Error ? error.name : undefined));
  const message = safeText(() => (error instanceof Error ? error.message : undefined));
  const described = message ?? UNDESCRIBED_PRE_ROOT_MESSAGE;
  // A cause is recorded only when it hands over a string of its own accord.
  // There is no fallback: an absent cause and an unreadable one are the same
  // fact here, which is that this run has nothing to say about it.
  const cause = safeText(() =>
    error instanceof Error && Object.hasOwn(error, "cause") && error.cause instanceof Error
      ? error.cause.message
      : undefined,
  );
  return {
    name: name ?? UNDESCRIBED_PRE_ROOT_NAME,
    message: described,
    // Nothing was imported, so no segment failed and none is described. The
    // failure speaks for itself, as far as it will speak at all.
    segment: { message: described },
    ...(cause === undefined ? {} : { cause }),
  };
}

/**
 * What this run records when it fails before importing its root document.
 *
 * Returned rather than thrown, so the durable root closes around it and an
 * identical replay reads the same failure back instead of re-running policy
 * that already refused. A live run still reports the original object when that
 * object is an ordinary `Error` — the failure is remembered before this is
 * built — so nothing about identity changes for the execution that produced it.
 */
function preRootTerminal(
  error: unknown,
  root: RootDocumentSource,
): DocumentFailureResult & { readonly [ROOT_BINDING]: RootBinding } {
  return {
    status: "err",
    output: "",
    error: describePreRootFailure(error),
    [ROOT_BINDING]: rootBinding(root),
  };
}

/**
 * Admit a history whose terminal was created before any root import.
 *
 * Fails closed in every direction. The history must hold exactly one recorded
 * completion, it must be this coroutine's, it must carry a binding core wrote,
 * and that binding must name the document this run was asked for. A terminal
 * that merely *is* terminal establishes nothing — which is the point: an
 * arbitrary recorded failure does not become reusable by having no import.
 */
function admitPreRootTerminal(
  retained: readonly DurableEvent[],
  root: RootDocumentSource,
  coroutineId: CoroutineId,
): void {
  const closes = retained.filter((event) => attempt(() => event.type) === "close");
  if (closes.length !== 1) {
    throw new Error(UNREADABLE_ROOT_RECORD);
  }
  const close = closes[0];
  if (close === undefined || attempt(() => close.coroutineId) !== coroutineId) {
    throw new Error(UNREADABLE_ROOT_RECORD);
  }
  const recorded = recordedPreRootTerminal(close);
  if (recorded === undefined) {
    throw new Error(UNREADABLE_ROOT_RECORD);
  }
  const requested = rootBinding(root);
  if (
    recorded.path !== requested.path ||
    recorded.source !== requested.source ||
    recorded.target !== requested.target
  ) {
    throw new Error(DIFFERENT_PRE_ROOT_DOCUMENT);
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

/**
 * The exec terminal for one execution.
 *
 * `retainProcessOutput` is the trusted host's accepted choice and is captured
 * here by value. It decides what reaches durable storage and therefore what
 * crosses the secret gate, so it is not contextual state: no public middleware
 * and no separately loaded same-name Context can turn a journal's record off,
 * or make a run that asked for no record start keeping one. Routing stays
 * lexical and composable, because routing decides only what a reader sees.
 */
function createExecFactory(retainProcessOutput: boolean): ModifierFactory {
  return (_params) => (_args, _next) =>
    (function* () {
      // An ordinary block reads its context through the public operation, so
      // `codeBlock` middleware composes here exactly as it always has.
      const context = yield* useCodeBlock();
      return yield* execTerminal(retainProcessOutput, context, false);
    })();
}

/**
 * Run one command and report what it settled to.
 *
 * The context is an argument rather than something read back from the scope:
 * a bound command is executed against the context canonical core retained, so
 * public `codeBlock` middleware cannot change which command runs, weaken the
 * routing that keeps its channels off the reader's terminal, or decide whether
 * this execution is bound at all. `bound` is the same fact, held the same way —
 * it is what canonical core knew when it composed the chain, and it appears
 * nowhere a handler could add or remove it.
 */
function* execTerminal(
  retainProcessOutput: boolean,
  context: CodeBlockContext,
  bound: boolean,
): CodeBlockWorkflow {
  {
    {
      const command = buildCommand(context.language, context.content);
      // Resolved here, where the block is, and handed to the Process operation
      // explicitly: an enclosing `timeout=` has already made this its own value,
      // and the Process Api itself defaults to nothing (spec §Config).
      const timeout = yield* ephemeral(timeoutExec);
      // Where this block's output goes: a `<Capture as>` region decided that
      // lexically, and a modifier inside the chain may have narrowed it. A bound
      // block is not a display at all — its outcome is data the document reads —
      // so it shows neither channel and takes its region's routing from nothing.
      const selected = bound
        ? BINDING_ROUTING
        : ((yield* ephemeral(declaredRouting())) ?? context.routing ?? FOREGROUND);

      const captured = selected.stdout === "capture";
      let live = "";
      let liveStdout = "";
      let liveStderr = "";
      const result = (yield createDurableOperation<Json>(
        {
          type: "exec",
          name: `exec:${context.content.slice(0, 40).replace(/\n/g, " ")}`,
          command: command as unknown as Json,
          ...sourceDescription(context.position),
        },
        function* (): Operation<Json> {
          // Routing and retention are established before the child exists, so
          // startup chunks are treated like every other byte.
          const finished = yield* route(selected, retainProcessOutput, bound);
          // `retain: false`: this execution keeps what it decided to keep, on
          // the chain above, where silencing cannot hide it from a record.
          const execResult = yield* API.Process.operations.exec({
            command,
            cwd: yield* cwd(),
            timeout,
            retain: false,
          });
          const kept = finished();
          live = kept.captured;
          liveStdout = kept.boundStdout ?? "";
          liveStderr = kept.boundStderr ?? "";
          return {
            exitCode: execResult.exitCode,
            ...(kept.retainedStdout === undefined ? {} : { stdout: kept.retainedStdout }),
            ...(kept.retainedStderr === undefined ? {} : { stderr: kept.retainedStderr }),
          } as unknown as Json;
        },
      )) as unknown as ProcessOutcome;

      return {
        // A capture's binding comes from the record when there is one and from
        // the region's own live buffer when there is not. That is what lets a
        // journaled run resume: replay never runs the child, so the retained
        // stdout — and only stdout, never stderr — is the binding. Forwarded
        // bytes reached the reader already and are never rendered again.
        output: captured ? (result.stdout ?? live) : "",
        exitCode: result.exitCode,
        stderr: result.stderr ?? "",
        // The binding comes from the record when there is one and from this
        // block's own buffers when there is not, on the same terms a capture's
        // does — which is what lets a resumed run rebuild the outcome without
        // starting the command again. It is a fresh object every time: what
        // replay preserves is the field values.
        ...(bound
          ? {
              bound: {
                exitCode: result.exitCode,
                stdout: result.stdout ?? liveStdout,
                stderr: result.stderr ?? liveStderr,
              },
            }
          : {}),
      };
    }
  }
}

/** A bound block displays neither channel: its outcome is read, not shown. */
const BINDING_ROUTING: ForegroundRouting = { stdout: "hidden", stderr: "hidden" };

// `silent` suppresses output; it does not convert failure into success (#307).
// The outcome it hands back is the inner chain's, so a silenced command that
// failed is still a failure — carrying the exit code and the stderr that say
// so, with only the channel the author asked to hide removed.
const silentFactory: ModifierFactory = (_params) => (_args, next) =>
  (function* () {
    // Silence is a routing decision, so it is made before the child starts:
    // neither channel is displayed. What the run retains is the host's choice
    // and is unaffected — a journaled silent block still records its output.
    const result = yield* ephemeral(
      withRouting(
        { stdout: "hidden", stderr: "hidden" },
        () => next() as unknown as Operation<CodeBlockResult>,
      ),
    );
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
 * resolves a live object instead of this description (`LiveFailure`).
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
 * The error a completion reports for a failed document: the one this run put in
 * the slot, and otherwise the documented reconstruction of it.
 *
 * What goes in the slot is the caller of `rememberLiveFailure`'s decision, and
 * the two callers decide differently. A failure the document itself raised is
 * remembered as it is — it came from authored work this run was executing. A
 * failure raised *before* the root import came from public middleware or a
 * host's preparation, and what is remembered there is a value this run
 * constructed, never the object that came back.
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
  /** This run's record of an unauthorized checked command failure (#441). */
  checkedFailures: CheckedFailures,
  bundle: WorkflowImportAuthority | undefined,
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
        0,
        checkedFailures,
        bundle,
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

  yield* refuseCheckedFailure(checkedFailures);
  if (!produced) {
    throw new Error("The root document declares `returns` but produced no <Return> value.");
  }
  return { status: "ok", output: chunks.join(""), value: produced.value };
}

/**
 * Refuse a successful outcome for a run that suffered an unauthorized checked
 * command failure.
 *
 * The failure was already raised where the command ran, and something enclosing
 * it — a `printErrors(fn)` component like `<TempDir>`, or one that caught the
 * `ContentError` its projected content raised — printed it and returned. Those
 * boundaries decide how a failure of their own is reported. Whether a command
 * that exited nonzero failed the run is not theirs to decide, and this is where
 * the run says so (#441).
 */
function* refuseCheckedFailure(checkedFailures: CheckedFailures): Operation<void> {
  const segment = checkedFailures.failure;
  if (segment !== undefined) {
    throw yield* documentationError(segment, "output");
  }
}

function* documentWorkflow(
  props: Record<string, Json>,
  bundle: WorkflowImportAuthority | undefined,
): Workflow<DocumentResult> {
  // This run's memory of a checked command failure it never authorized. Passed
  // by value into core's own expansion and reachable from nowhere else, so no
  // document, component, or printing boundary can clear it (#441).
  const checkedFailures = checkedFailureLedger();
  // Import root — same pipeline as any component. The provider middleware
  // installed by execute maps "__root__" to the run's root document source.
  // The ephemeral() wrapper bridges typing only — the import inside remains a
  // durable, journaled operation.
  const root = yield* ephemeral(
    (function* (): Operation<ComponentDefinition | FunctionComponentDefinition> {
      const imported = yield* importComponent("__root__");
      return bundle === undefined ? imported : bundle.authorize("__root__", imported);
    })(),
  );

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
    // A text root is fail-capable. An undecided error no boundary handled is
    // the run's own outcome, and `<Output>` decides which regions render rather
    // than whether a failure counts. Installed before the structural preflight
    // and before either body branch, so a buffered root, a streaming root and
    // an invalid root all settle the same way. A value root keeps the `throw`
    // decision `runValueRoot` installs for itself.
    if (root.returns === undefined) {
      yield* ErrorMode.set("output");
    }
    // Structural preflight (spec §6.9, §6.10): a structurally invalid root
    // executes no body side effects. The aggregate is raised like any other
    // undecided error, so it is observed once and the root's own mode decides
    // it; a value root has no rendered result to fall back on at all.
    const structureError = validateBodyStructure(root.bodySegments, root.returns);
    if (structureError) {
      if (root.returns !== undefined) {
        throw new Error(structureError.message);
      }
      const text = renderSegment(yield* raise(structureError));
      yield* ephemeral(DocumentOutput.operations.output(text));
      streamed.push(text);
      return { status: "ok", output: text, value: text };
    }

    if (root.returns !== undefined) {
      // Each channel is forwarded on the operation it was received on. stdout
      // belongs to the result here, so a host that prints the result on its own
      // stdout shows a command's stdout on the stream it leaves free — that is
      // a decision about the host's streams, taken downstream of the per-exec
      // boundary, and it does not change the channel already retained.
      return yield* runValueRoot(
        root,
        root.returns as ReturnsSchema,
        validatedProps,
        counter,
        streamed,
        rootPath,
        checkedFailures,
        bundle,
      );
    }

    // A root declaring top-level <Output> selects what renders, and selecting
    // needs the whole body (spec §5.4): execute it, then emit the selected
    // regions once. The owner is allocated outside this expansion so that a
    // failure partway still leaves this frame holding what the regions rendered
    // before it. Which regions render is the only thing the declaration
    // decides; the root already fails on an undecided error without it.
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
        checkedFailures,
        bundle,
      );
      const text = selected.map(renderSegment).join("");
      // An empty buffered root emits no output event.
      if (text) {
        yield* ephemeral(DocumentOutput.operations.output(text));
      }
      yield* refuseCheckedFailure(checkedFailures);
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
        0,
        checkedFailures,
        bundle,
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
    yield* refuseCheckedFailure(checkedFailures);
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
  preparations: readonly DurablePreparation[] = [],
  bundles: readonly WorkflowComponentBundle[] = [],
): Operation<DocumentExecution> {
  const {
    stream,
    props = {},
    componentDirs = [...DEFAULT_COMPONENT_DIRS],
    modifiers: customModifiers = {},
    secretDetection,
    retainProcessOutput = true,
  } = options;

  // Carried through exactly as supplied. Rewriting an identity here would let
  // the same value inspect and execute under different ones.
  const root: RootDocumentSource = options;

  // Build modifier registry — pure data, no scope side effects.
  const registry = createModifierRegistry();
  // Held by identity as well as by name: a bound block is authorized against
  // these exact factories, so a modifier registered under either name is a
  // replacement rather than the middleware the binding contract names.
  const boundChain: BoundExecChain = {
    exec: createExecFactory(retainProcessOutput),
    timeout: timeoutFactory,
    terminal: (context) => execTerminal(retainProcessOutput, context, true),
  };
  registry.set("exec", boundChain.exec);
  registry.set("silent", silentFactory);
  registry.set("eval", evalFactory);
  registry.set("persist", persistFactory);
  registry.set("timeout", boundChain.timeout);
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

      // The bundle this execution is closed over, resolved against the
      // registrations it starts with. A name the engine, a core default, or a
      // reserved registration already owns is refused here — before the journal
      // is read, before the root document is imported, and before any component
      // runs — because a bundle that could take one back would change what a
      // document already written means.
      const bundle = installedBundle(bundles, yield* Component.operations.registry);

      // Install the document's runtime Component providers before durableRun
      // so the workflow inherits them: component import, modifier execution,
      // and the root eval scope.
      yield* Component.around(
        {
          *importComponent([name, position], _next) {
            // Read per import, in the invoking scope, so a component registered
            // by a nested scope is visible to what that scope expands.
            const registered = yield* Component.operations.registry;
            const definition = yield* durableImportComponent(
              name,
              name === "__root__" ? root : undefined,
              componentDirs,
              registered,
              position,
              bundle,
            );
            // The witness for this answer. It is issued where the answer is
            // produced and verified where it is invoked, so what a handler does
            // to the value in between is visible rather than authoritative.
            return bundle === undefined ? definition : bundle.issue(name, definition);
          },
          *applyModifiers([modifiers, context], _next) {
            const chain = composeModifierChain(modifiers, context, registry);
            return yield* chain();
          },
          // The terminal for one bound block: it composes against the context
          // that block was issued with, so what a handler delegated decides
          // nothing about what runs, and the outcome goes back to the issuing
          // expansion rather than through this operation's return value.
          *applyBoundModifiers([_modifiers, request], _next) {
            // The delegated array is inspectable data and nothing more: what
            // runs is the chain the request retained.
            yield* claimBoundExec(request, (authored, context) => {
              const chain = composeBoundExecChain(authored, context, registry, boundChain);
              return chain() as unknown as Operation<CodeBlockResult>;
            });
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
      const returned = yield* durableRun(
        function* (): Operation<DocumentResult> {
          const issued = issueDocument<DocumentResult>(props, (claimed) =>
            documentWorkflow(claimed, bundle),
          );
          try {
            return yield* beforeAnyImport(issued);
          } catch (error) {
            // Reaching the terminal means a root import was attempted, so the
            // history already carries one and this failure is the document's.
            if (issued.settlement().status !== "absent") {
              throw error;
            }
            // A durability failure says the journal no longer describes this
            // run, and a Files infrastructure failure is not this run's outcome
            // to record either. Both keep escaping, by identity.
            //
            // Asked through the same boundary as everything else here: the
            // search walks a cause graph with `instanceof` checks, and a value
            // that refuses to be walked is not thereby fatal. A refusal to
            // classify must not stop the bound terminal from being written.
            const fatal = read(() => fatalOf(error));
            if (fatal !== UNREADABLE && fatal !== undefined) {
              throw error;
            }
            // Remembered before it is described, so the live run still reports
            // the original object while the journal keeps a replayable account.
            // Nothing that came back through public middleware is published as
            // it stands.
            //
            // Inspecting an untrusted value cannot establish that publishing it
            // is safe: an accessor or a `Proxy` trap may answer harmlessly while
            // core is looking and throw when the caller reads the same member
            // afterwards, so a value that passed inspection is a value that
            // behaved once. And provenance alone is not enough either — a
            // handler can catch the very refusal this expansion raised, replace
            // its members with throwing accessors, and rethrow the same object.
            // It is still core's object; it is no longer core's diagnostic.
            //
            // So a canonical refusal is rebuilt from the reason this expansion
            // recorded when it refused, and everything else is described from
            // whatever the failure will safely give up. Either way what gets
            // published, and what reaches the journal, is a value this run
            // constructed and nobody else has held.
            const refusal = issued.republish(error);
            if (refusal !== undefined) {
              yield* ephemeral(rememberLiveFailure(refusal));
            }
            return preRootTerminal(refusal ?? error, root);
          }

          function* beforeAnyImport(
            issued: IssuedDocument<DocumentResult>,
          ): Operation<DocumentResult> {
            // Preparation first: what a trusted host records inside the
            // durable root precedes every public document policy and the root
            // import, so nothing a handler does can prevent it or observe the
            // run before it exists.
            for (const prepare of preparations) {
              yield* prepare();
            }
            // The terminal for this expansion and no other: a same-name
            // instance whose default core owns, so every public handler still
            // composes while none of them can produce a document.
            const expansion = createApi<{ document(request: DocumentRequest): Operation<void> }>(
              "Execution",
              {
                *document(request: DocumentRequest): Operation<void> {
                  yield* issued.claim(request);
                },
              },
            );
            // Whatever a handler returns is not a document, so it is not read.
            // What it *throws* is kept rather than propagated, because a policy
            // failure raised after delegation must not bury the outcome
            // canonical execution already produced. Halting is not caught here:
            // cancellation unwinds through `return()`, so structured teardown is
            // unaffected.
            let policy: { raised: unknown } | undefined;
            try {
              yield* expansion.operations.document(issued.request);
            } catch (error) {
              policy = { raised: error };
            }
            return reconcileExpansion(issued.settlement(), policy);
          }
        },
        {
          stream: guardedJournal(journal, root, ROOT_COROUTINE, admissions),
        },
      );
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
  /**
   * The component bundle this execution is closed over.
   *
   * Plain immutable data: the authored names, their canonical paths inside the
   * pinned tree, their blob object ids, and the exact sources read from it.
   * Captured by value alongside the admissions, before any installation runs,
   * so what a name resolves to — and which answers a document may invoke — is
   * fixed before anything can observe or replace it.
   *
   * One execution runs under one bundle. Two installations supplying one is
   * refused rather than merged.
   */
  readonly bundle?: WorkflowComponentBundle;
  /**
   * What this installation records inside the durable root.
   *
   * Captured by value alongside the admissions, before any installation runs,
   * and invoked after retained-history admission and before any public document
   * policy or the root import. A handler cannot prevent it, and cannot observe
   * the run before it exists.
   */
  readonly prepare?: DurablePreparation;
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
  document(request: DocumentRequest): Operation<void>;
}

/**
 * The public Execution surface.
 *
 * Its `execute` default always refuses. A stable name composes replaceable
 * policy across loaded copies, and this descriptor is the one everybody can
 * reach — so it must not be a terminal that would settle any branded request
 * handed to it. Canonical core dispatches through a private instance instead.
 */
export const Execution: Api<ExecutionApi> = createApi<ExecutionApi>("Execution", {
  // deno-lint-ignore require-yield
  *execute(_request: ExecutionRequest): Operation<void> {
    throw new ExecutionProtocolError("invoked execution outside canonical core");
  },
  // deno-lint-ignore require-yield
  *document(_request: DocumentRequest): Operation<void> {
    throw new DocumentProtocolError("invoked a document expansion outside canonical core");
  },
});

/**
 * Run one document execution, authoritatively, with the invocation owning its
 * own lifetime.
 *
 * The order is the contract. Admissions are copied and frozen first, so what
 * ends up authoritative is fixed before any installation, any middleware and
 * any document code exists. Installations then run, then the chain is invoked
 * with one opaque request, then the request must have reached the terminal
 * exactly once, and only then does canonical core execute the document with the
 * options the terminal recorded.
 *
 * One structured owner task holds the invocation scope. Everything an
 * installation established, and every child the document spawned, lives inside
 * it — and settlement closes it. That is the difference from attaching a
 * resource to the caller: a resource would keep the invocation standing for as
 * long as the caller's scope lasted, so a suspended authored child would still
 * be running while the caller went on to other work.
 *
 * The handle canonical core returns is the authoritative one. It exposes the
 * inner execution's replay-safe output directly — there is no second channel
 * bridging identical chunks — and its completion is the owner's final result,
 * published only after the invocation scope has finished tearing down. So a
 * caller that continues on the completion continues after cleanup, and a
 * completed handle carries no live scope to re-enter.
 *
 * Cancelling a live handle cancels the invocation. A consumer that is halted
 * before settlement halts the owner on its way out, which is what closes the
 * scope and the authored work inside it; the owner then settles the completion
 * so no other observer is left waiting on a run that is over. Once settled,
 * observing the handle again reads the recorded result and starts nothing.
 *
 * Failure before a handle exists keeps the existing pre-handle throwing
 * behavior; once readiness is published, every later failure is a `Result`,
 * reconciled with whatever the document itself produced. That reconciliation
 * ranks by kind — durability, then Files infrastructure, then ordinary — and
 * *within* a kind by occurrence, so the document's own failure precedes the
 * teardown's and is returned by exact identity.
 */
function* runInvocation(
  options: ExecuteOptions,
  installations: readonly ExecutionInstallation[],
  observed?: () => void,
): Operation<DocumentExecution> {
  const ready = withResolvers<DocumentExecution>();
  const settled = withResolvers<Result<Json>>();
  const state: { finished: boolean; document: Result<Json> | undefined } = {
    finished: false,
    document: undefined,
  };

  const finish = (result: Result<Json>): void => {
    if (!state.finished) {
      state.finished = true;
      settled.resolve(result);
    }
  };

  const owner = yield* spawn(function* () {
    // Whatever ends this task — completion, failure, or a cancelled handle —
    // leaves no observer waiting on a run that is over. A document that already
    // produced an outcome keeps it: cancelling a handle during teardown ends the
    // run, it does not erase what the run decided.
    yield* ensure(() => {
      finish(
        state.document === undefined
          ? Err(new Error("the document execution was cancelled"))
          : reconcile(state.document, undefined),
      );
    });

    let published = false;
    try {
      yield* scoped(function* () {
        const execution = yield* invoke(options, installations);
        published = true;
        ready.resolve(execution);
        state.document = yield* execution;
      });
    } catch (error) {
      const teardown = error instanceof Error ? error : new Error(String(error));
      if (!published) {
        // No handle exists, so this throws — but a durability or Files failure
        // raised during cleanup is still the failure that gets reported.
        ready.reject(fatalOf(teardown) ?? teardown);
        return;
      }
      finish(reconcile(state.document, teardown));
      return;
    }
    finish(reconcile(state.document, undefined));
  });

  const execution = yield* ready.operation;
  return {
    output: execution.output,
    *[Symbol.iterator]() {
      // Registered in the *consumer's* scope, so halting a consumer that is
      // still waiting takes the invocation down with it. After settlement this
      // does nothing, which is what lets a completed handle be read again.
      yield* ensure(function* () {
        if (!state.finished) {
          yield* owner.halt();
        }
      });
      // The callback this invocation was started with, captured by value at
      // the boundary rather than reread from a record the caller still holds —
      // so replacing that record afterwards changes nothing here. It exists so
      // a test can cancel a consumer at the one moment that matters, after this
      // observation is cancellable, without waiting a scheduler turn and calling
      // that a proof. It carries nothing and decides nothing.
      observed?.();
      return yield* settled.operation;
    },
  };
}

/**
 * The one outcome of an expansion whose public policy also failed.
 *
 * Ranked on the same terms `reconcile()` ranks an invocation against its
 * teardown, for the same reason: a fatal failure is the run's regardless of
 * which layer raised it, and within one kind the earlier one is the real one.
 * Canonical execution is always the earlier of the two here.
 *
 * The one thing policy may do to a canonical outcome is fail a success. It can
 * neither replace a document that already failed nor rescue a failure canonical
 * execution raised — catching that failure and returning normally leaves it
 * exactly as authoritative as letting it propagate.
 */
function reconcileExpansion(
  settlement: DocumentSettlement<DocumentResult>,
  policy: { raised: unknown } | undefined,
): DocumentResult {
  const canonical = settlement.status === "raised" ? settlement.raised : undefined;
  const raised = policy?.raised;

  const durable =
    (canonical === undefined ? undefined : durabilityFailure(canonical)) ??
    (raised === undefined ? undefined : durabilityFailure(raised));
  if (durable !== undefined) {
    throw durable;
  }
  const files =
    (canonical === undefined ? undefined : filesFatalFailure(canonical)) ??
    (raised === undefined ? undefined : filesFatalFailure(raised));
  if (files !== undefined) {
    throw files;
  }

  if (settlement.status === "raised") {
    throw settlement.raised;
  }
  if (settlement.status === "absent") {
    // A chain that threw did not "return without delegating": its own refusal
    // is what went wrong, and it is reported instead of the protocol violation
    // that never happened.
    throw policy === undefined ? settlement.refusal : policy.raised;
  }
  if (settlement.outcome.status === "err") {
    return settlement.outcome;
  }
  if (policy !== undefined) {
    throw policy.raised;
  }
  return settlement.outcome;
}

/** The fatal failure this one carries, if it carries one. */
function fatalOf(error: unknown): Error | undefined {
  return durabilityFailure(error) ?? filesFatalFailure(error);
}

/**
 * The one result of a document whose invocation also failed to tear down.
 *
 * Both outcomes are kept until the scope has closed, and then ranked. A fatal
 * failure is reported by identity from wherever it came — a durability failure
 * first, then a Files infrastructure failure — because the engine's fences
 * match on the exact object. Below that a document that already failed keeps
 * its own failure, and only a success is converted by teardown.
 */
function reconcile(document: Result<Json> | undefined, teardown: Error | undefined): Result<Json> {
  const failed = document !== undefined && !document.ok ? document.error : undefined;

  // Kind first, then occurrence *within* that kind. The document's outcome
  // happened before the invocation was torn down, so when both carry the same
  // kind of fatal failure the document's is the one reported — by identity,
  // because the engine's fences match the exact object rather than a rebuilt
  // one.
  const durable =
    (failed === undefined ? undefined : durabilityFailure(failed)) ??
    (teardown === undefined ? undefined : durabilityFailure(teardown));
  if (durable !== undefined) {
    return Err(durable);
  }
  const files =
    (failed === undefined ? undefined : filesFatalFailure(failed)) ??
    (teardown === undefined ? undefined : filesFatalFailure(teardown));
  if (files !== undefined) {
    return Err(files);
  }

  if (document !== undefined && !document.ok) {
    return document;
  }
  if (teardown !== undefined) {
    return Err(teardown);
  }
  return document ?? Err(new Error("the document execution did not complete"));
}

function* invoke(
  options: ExecuteOptions,
  installations: readonly ExecutionInstallation[],
): Operation<DocumentExecution> {
  const admissions = Object.freeze(
    installations.flatMap((installation) => [...(installation.admissions ?? [])]),
  );
  // Captured by value at the same moment, and for the same reason: what ends up
  // authoritative is fixed before any installation, middleware or document code
  // exists.
  const preparations = Object.freeze(
    installations.flatMap((installation) => {
      // Read once. A property that answers differently the second time would
      // otherwise let a host be tested for a preparation and then run a
      // different one.
      const prepare = installation.prepare;
      return prepare === undefined ? [] : [prepare];
    }),
  );
  // Read once and frozen for the same reason, and copied entry by entry so the
  // authority is closed over this run's own values rather than over an array a
  // host still holds.
  const bundles = Object.freeze(
    installations.flatMap((installation) => {
      const bundle = installation.bundle;
      return bundle === undefined
        ? []
        : [
            Object.freeze({
              components: Object.freeze(
                [...bundle.components].map((component) =>
                  Object.freeze({
                    name: component.name,
                    path: component.path,
                    sourceHash: component.sourceHash,
                    content: component.content,
                  }),
                ),
              ),
            }),
          ];
    }),
  );

  for (const installation of installations) {
    if (installation.install) {
      yield* installation.install();
    }
  }

  const issued = issueExecution(options);

  // The terminal for this invocation and no other.
  //
  // A stable Api *name* shares the middleware context, so every public handler
  // installed anywhere — including through another loaded copy's descriptor —
  // composes around this call exactly as it composes around the public
  // descriptor's. What a name does not share is the default handler: each
  // `createApi()` instance owns its own, and this one is closed over this
  // invocation. So the public chain terminates in a continuation no middleware
  // can reach, replace, or reorder, and a request another invocation issued is
  // refused here rather than settling somebody else's execution.
  const invocationExecution = createApi<{
    execute(request: ExecutionRequest): Operation<void>;
  }>("Execution", {
    // deno-lint-ignore require-yield
    *execute(request: ExecutionRequest): Operation<void> {
      issued.consume(request);
    },
  });

  // Whatever a handler returns is not an execution, so it is not read.
  yield* invocationExecution.operations.execute(issued.request);

  return yield* executeDocument(
    issued.settle(),
    admissions,
    issued.completions(),
    preparations,
    bundles,
  );
}

/**
 * What one invocation may be watched by, and nothing more.
 *
 * Non-authoritative by construction: the callback takes no arguments, returns
 * nothing, and is read at exactly one point. Nothing here can change what an
 * execution does, what it settles to, or how it is torn down.
 *
 * The record is the caller's; what the invocation keeps is the function it held
 * at the moment the invocation started.
 */
export interface InvocationObservers {
  /** Called once a consumer of the returned handle has become cancellable. */
  observed?: () => void;
}

/** The ordinary entrypoint: one execution, nothing installed around it. */
export function execute(options: ExecuteOptions): Operation<DocumentExecution> {
  return runInvocation(options, []);
}

/**
 * The same invocation, watched.
 *
 * Package-internal and test-only: neither `@executablemd/core` nor
 * `@executablemd/core/host` exports it, and the observers it takes belong to
 * this call alone rather than to a slot every execution shares.
 */
export function executeObserved(
  options: ExecuteOptions,
  installations: readonly ExecutionInstallation[],
  observers: InvocationObservers,
): Operation<DocumentExecution> {
  // The callback is read here, once, and passed on as a value. What the caller
  // does to its own record afterwards is its own business.
  return runInvocation(options, [...installations], observers.observed);
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
