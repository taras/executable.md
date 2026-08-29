/**
 * Validating a supplied document without executing any of it.
 *
 * A host that generated a program, or received one, needs to know whether it is
 * a program at all before it asks a person to approve it. That question is
 * answerable: component resolution, declaration admission, authored forms, body
 * shape, structural placement and prop schemas are all decided from source and
 * from what the host declared, never from a value the document computes.
 *
 * So this reads. It applies ordinary target selection to the supplied root,
 * scans that projection with the scanner execution uses, and follows ordinary
 * component selection through every Markdown definition the authored
 * invocations discover. It evaluates no expression, invokes no component,
 * imports no repository module, projects no content, calls no identity factory,
 * installs no provider, opens no journal, and performs no filesystem operation
 * the document asked for. The only bytes it reads are the root and the Markdown
 * definitions selection identified — the same reads inspection already makes.
 *
 * The answer is versioned data rather than a thrown exception or rendered
 * prose: one closed code per diagnostic, the normalized schema issues execution
 * already produces, and one record per authored invocation saying whether it is
 * valid, invalid, or not decidable without running the document. A generator or
 * a person reads the codes; nobody parses the messages.
 */

import type { Operation } from "effection";
import { readTextFile } from "@executablemd/runtime";

import {
  bodyStructureFacts,
  outputPropsViolation,
  previewOutput,
  previewReturn,
} from "./body-structure.ts";
import type { BodyStructureFacts } from "./body-structure.ts";
import { Component } from "./component-api.ts";
import { declaredRegistry } from "./components/declared-registry.ts";
import { admitDeclaration, mergeRegistry } from "./components/registration.ts";
import { DEFAULT_INCLUDES, selectComponent, unresolvedMessage } from "./components/select.ts";
import {
  definitionFailure,
  isFunctionComponentPath,
  parseMarkdownDefinitionPhased,
  parseRootMarkdownDefinitionPhased,
} from "./definition.ts";
import type { DefinitionPhase } from "./definition.ts";
import { assertDistinctIdentityNames } from "./invocation-identity.ts";
import type { IdentityComponent } from "./invocation-identity.ts";
import { validateBindingName } from "./live-env.ts";
import { readRootSource, rootSourcePath } from "./root-source.ts";
import type { RootDocumentSource } from "./root-source.ts";
import {
  answersViolations,
  answerViolations,
  breakViolations,
  eachViolations,
  ifConditionViolation,
  ifPropsViolation,
  ifStructure,
  letViolations,
  loopViolations,
  printErrorsViolations,
  strayAnswerMessage,
  strayElseMessage,
  strayStructuralMessage,
} from "./structural-rules.ts";
import type { StructuralViolation } from "./structural-rules.ts";
import type {
  ComponentDefinition,
  ComponentElement,
  ComponentOrigin,
  ComponentRegistry,
  InvocationForm,
  Json,
  PropsSchema,
  Segment,
  SourcePosition,
} from "./types.ts";
import { PropValidationError, SchemaValidationError, validateProps } from "./validate.ts";
import type { NormalizedIssue } from "./validate.ts";

/**
 * What the host supplies beside the root itself.
 *
 * The same declarative environment `inspectSyntax()` reads, and no more: root
 * props as plain JSON, the ordered include path, and the identity components a
 * host would declare to an execution. There is no `cwd` option because there is
 * no second working directory — a relative root or include resolves against the
 * contextual runtime's, exactly as execution resolves it.
 */
export interface ValidateDocumentSettings {
  /** The props a run would supply. Absent is `{}`. */
  readonly props?: Record<string, Json>;
  /** Where components are looked for. Absent is `DEFAULT_INCLUDES`. */
  readonly includes?: readonly string[];
  /**
   * Identity components the host would declare to an execution, with the same
   * meaning `ExecuteOptions.components` and `InspectSyntaxOptions.components`
   * give them — admissibility included.
   *
   * A set an execution would refuse is refused here too, as a thrown
   * configuration error rather than a document diagnostic: a document is not
   * invalid because the host that asked about it described an environment no
   * document could run in. The factory is never called.
   */
  readonly components?: readonly IdentityComponent[];
}

/** The root to validate, and the environment to validate it against. */
export type ValidateDocumentOptions = RootDocumentSource & ValidateDocumentSettings;

/** Where one authored invocation was written. */
export interface InvocationSite {
  readonly name: string;
  readonly position?: Readonly<SourcePosition>;
}

/** Why an invocation could not be decided without running the document. */
export type InvocationOpacityReason = "dynamic-props" | "origin-only-contract";

/**
 * What validation concluded about one authored invocation.
 *
 * `valid` and `not-statically-checkable` both carry the origin selection chose,
 * because both of them resolved. `invalid` carries one only when it did: an
 * unresolved name has no origin to report, while a component whose source later
 * failed to parse keeps the origin it resolved to.
 */
export type InvocationValidation = InvocationSite &
  (
    | {
        readonly outcome: "valid";
        readonly origin: Readonly<ComponentOrigin>;
      }
    | {
        readonly outcome: "invalid";
        readonly origin?: Readonly<ComponentOrigin>;
        readonly diagnosticIndexes: readonly number[];
      }
    | {
        readonly outcome: "not-statically-checkable";
        readonly origin: Readonly<ComponentOrigin>;
        readonly reasons: readonly InvocationOpacityReason[];
      }
  );

/**
 * Every condition version 1 can establish before execution.
 *
 * Closed, and ordered: this is the order two diagnostics at one position sort
 * in, so the union's shape is part of the answer rather than a listing of it.
 */
export type DocumentValidationCode =
  | "source-unreadable"
  | "source-invalid"
  | "target-invalid"
  | "frontmatter-invalid"
  | "props-declaration-invalid"
  | "returns-declaration-invalid"
  | "component-unresolved"
  | "component-ambiguous"
  | "invocation-form-invalid"
  | "body-shape-invalid"
  | "props-invalid"
  | "binding-invalid"
  | "capture-invalid"
  | "return-usage-invalid"
  | "structural-usage-invalid";

/** One definite failure, in the source it belongs to. */
export interface DocumentValidationDiagnostic {
  readonly code: DocumentValidationCode;
  readonly message: string;
  readonly position?: Readonly<SourcePosition>;
  readonly component?: string;
  /** The normalized schema issues, when a schema is what failed. */
  readonly issues?: readonly NormalizedIssue[];
}

/** What validating one document concluded. */
export interface DocumentValidation {
  readonly version: 1;
  readonly outcome: "valid" | "invalid";
  readonly diagnostics: readonly DocumentValidationDiagnostic[];
  readonly invocations: readonly InvocationValidation[];
}

/** The order two diagnostics at one position are reported in. */
const CODE_ORDER: readonly DocumentValidationCode[] = [
  "source-unreadable",
  "source-invalid",
  "target-invalid",
  "frontmatter-invalid",
  "props-declaration-invalid",
  "returns-declaration-invalid",
  "component-unresolved",
  "component-ambiguous",
  "invocation-form-invalid",
  "body-shape-invalid",
  "props-invalid",
  "binding-invalid",
  "capture-invalid",
  "return-usage-invalid",
  "structural-usage-invalid",
];

/**
 * The rank a code sorts at, exported so a consumer ordering diagnostics of its
 * own reaches the same order this does rather than a second one.
 */
export function documentValidationCodeRank(code: DocumentValidationCode): number {
  return CODE_ORDER.indexOf(code);
}

/**
 * The forms a component accepts when it declares none: both of them.
 *
 * Omission is what every registration meant before forms could be declared, and
 * it is what a Markdown component means — a Markdown definition renders its
 * content where `<Content />` appears and renders without it either way.
 */
const BOTH_FORMS: readonly InvocationForm[] = ["self-closing", "paired"];

/** The name root-props validation reports itself under, as execution does. */
const ROOT_NAME = "__root__";

/**
 * One diagnostic while the walk is still running.
 *
 * The public index does not exist yet — it cannot, because it is an index into
 * an array that is only sorted once the walk ends. A draft therefore carries a
 * token an invocation refers to, and the sorter rewrites tokens into indexes.
 */
interface DraftDiagnostic {
  readonly token: number;
  readonly sourceOrdinal: number;
  readonly sequence: number;
  readonly code: DocumentValidationCode;
  readonly message: string;
  readonly position?: Readonly<SourcePosition>;
  readonly component?: string;
  readonly issues?: readonly NormalizedIssue[];
  /**
   * The failure a read or a parser produced, kept on the draft and never
   * published. The answer carries stable prose; an errno object, a stack, or a
   * host path from outside the workspace is not something a versioned
   * diagnostic hands to whoever reads it next.
   */
  readonly cause?: unknown;
}

/** One invocation record while the walk is still running. */
interface DraftInvocation {
  readonly name: string;
  readonly position?: Readonly<SourcePosition>;
  origin?: Readonly<ComponentOrigin>;
  readonly tokens: number[];
  readonly reasons: InvocationOpacityReason[];
}

/** A source that parsed, with everything its own declaration decided. */
interface ParsedSourceEntry {
  readonly state: "parsed";
  readonly ordinal: number;
  readonly definition: ComponentDefinition;
  /** The body-contract diagnostics this source's own declaration produced. */
  readonly bodyTokens: readonly number[];
  /** Which of those belong to one authored element. */
  readonly elementTokens: ReadonlyMap<ComponentElement, readonly number[]>;
}

/** A source that could not be read or parsed, and the one failure that says so. */
interface FailedSourceEntry {
  readonly state: "failed";
  readonly ordinal: number;
  readonly token: number;
}

type SourceEntry = ParsedSourceEntry | FailedSourceEntry;

/** Where in a source's own structure a walk currently is. */
interface LexicalContext {
  /** The source being walked. */
  readonly entry: ParsedSourceEntry;
  /** Whether this is the supplied root rather than a selected definition. */
  readonly isRoot: boolean;
  /** Whether a `<Loop>` in this source lexically encloses this point. */
  readonly insideLoop: boolean;
  /** Whether an `<If>` in this source lexically encloses this point. */
  readonly insideIf: boolean;
  /** Whether the immediate parent is an `<Answers>`. */
  readonly underAnswers: boolean;
}

/** What a complete contract states about one invocation. */
interface CompleteContract {
  readonly props: PropsSchema;
  readonly captures: readonly string[];
  readonly forms: readonly InvocationForm[];
  readonly hasReturns: boolean;
}

/**
 * Validate a supplied document, and every Markdown definition its authored
 * invocations reach, without executing any of it.
 *
 * Traversal follows source rather than execution: the selected root projection
 * first, then each discovered definition in the order its first invocation was
 * encountered, each source scanned exactly once. An invocation written inside
 * `<If>`, `<Loop>` or `<Each>` is authored program structure and is checked
 * like any other; no branch is evaluated to decide whether it would run. A
 * definition that invokes itself, directly or through others, terminates the
 * walk when the source identity comes back around, and that is not a failure.
 *
 * The result is deterministic: the same document and environment produce
 * deep-equal diagnostics and invocation records every time.
 */
export function* validateDocument(options: ValidateDocumentOptions): Operation<DocumentValidation> {
  const includes = options.includes ?? DEFAULT_INCLUDES;
  const declared = options.components ?? [];
  // Admitted before anything is read, on exactly the terms ordinary execution
  // admits declarations on. A set an execution would refuse describes an
  // environment no document could run in, so it is the caller's error rather
  // than the document's, and it escapes instead of becoming a diagnostic.
  assertDistinctIdentityNames(declared);
  for (const component of declared) {
    yield* admitDeclaration(component);
  }
  const registry = mergeRegistry(yield* Component.operations.registry, declaredRegistry(declared));

  const state = new ValidationState(includes, registry);
  yield* state.run(options);
  return state.finish();
}

/**
 * The one walk, and everything it accumulates.
 *
 * A class rather than a bag of parameters because every step writes into the
 * same three places — the diagnostic drafts, the invocation drafts, and the
 * source cache — and because the sorter at the end has to see all three
 * together to rewrite tokens into indexes.
 */
class ValidationState {
  readonly #includes: readonly string[];
  readonly #registry: ComponentRegistry;
  readonly #diagnostics: DraftDiagnostic[] = [];
  readonly #invocations: DraftInvocation[] = [];
  /** Source identity to what reading it produced. Read once, reused always. */
  readonly #sources = new Map<string, SourceEntry>();
  /** Parsed sources still waiting to have their own body walked. */
  readonly #queue: ParsedSourceEntry[] = [];
  #nextOrdinal = 0;
  #nextToken = 0;
  #sequence = 0;

  constructor(includes: readonly string[], registry: ComponentRegistry) {
    this.#includes = includes;
    this.#registry = registry;
  }

  *run(options: ValidateDocumentOptions): Operation<void> {
    const root = yield* this.#readRoot(options);
    if (root === undefined) {
      return;
    }

    // Root props are supplied JSON rather than document expressions, so the
    // whole object is validated: there is no dynamic value here to be opaque
    // about. A failure belongs to the root itself and invents no invocation.
    yield* this.#validateRootProps(root, options.props ?? {});

    this.#queue.push(root);
    while (this.#queue.length > 0) {
      const entry = this.#queue.shift()!;
      yield* this.#walk(entry.definition.bodySegments, {
        entry,
        isRoot: entry.ordinal === 0,
        insideLoop: false,
        insideIf: false,
        underAnswers: false,
      });
    }
  }

  /** The root, read and parsed, or `undefined` when it failed to become one. */
  *#readRoot(options: ValidateDocumentOptions): Operation<ParsedSourceEntry | undefined> {
    const ordinal = this.#nextOrdinal++;
    const path = rootSourcePath(options);
    if (isFunctionComponentPath(path)) {
      // A `.ts` root is a module execution would import, not a document. There
      // is no markdown to scan and no frontmatter to read, so the source itself
      // is what is wrong with it.
      this.#draft(ordinal, "source-invalid", {
        message: "Root document must be a markdown file, not a function component",
      });
      return undefined;
    }

    let content: string;
    try {
      content = yield* readRootSource(options);
    } catch (error) {
      this.#draft(ordinal, "source-unreadable", { message: unreadable(path), cause: error });
      return undefined;
    }

    const parsed = yield* parseRootMarkdownDefinitionPhased(
      ROOT_NAME,
      path,
      content,
      options.target,
    );
    if (!parsed.ok) {
      const failure = definitionFailure(parsed.error);
      this.#draft(ordinal, codeForPhase(failure.phase), {
        message: messageOf(failure.original),
        cause: failure.original,
      });
      return undefined;
    }
    return this.#admitParsed(ordinal, parsed.value.definition);
  }

  /**
   * The cache entry for a selected Markdown definition, reading and parsing it
   * on its first invocation and reusing that one answer afterwards.
   *
   * The canonical selected path is the identity, so two names selecting one
   * file share the entry, a definition that invokes itself finds itself here
   * rather than recursing, and a file that could not be read carries one
   * failure however many invocations selected it.
   */
  *#loadSource(name: string, path: string): Operation<SourceEntry> {
    const cached = this.#sources.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const ordinal = this.#nextOrdinal++;

    let content: string;
    try {
      content = yield* readTextFile(path);
    } catch (error) {
      return this.#failSource(path, ordinal, "source-unreadable", unreadable(path), name, error);
    }

    const parsed = yield* parseMarkdownDefinitionPhased(name, path, content);
    if (!parsed.ok) {
      const failure = definitionFailure(parsed.error);
      return this.#failSource(
        path,
        ordinal,
        codeForPhase(failure.phase),
        `${path}: ${messageOf(failure.original)}`,
        name,
        failure.original,
      );
    }

    const entry = this.#admitParsed(ordinal, parsed.value, path);
    this.#queue.push(entry);
    return entry;
  }

  #failSource(
    path: string,
    ordinal: number,
    code: DocumentValidationCode,
    message: string,
    component: string,
    cause?: unknown,
  ): FailedSourceEntry {
    // No position: nothing inside the file was reached, so there is no authored
    // place to point at. The file names itself in the message instead.
    const token = this.#draft(ordinal, code, { message, component, cause });
    const entry: FailedSourceEntry = { state: "failed", ordinal, token };
    this.#sources.set(path, entry);
    return entry;
  }

  /**
   * Record a parsed source, together with what its own body contract decided.
   *
   * The body contract is read here rather than during the walk because an
   * invocation of this definition may be checked long before this source's turn
   * in the queue comes up, and it has to be able to point at the same
   * diagnostics every other caller points at.
   */
  #admitParsed(
    ordinal: number,
    definition: ComponentDefinition,
    identity?: string,
  ): ParsedSourceEntry {
    const facts = bodyStructureFacts(definition.bodySegments, definition.returns);
    const elementTokens = new Map<ComponentElement, number[]>();
    const bodyTokens: number[] = [];
    const owner = definition.name === ROOT_NAME ? undefined : definition.name;
    for (const drafted of this.#draftBodyFacts(ordinal, facts, owner)) {
      bodyTokens.push(drafted.token);
      if (drafted.element === undefined) {
        continue;
      }
      const existing = elementTokens.get(drafted.element);
      if (existing === undefined) {
        elementTokens.set(drafted.element, [drafted.token]);
      } else {
        existing.push(drafted.token);
      }
    }
    const entry: ParsedSourceEntry = {
      state: "parsed",
      ordinal,
      definition,
      bodyTokens,
      elementTokens,
    };
    if (identity !== undefined) {
      this.#sources.set(identity, entry);
    }
    return entry;
  }

  /**
   * One body-contract fact per diagnostic, at the position it was authored.
   *
   * Expansion renders the same facts as one aggregate printed error, which is
   * the right shape for a reader. A consumer acting on them needs each
   * violation separately, under its own code, so an `<Output>` in the wrong
   * place and a `<Return>` with no declaration do not arrive as one sentence.
   */
  #draftBodyFacts(
    ordinal: number,
    facts: BodyStructureFacts,
    owner: string | undefined,
  ): { token: number; element?: ComponentElement }[] {
    const drafted: { token: number; element?: ComponentElement }[] = [];
    for (const element of facts.misplacedOutputs) {
      drafted.push({
        element,
        token: this.#draft(ordinal, "body-shape-invalid", {
          message:
            "<Output> must be a direct top-level child of the component or document that " +
            `declares it. Found ${previewOutput(element)}.`,
          component: "Output",
          ...positionOf(element),
        }),
      });
    }
    for (const element of facts.exclusiveOutputs) {
      drafted.push({
        element,
        token: this.#draft(ordinal, "body-shape-invalid", {
          message: `${previewOutput(element)} — <Output> and \`returns\` are exclusive.`,
          component: "Output",
          ...positionOf(element),
        }),
      });
    }
    for (const element of facts.undeclaredReturns) {
      drafted.push({
        element,
        token: this.#draft(ordinal, "return-usage-invalid", {
          message:
            `${previewReturn(element)} requires a document or component that declares ` +
            "`returns`. Declare a return schema, or remove <Return>.",
          component: "Return",
          ...positionOf(element),
        }),
      });
    }
    if (facts.missingReturn) {
      drafted.push({
        token: this.#draft(ordinal, "return-usage-invalid", {
          message:
            "A component that declares `returns` renders nothing and produces exactly one " +
            "value through a <Return> its own body executes. This body writes no <Return>.",
          ...(owner === undefined ? {} : { component: owner }),
        }),
      });
    }
    for (const violation of facts.returnViolations) {
      drafted.push({
        element: violation.element,
        token: this.#draft(ordinal, "return-usage-invalid", {
          message: `${violation.message}.`,
          component: "Return",
          ...positionOf(violation.element),
        }),
      });
    }
    return drafted;
  }

  *#validateRootProps(root: ParsedSourceEntry, props: Record<string, Json>): Operation<void> {
    try {
      yield* validateProps(ROOT_NAME, props, root.definition.props);
    } catch (error) {
      if (error instanceof PropValidationError) {
        this.#draft(root.ordinal, "props-invalid", {
          message: error.message,
          issues: error.issues,
        });
        return;
      }
      throw error;
    }
  }

  *#walk(segments: readonly Segment[], context: LexicalContext): Operation<void> {
    for (const segment of segments) {
      if (segment.type === "codeBlock") {
        // The block is never compiled or run. Its `as=` annotation is authored
        // structure the scanner already decided about, so a refused one is a
        // definite failure of the source rather than of a process.
        const binding = segment.binding;
        if (binding !== undefined && !binding.ok) {
          this.#draft(context.entry.ordinal, "binding-invalid", {
            message: binding.error.message,
            ...(segment.position === undefined ? {} : { position: segment.position }),
          });
        }
        continue;
      }
      if (segment.type !== "component") {
        continue;
      }
      yield* this.#visit(segment, context);
      yield* this.#walk(segment.children, childContext(segment, context));
    }
  }

  *#visit(segment: ComponentElement, context: LexicalContext): Operation<void> {
    const draft: DraftInvocation = {
      name: segment.name,
      ...(segment.position === undefined ? {} : { position: segment.position }),
      tokens: [...(context.entry.elementTokens.get(segment) ?? [])],
      reasons: [],
    };
    this.#invocations.push(draft);

    const selected = yield* selectComponent(segment.name, {
      includes: this.#includes,
      registry: this.#registry,
    });

    if (selected.kind === "structural") {
      draft.origin = { kind: "structural", construct: selected.construct };
      for (const violation of this.#structuralViolations(segment, context)) {
        draft.tokens.push(
          this.#draft(context.entry.ordinal, violation.code, {
            message: violation.message,
            component: segment.name,
            ...positionOf(violation.element ?? segment),
          }),
        );
      }
      return;
    }

    if (selected.kind === "unresolved") {
      // No origin: nothing was selected, so there is nothing to report having
      // been selected. That is the one invalid outcome with no origin at all.
      draft.tokens.push(
        this.#draft(context.entry.ordinal, "component-unresolved", {
          message: unresolvedMessage(segment.name, selected.searched),
          component: segment.name,
          ...positionOf(segment),
        }),
      );
      return;
    }

    if (selected.kind === "workflow") {
      // A component bundle is authority one document execution runs under.
      // Validation installs none, so this tier answers for no validation.
      throw new Error(
        `Component ${segment.name} resolved through a workflow component bundle, which ` +
          "describes a document execution rather than a document.",
      );
    }

    // Engine-owned and independent of any contract: `as` names a binding, and
    // whether the author wrote a name at all is decided from the syntax.
    const captureViolation = componentCaptureViolation(segment);
    if (captureViolation !== undefined) {
      draft.tokens.push(
        this.#draft(context.entry.ordinal, "capture-invalid", {
          message: captureViolation,
          component: segment.name,
          ...positionOf(segment),
        }),
      );
    }

    if (selected.kind === "registered") {
      draft.origin = selected.origin;
      yield* this.#checkContract(segment, context, draft, {
        props: selected.definition.props,
        captures: selected.definition.captures ?? [],
        forms: selected.definition.forms ?? BOTH_FORMS,
        hasReturns: selected.definition.returns !== undefined,
      });
      return;
    }

    const origin: ComponentOrigin = { kind: "repository", path: selected.path };
    draft.origin = origin;

    if (isFunctionComponentPath(selected.path)) {
      // Its contract lives on the module's exports, and reading them would run
      // the module's top-level code. Nothing is assumed in its place: no forms,
      // no props schema, no captures, no return mode. Only the engine-owned
      // checks above applied, and what is left is unknown rather than accepted.
      if (draft.tokens.length === 0) {
        if (hasDynamicProp(segment, [])) {
          draft.reasons.push("dynamic-props");
        }
        draft.reasons.push("origin-only-contract");
      }
      return;
    }

    const source = yield* this.#loadSource(segment.name, selected.path);
    if (source.state === "failed") {
      // Every invocation that selected this definition points at the one
      // failure the source has, and none of them invents a second.
      draft.tokens.push(source.token);
      return;
    }
    // A definition whose own body contract is broken is broken for every
    // caller, at the position its own source states.
    draft.tokens.push(...source.bodyTokens);
    yield* this.#checkContract(segment, context, draft, {
      props: source.definition.props,
      captures: [],
      forms: BOTH_FORMS,
      hasReturns: source.definition.returns !== undefined,
    });
  }

  /**
   * The checks a complete contract makes possible: the authored form, the
   * return-mode requirement, and the props schema.
   */
  *#checkContract(
    segment: ComponentElement,
    context: LexicalContext,
    draft: DraftInvocation,
    contract: CompleteContract,
  ): Operation<void> {
    const ordinal = context.entry.ordinal;
    const form: InvocationForm = segment.selfClosing ? "self-closing" : "paired";
    if (!contract.forms.includes(form)) {
      draft.tokens.push(
        this.#draft(ordinal, "invocation-form-invalid", {
          message:
            `<${segment.name} /> is not written in a form it accepts: it was invoked ` +
            `${form}, and it accepts ${contract.forms.join(" and ")}.`,
          component: segment.name,
          ...positionOf(segment),
        }),
      );
    }

    if (contract.hasReturns && !("as" in segment.props) && !("as" in segment.expressions)) {
      draft.tokens.push(
        this.#draft(ordinal, "return-usage-invalid", {
          message:
            `<${segment.name} /> declares \`returns\`, so it renders nothing and must be ` +
            `invoked with \`as\`: <${segment.name} as="binding" />.`,
          component: segment.name,
          ...positionOf(segment),
        }),
      );
    }

    // `slot` and `as` are the engine's, and a declared capture is handed over
    // unresolved — none of the three meets the schema, during execution or here.
    const statics = schemaVisible(segment.props, contract.captures);
    const dynamics = schemaVisible(segment.expressions, contract.captures);

    if (Object.keys(dynamics).length > 0) {
      // A required key is absent or it is not, and no value is needed to say
      // which — so this stays definite even beside a prop nothing can resolve.
      const missing = missingRequired(contract.props, statics, dynamics);
      if (missing.length > 0) {
        const error = new SchemaValidationError(
          segment.name,
          `Prop validation failed for <${segment.name} />:`,
          missing,
        );
        draft.tokens.push(
          this.#draft(ordinal, "props-invalid", {
            message: error.message,
            component: segment.name,
            issues: missing,
            ...positionOf(segment),
          }),
        );
      }
      // Ajv is not asked a question about an object it has not been given.
      // Partially solving a schema across the values that are there and the
      // ones that are not would answer with conclusions nothing established.
      draft.reasons.push("dynamic-props");
      return;
    }

    try {
      yield* validateProps(segment.name, statics, contract.props);
    } catch (error) {
      if (error instanceof PropValidationError) {
        draft.tokens.push(
          this.#draft(ordinal, "props-invalid", {
            message: error.message,
            component: segment.name,
            issues: error.issues,
            ...positionOf(segment),
          }),
        );
        return;
      }
      throw error;
    }
  }

  /** Everything one structural construct's own source decided. */
  #structuralViolations(
    segment: ComponentElement,
    context: LexicalContext,
  ): readonly StructuralViolation[] {
    switch (segment.name) {
      case "Let":
        return letViolations(segment);
      case "Each":
        return eachViolations(segment);
      case "If": {
        const found: StructuralViolation[] = [];
        const unknownProp = ifPropsViolation(segment);
        if (unknownProp !== undefined) {
          // Expansion stops here too: an `<If>` whose props are wrong expands
          // neither branch, and reads no structure it would then complain about.
          return [unknownProp];
        }
        found.push(...ifStructure(segment).violations);
        const condition = ifConditionViolation(segment);
        if (condition !== undefined) {
          found.push(condition);
        }
        return found;
      }
      case "Loop":
        return loopViolations(segment);
      case "Break":
        return breakViolations(segment, context.insideLoop);
      case "PrintErrors":
        return printErrorsViolations(segment);
      case "Answers":
        return answersViolations(segment);
      case "Answer":
        return context.underAnswers
          ? answerViolations(segment)
          : [
              {
                code: "structural-usage-invalid",
                source: "Answer",
                message: strayAnswerMessage(),
              },
            ];
      case "Else":
        // A well-placed `<Else>` is its `<If>`'s, and one placed wrongly under
        // an `<If>` is already reported by that `<If>`'s own structure. What is
        // left is an `<Else>` with no `<If>` above it at all.
        return context.insideIf
          ? []
          : [{ code: "structural-usage-invalid", source: "Else", message: strayElseMessage() }];
      case "Output": {
        const propsViolation = outputPropsViolation(segment);
        return propsViolation === undefined
          ? []
          : [{ code: "structural-usage-invalid", source: "Output", message: propsViolation }];
      }
      case "Content":
        // A component's body projects what its invocation was given. A root
        // document is nobody's invocation, so there is nothing to project.
        return context.isRoot
          ? [
              {
                code: "structural-usage-invalid",
                source: "Content",
                message: strayStructuralMessage("Content"),
              },
            ]
          : [];
      default:
        // `<Return>` is the remaining case, and its whole contract belongs to
        // the body that declares — or fails to declare — `returns`, which the
        // source's own facts already stated.
        return [];
    }
  }

  #draft(
    sourceOrdinal: number,
    code: DocumentValidationCode,
    detail: {
      message: string;
      position?: Readonly<SourcePosition>;
      component?: string;
      issues?: readonly NormalizedIssue[];
      cause?: unknown;
    },
  ): number {
    const token = this.#nextToken++;
    this.#diagnostics.push({
      token,
      sourceOrdinal,
      sequence: this.#sequence++,
      code,
      message: detail.message,
      ...(detail.position === undefined ? {} : { position: detail.position }),
      ...(detail.component === undefined ? {} : { component: detail.component }),
      ...(detail.issues === undefined ? {} : { issues: detail.issues }),
      ...(detail.cause === undefined ? {} : { cause: detail.cause }),
    });
    return token;
  }

  /**
   * The finished answer.
   *
   * Ordering is decided once, here, and never during the walk: the root first,
   * then definitions in the order their first invocation discovered them; a
   * source's own unpositioned failure before anything positioned inside it;
   * then authored offset; then the closed code order; then discovery, which is
   * the stable tie breaker and is never public.
   */
  finish(): DocumentValidation {
    const sorted = this.#diagnostics.toSorted(compareDrafts);
    const indexes = new Map<number, number>();
    sorted.forEach((draft, index) => indexes.set(draft.token, index));

    const diagnostics: DocumentValidationDiagnostic[] = sorted.map((draft) => ({
      code: draft.code,
      message: draft.message,
      ...(draft.position === undefined ? {} : { position: draft.position }),
      ...(draft.component === undefined ? {} : { component: draft.component }),
      ...(draft.issues === undefined ? {} : { issues: draft.issues }),
    }));

    const invocations: InvocationValidation[] = this.#invocations.map((draft) => {
      const site: InvocationSite = {
        name: draft.name,
        ...(draft.position === undefined ? {} : { position: draft.position }),
      };
      if (draft.tokens.length > 0) {
        const diagnosticIndexes = [
          ...new Set(draft.tokens.map((token) => indexes.get(token)!)),
        ].toSorted((left, right) => left - right);
        return {
          ...site,
          outcome: "invalid",
          ...(draft.origin === undefined ? {} : { origin: draft.origin }),
          diagnosticIndexes,
        };
      }
      // Both remaining outcomes resolved, so both report an origin. A record
      // reaching here without one would mean selection answered and nothing
      // wrote down what it answered.
      const origin = draft.origin!;
      if (draft.reasons.length > 0) {
        return { ...site, outcome: "not-statically-checkable", origin, reasons: draft.reasons };
      }
      return { ...site, outcome: "valid", origin };
    });

    return {
      version: 1,
      outcome: diagnostics.length === 0 ? "valid" : "invalid",
      diagnostics,
      invocations,
    };
  }
}

function compareDrafts(left: DraftDiagnostic, right: DraftDiagnostic): number {
  if (left.sourceOrdinal !== right.sourceOrdinal) {
    return left.sourceOrdinal - right.sourceOrdinal;
  }
  const leftPositioned = left.position === undefined ? 0 : 1;
  const rightPositioned = right.position === undefined ? 0 : 1;
  if (leftPositioned !== rightPositioned) {
    return leftPositioned - rightPositioned;
  }
  if (left.position !== undefined && right.position !== undefined) {
    if (left.position.offset !== right.position.offset) {
      return left.position.offset - right.position.offset;
    }
  }
  const rank = documentValidationCodeRank(left.code) - documentValidationCodeRank(right.code);
  if (rank !== 0) {
    return rank;
  }
  return left.sequence - right.sequence;
}

/** The lexical facts one element's children are written under. */
function childContext(segment: ComponentElement, context: LexicalContext): LexicalContext {
  return {
    entry: context.entry,
    isRoot: context.isRoot,
    insideLoop: context.insideLoop || segment.name === "Loop",
    insideIf: context.insideIf || segment.name === "If",
    underAnswers: segment.name === "Answers",
  };
}

function positionOf(segment: ComponentElement): { position?: Readonly<SourcePosition> } {
  return segment.position === undefined ? {} : { position: segment.position };
}

/**
 * The props a schema may see: everything but the engine's own two and whatever
 * the selected definition declared a capture.
 */
function schemaVisible<T>(
  written: Record<string, T>,
  captures: readonly string[],
): Record<string, T> {
  const captured = new Set(captures);
  const visible: Record<string, T> = {};
  for (const [key, value] of Object.entries(written)) {
    if (key === "slot" || key === "as" || captured.has(key)) {
      continue;
    }
    visible[key] = value;
  }
  return visible;
}

/** Whether any schema-visible prop is written as an expression. */
function hasDynamicProp(segment: ComponentElement, captures: readonly string[]): boolean {
  return Object.keys(schemaVisible(segment.expressions, captures)).length > 0;
}

/**
 * Required properties whose key is written nowhere at all.
 *
 * Presence, not value: this asks only whether the author wrote the key, so it
 * stays definite beside a prop whose value nothing here can resolve. Every
 * other schema conclusion — type, additional properties, conditionals,
 * dependencies — is left to the one full-schema call, which runs only when
 * every schema-visible value is there.
 */
function missingRequired(
  schema: PropsSchema,
  statics: Record<string, Json>,
  dynamics: Record<string, string>,
): NormalizedIssue[] {
  const required = schema["required"];
  if (!Array.isArray(required)) {
    return [];
  }
  const issues: NormalizedIssue[] = [];
  for (const name of required) {
    if (typeof name !== "string" || name in statics || name in dynamics) {
      continue;
    }
    issues.push({
      instancePath: "",
      schemaPath: "#/required",
      keyword: "required",
      params: { missingProperty: name },
      message: `must have required property '${name}'`,
    });
  }
  return issues;
}

/**
 * What an `as` that cannot name a binding says, or `undefined` when it can.
 *
 * Decided on the authored text rather than a resolved value, exactly as
 * expansion decides it: evaluating it first would make the outcome depend on
 * the host, because a bare identifier that happens to name a global resolves on
 * one runtime and throws on another.
 */
function componentCaptureViolation(segment: ComponentElement): string | undefined {
  if ("as" in segment.expressions) {
    return `Prop "as" on <${segment.name} /> must be a string literal.`;
  }
  const binding = validateBindingName(segment.props.as);
  return binding.ok ? undefined : `Prop "as" on <${segment.name} /> ${binding.error.message}`;
}

/** The code one parsing phase's failure is reported under. */
function codeForPhase(phase: DefinitionPhase): DocumentValidationCode {
  switch (phase) {
    case "source":
      return "source-invalid";
    case "target":
      return "target-invalid";
    case "frontmatter":
      return "frontmatter-invalid";
    case "props-declaration":
      return "props-declaration-invalid";
    case "returns-declaration":
      return "returns-declaration-invalid";
  }
}

/** What a source that could not be read says. */
function unreadable(path: string): string {
  return `Cannot read document source: ${path}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
