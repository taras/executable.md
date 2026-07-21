/**
 * Expansion engine (spec §5).
 *
 * Term-rewriting process: each component invocation is replaced by the
 * component's body, with <Content /> (and <Content slot="name" />)
 * substituted by the invocation's children and {meta.key}/{props.key}
 * resolved.
 *
 * Top-down expansion with raw child substitution: children are
 * substituted into the component body as raw (unexpanded) segments,
 * then the entire substituted body is expanded in document order.
 * This ensures code blocks before <Content /> (e.g., provider
 * middleware installation) execute before children's code blocks.
 */

import { scoped } from "effection";
import type { Operation } from "effection";
import { parse } from "acorn";
import type {
  Segment,
  TextSegment,
  ErrorSegment,
  ComponentInvocation,
  ComponentDefinition,
  EvalEnv,
  FunctionComponentDefinition,
  Json,
  CodeBlockContext,
} from "./types.ts";
import { interpolate } from "./interpolate.ts";
import { interpolateEvalBindings } from "./eval-interpolate.ts";
import {
  Component,
  applyModifiers,
  env,
  evalScope,
  expandInvocation,
  importComponent,
  raise,
} from "./component-api.ts";
import { DocumentationError } from "./errors.ts";
import { useEvalScope, unbox } from "@effectionx/scope-eval";
import type { EvalScope } from "@effectionx/scope-eval";
import { PropValidationError, validateProps } from "./validate.ts";
import { parseJson } from "./json.ts";
import { healSegment } from "./heal.ts";
import { scanSegments } from "./scanner.ts";
import { renderSegments } from "./render.ts";
import { remark } from "remark";
import { select as cssSelect } from "unist-util-select";
import { toString as mdastToString } from "mdast-util-to-string";

/**
 * Mutable counter for generating unique, deterministic blockId values.
 * Threaded through the expansion context to ensure stable IDs across
 * per-segment expansion calls.
 */
export interface BlockCounter {
  next(): number;
}

export function createBlockCounter(): BlockCounter {
  let id = 0;
  return { next: () => id++ };
}

// Providers install at "min" inside scoped() so nested components override
// ancestors (innermost min runs first) without leaking into siblings.
function provideEnv(value: EvalEnv): Operation<void> {
  return Component.around({ env: () => value }, { at: "min" });
}

function provideEvalScope(value: EvalScope): Operation<void> {
  return Component.around({ evalScope: () => value }, { at: "min" });
}

/**
 * Expand segments in a fresh scope whose eval env is the caller's values
 * plus an optional per-render override. The override is a shallow layer —
 * spread into a new object, never assigned onto the caller's env — so it is
 * discarded when the scope exits and cannot leak to the caller, siblings, or
 * later renders. Returns the expanded segments; callers decide whether to
 * render them to a string. Shared by `renderChildren`/`render` and `<Each>`.
 */
function expandChildrenScoped(
  segments: Segment[],
  callerEnv: EvalEnv | undefined,
  override: Record<string, unknown> | undefined,
  scope: EvalScope | undefined,
  meta: Record<string, unknown>,
  props: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
): Operation<Segment[]> {
  return scoped(function* () {
    yield* provideEnv({ values: { ...(callerEnv?.values ?? {}), ...(override ?? {}) } });
    if (scope) {
      yield* provideEvalScope(scope);
    }
    return yield* expandSegments(segments, meta, props, hideSet, counter);
  });
}

function validateRenderOverride(override: unknown): Record<string, unknown> | undefined {
  if (override === undefined) {
    return undefined;
  }
  if (typeof override !== "object" || override === null || Array.isArray(override)) {
    throw new Error("renderChildren(override) requires a plain object.");
  }
  // Reject Date/Map/class instances: only Object.prototype and null-prototype
  // records are plain objects whose keys layer cleanly over the caller env.
  const proto = Object.getPrototypeOf(override);
  if (proto !== null && proto !== Object.prototype) {
    throw new Error("renderChildren(override) requires a plain object.");
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(override)) {
    result[key] = value;
  }
  return result;
}

const MAX_EXPANSION_DEPTH = 64;
const IDENTIFIER_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/**
 * Expand an array of segments, resolving components and executing code blocks.
 *
 * Component import, modifier execution, bindings, and error policy are all
 * delivered contextually through the Component Api — install providers with
 * `Component.around(..., { at: "min" })` before expanding.
 *
 * @param counter - Optional block ID counter. If omitted, a local counter
 *   is created. For per-segment emission (§9), pass a shared counter so
 *   IDs are stable across calls.
 */
export function* expandSegments(
  segments: Segment[],
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter = createBlockCounter(),
): Operation<Segment[]> {
  const result: Segment[] = [];

  for (const segment of segments) {
    switch (segment.type) {
      case "text": {
        // Heal incomplete markdown constructs at segment boundaries (spec §2.3)
        // Runs synchronously — no yield, no journal entry
        const healed = healSegment(segment.content);
        // Interpolate {meta.key} and {props.key} — runtime, no journal
        const interpolated = interpolate(healed, parentMeta, parentProps);
        // Interpolate bare {name} refs from eval bindings (spec §6.4/§6.6).
        // Runs after meta/props interpolation so component contract takes
        // precedence. Only runs when a binding environment is in scope.
        const textEvalEnv = yield* env;
        const final = textEvalEnv
          ? interpolateEvalBindings(interpolated, textEvalEnv.values)
          : interpolated;
        result.push({ type: "text", content: final });
        break;
      }

      case "component": {
        // Extension hook: an installed vocabulary may claim this invocation
        // before built-in expansion. Returned error segments follow the
        // ambient raise policy, like any component-produced error.
        const handling = yield* expandInvocation(segment, {
          meta: parentMeta,
          props: parentProps,
          projectedEnv: segment.projectedEnv,
          expand: (segments) => expandSegments(segments, parentMeta, parentProps, hideSet, counter),
        });
        if (handling) {
          for (const handled of handling.segments) {
            if (handled.type === "error") {
              result.push(yield* raise(handled));
            } else {
              result.push(handled);
            }
          }
          break;
        }

        if (segment.name === "Output") {
          // Definition-owned <Output> is consumed by buildBody before it
          // reaches here. Reaching this branch means a misplaced or
          // dynamically scanned <Output> (e.g. render(markdown) content) —
          // diagnose it defensively per the ambient policy.
          result.push(yield* raise(misplacedOutputError()));
          break;
        }

        if (segment.name === "Capture") {
          const captureResult = yield* expandCapture(
            segment,
            parentMeta,
            parentProps,
            hideSet,
            counter,
          );
          if (captureResult) {
            result.push(yield* raise(captureResult));
          }
          break;
        }

        if (segment.name === "Each") {
          const eachResult = yield* expandEach(segment, parentMeta, parentProps, hideSet, counter);
          for (const eachSegment of eachResult) {
            if (eachSegment.type === "error") {
              result.push(yield* raise(eachSegment));
            } else {
              result.push(eachSegment);
            }
          }
          break;
        }

        const expanded = yield* expandComponent(
          segment.name,
          segment.props,
          segment.expressions,
          segment.children,
          hideSet,
          counter,
          segment.projectedEnv,
        );
        // Consumer boundary: re-raise transported error segments under the
        // ambient policy before appending them (spec §6.9).
        for (const expandedSegment of expanded) {
          if (expandedSegment.type === "error") {
            result.push(yield* raise(expandedSegment));
          } else {
            result.push(expandedSegment);
          }
        }
        break;
      }

      case "codeBlock": {
        // Interpolate eval bindings into content before the modifier chain.
        // A binding environment may not be in scope (e.g., blocks outside
        // component expansion) — fall back to the original content.
        //
        // Skip interpolation for eval blocks — they access bindings directly
        // via the env preamble (const { name } = env;). Interpolating would
        // mangle JS template literals like `${name}` into `$<value>`.
        const evalEnv = yield* env;
        const lastModifier = segment.modifiers[segment.modifiers.length - 1];
        const isEvalTerminal = lastModifier !== undefined && lastModifier.name === "eval";
        const interpolatedContent =
          evalEnv && !isEvalTerminal
            ? interpolateEvalBindings(segment.content, evalEnv.values)
            : segment.content;

        // Compose modifier chain from info string and run it.
        // blockId uses counter.next() for deterministic IDs that
        // survive per-segment expansion (see spec §6.1 Block ID counter).
        const context: CodeBlockContext = {
          language: segment.language,
          content: interpolatedContent,
          blockId: `eval:${parentMeta["componentName"] ?? "root"}:${counter.next()}`,
          componentName: parentMeta["componentName"] as string | undefined,
        };

        try {
          const codeResult = yield* applyModifiers(segment.modifiers, context);

          if (codeResult.exitCode !== 0 && codeResult.output === "") {
            result.push(
              yield* raise({
                type: "error",
                message: `Command failed (exit ${codeResult.exitCode}): ${codeResult.stderr}`,
                source: segment.content,
              }),
            );
          } else if (codeResult.output !== "") {
            result.push({
              type: "execOutput",
              command: segment.content,
              result: {
                exitCode: codeResult.exitCode,
                stdout: codeResult.output,
                stderr: codeResult.stderr,
              },
            });
          }
          // If output is empty and exit code is 0, nothing added (e.g., silent)
        } catch (error) {
          // A DocumentationError from nested expansion (e.g. renderChildren
          // inside an eval block) is our own fail-fast — never swallow it.
          if (error instanceof DocumentationError) {
            throw error;
          }
          result.push(
            yield* raise({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
              source: segment.content,
            }),
          );
        }
        break;
      }

      default: {
        if (segment.type === "error") {
          // Pre-existing error segments (e.g. slot/substitution errors) follow
          // the ambient policy.
          result.push(yield* raise(segment));
        } else {
          result.push(segment);
        }
      }
    }
  }

  return result;
}

function* expandCapture(
  segment: Extract<Segment, { type: "component" }>,
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
): Operation<ErrorSegment | undefined> {
  if (segment.selfClosing || segment.children.length === 0) {
    return {
      type: "error",
      message: '<Capture> must have content. Use <Capture as="x">...</Capture>.',
      source: "Capture",
    };
  }

  const propNames = Object.keys(segment.props);
  if (propNames.some((name) => name !== "as" && name !== "select")) {
    return {
      type: "error",
      message: '<Capture> only accepts "as" and "select" props.',
      source: "Capture",
    };
  }

  const expressionNames = Object.keys(segment.expressions);
  if (expressionNames.length > 0) {
    if (expressionNames.includes("as")) {
      return {
        type: "error",
        message: '<Capture as={...}> is invalid: "as" must be a string literal.',
        source: "Capture",
      };
    }
    if (!expressionNames.every((n) => n === "select")) {
      return {
        type: "error",
        message: '<Capture> only accepts "as" and "select" props.',
        source: "Capture",
      };
    }
  }

  if (segment.props.as === undefined) {
    return {
      type: "error",
      message: '<Capture> requires an "as" prop (non-empty string).',
      source: "Capture",
    };
  }

  const asBinding = validateBindingName(segment.props.as);
  if (!asBinding.ok) {
    return {
      type: "error",
      message: asBinding.error,
      source: "Capture",
    };
  }
  const bindingName = asBinding.value;
  if (bindingName === undefined) {
    return {
      type: "error",
      message: '<Capture> requires an "as" prop (non-empty string).',
      source: "Capture",
    };
  }

  const expandedChildren = yield* expandSegments(
    segment.children,
    parentMeta,
    parentProps,
    hideSet,
    counter,
  );
  const rendered = renderSegments(expandedChildren).replace(/\s+$/, "");

  // Apply CSS selector if select prop is present (spec §6.5)
  let captured = rendered;
  const selectProp = segment.props.select as string | undefined;
  if (typeof selectProp === "string" && selectProp.length > 0) {
    const tree = remark().parse(captured);
    // deno-lint-ignore no-explicit-any
    const node = cssSelect(selectProp, tree as any);
    if (node) {
      captured = "value" in node ? String(node.value) : mdastToString(node);
    }
  }

  const bindingEnv = yield* env;
  if (!bindingEnv) {
    return {
      type: "error",
      message: "<Capture> requires an evaluation environment.",
      source: "Capture",
    };
  }
  bindingEnv.values[bindingName] = captured;
  return undefined;
}

function eachError(message: string): ErrorSegment {
  return { type: "error", message, source: "Each" };
}

const EACH_PROPS = new Set(["in", "let", "as"]);

function* expandEach(
  segment: Extract<Segment, { type: "component" }>,
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
): Operation<Segment[]> {
  const unknownProp = [...Object.keys(segment.props), ...Object.keys(segment.expressions)].find(
    (n) => !EACH_PROPS.has(n),
  );
  if (unknownProp !== undefined) {
    return [eachError(`<Each> only accepts "in", "let", and "as" props. Got: "${unknownProp}".`)];
  }

  if ("let" in segment.expressions) {
    return [eachError('Prop "let" on <Each /> must be a string literal.')];
  }
  if (segment.props.let === undefined) {
    return [eachError('<Each> requires a "let" prop (the item binding name).')];
  }
  const letBinding = validateBindingName(segment.props.let);
  if (!letBinding.ok) {
    return [eachError(`Prop "let" on <Each /> ${letBinding.error}`)];
  }
  const name = letBinding.value;
  if (name === undefined) {
    return [eachError('<Each> requires a "let" prop (the item binding name).')];
  }

  if ("as" in segment.expressions) {
    return [eachError('Prop "as" on <Each /> must be a string literal.')];
  }
  const asResult = validateBindingName(segment.props.as);
  if (!asResult.ok) {
    return [eachError(`Prop "as" on <Each /> ${asResult.error}`)];
  }
  const asBinding = asResult.value;

  let items: Json | undefined;
  if ("in" in segment.props) {
    items = segment.props.in;
  } else if ("in" in segment.expressions) {
    try {
      const resolved = yield* resolveExpressionProps(
        {},
        { in: segment.expressions.in },
        "Each",
        segment.projectedEnv,
      );
      items = resolved.in;
    } catch (error) {
      return [eachError(error instanceof Error ? error.message : String(error))];
    }
  } else {
    return [eachError('<Each> requires an "in" prop (the array to iterate).')];
  }
  if (!Array.isArray(items)) {
    return [eachError('Prop "in" on <Each /> must resolve to an array.')];
  }

  // Effective caller env honors projection through <Content />, mirroring
  // expandComponent, so a projected <Each> resolves both lexical caller
  // bindings and the current component's bindings.
  const contextEnv = yield* env;
  const callerEnv = segment.projectedEnv
    ? { values: { ...segment.projectedEnv.values, ...(contextEnv?.values ?? {}) } }
    : contextEnv;
  const parentEvalScope = yield* evalScope;

  const out: Segment[] = [];
  for (const item of items) {
    const expanded = yield* expandChildrenScoped(
      segment.children,
      callerEnv ?? undefined,
      { [name]: item },
      parentEvalScope ?? undefined,
      parentMeta,
      parentProps,
      hideSet,
      counter,
    );
    out.push(...expanded);
  }

  if (asBinding === undefined) {
    return out;
  }

  // Consumer boundary (spec §6.9): a capture never swallows an error. Hand the
  // error segments back so expandSegments applies the ambient policy exactly
  // once — a collecting policy keeps them in the document, a throwing policy
  // aborts — and leave the binding unset either way.
  const errors = out.filter((outSegment) => outSegment.type === "error");
  if (errors.length > 0) {
    return errors;
  }

  const captureEnv = yield* env;
  if (!captureEnv) {
    return [eachError('Prop "as" on <Each /> requires a parent evaluation environment.')];
  }
  captureEnv.values[asBinding] = renderSegments(out);
  return [];
}

function* expandComponent(
  name: string,
  props: Record<string, Json>,
  expressions: Record<string, string>,
  children: Segment[],
  hideSet: Set<string>,
  counter: BlockCounter,
  projectedEnv?: EvalEnv,
): Operation<Segment[]> {
  // Cycle detection — Prosser's algorithm
  if (hideSet.has(name)) {
    return [
      yield* raise({
        type: "error",
        message: `Cycle detected: ${name} is already being expanded (hide set: ${[...hideSet].join(" → ")})`,
        source: name,
      }),
    ];
  }

  if (hideSet.size >= MAX_EXPANSION_DEPTH) {
    return [
      yield* raise({
        type: "error",
        message: `Maximum expansion depth (${MAX_EXPANSION_DEPTH}) exceeded`,
        source: name,
      }),
    ];
  }

  let imported: ComponentDefinition | FunctionComponentDefinition;
  try {
    imported = yield* importComponent(name);
  } catch (error) {
    return [
      yield* raise({
        type: "error",
        message:
          error instanceof Error
            ? `Failed to import component ${name}: ${error.message}`
            : `Failed to import component ${name}: ${String(error)}`,
        source: name,
      }),
    ];
  }

  // Function component: call the generator function directly
  if (imported.kind === "function") {
    return yield* expandFunctionComponent(
      name,
      props,
      expressions,
      children,
      imported,
      hideSet,
      counter,
      projectedEnv,
    );
  }

  const definition = imported;

  // Structural preflight (spec §6.9): validate <Output> placement against the
  // component's own source AST before any part of its body executes. A
  // structurally invalid component runs no eval, exec, Capture, nested
  // components, or other side effects.
  const placementError = validateOutputPlacement(definition.bodySegments);
  if (placementError) {
    return [yield* raise(placementError)];
  }

  // Resolve eval expression props against env.values using the shared
  // VM context. This must happen before validation so that resolved
  // values can be type-checked. See spec §5.1 (expression prop evaluation).
  let resolvedProps: Record<string, Json>;
  try {
    resolvedProps = yield* resolveExpressionProps(props, expressions, name, projectedEnv);
  } catch (error) {
    return [
      yield* raise({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        source: name,
      }),
    ];
  }

  if ("as" in expressions) {
    return [
      yield* raise({
        type: "error",
        message: `Prop "as" on <${name} /> must be a string literal.`,
        source: name,
      }),
    ];
  }

  // Validate props against declared inputs.
  // Strip the `slot` prop before validation — it is consumed by the
  // expansion engine for slot assignment, not forwarded to the child.
  let validatedProps: Record<string, Json>;
  let asBinding: string | undefined;
  try {
    const binding = validateBindingName(resolvedProps.as);
    if (!binding.ok) {
      throw new Error(`Prop "as" on <${name} /> ${binding.error}`);
    }
    asBinding = binding.value;

    const { slot: _slot, as: _as, ...propsForValidation } = resolvedProps;
    validatedProps = validateProps(name, propsForValidation, definition.inputs);
  } catch (error) {
    return [yield* raise(propValidationErrorSegment(error, name))];
  }

  // Capture the caller's eval environment before creating the component's
  // own env. Children are caller-provided content — expression props like
  // {pr} should resolve against the scope where the JSX was written, not
  // the component that renders <Content />.
  //
  // For multi-level nesting (Root → Provider → Instruction → ReviewBody),
  // the projectedEnv from the outer caller must be merged with the current
  // context env so that ancestor bindings propagate through all levels.
  // The current context env's bindings take precedence (innermost-wins).
  const contextEnv = yield* env;
  const callerEvalEnv = projectedEnv
    ? { values: { ...projectedEnv.values, ...(contextEnv?.values ?? {}) } }
    : contextEnv;

  // Recurse with augmented hide set.
  // Each component gets its own fresh binding environment so that
  // eval blocks within a component share bindings but don't leak
  // into parent or sibling components. This is critical for the
  // provider pattern where each provider has isolated port/URL bindings.
  //
  // Each component also gets its own EvalScope, created as a child of
  // the parent component's eval scope. This ensures that middleware
  // installed via `persist eval` blocks (e.g., Sample.around()) is
  // scoped to the component. Nested providers produce a scope chain
  // where innermost middleware runs first (innermost-wins), and
  // next() delegates to the parent scope's middleware.
  const newHideSet = new Set([...hideSet, name]);
  const componentEnv: EvalEnv = { values: { ...validatedProps } };

  // Create per-component eval scope as a child of the parent eval scope.
  // By creating it via parentEvalScope.eval(), the child's spawned task
  // lives inside the parent's scope — Effection's scope prototype chain
  // ensures scope.reduce() walks child → parent when resolving middleware.
  const parentEvalScope = yield* evalScope;
  let childEvalScope: EvalScope | undefined = undefined;
  if (parentEvalScope) {
    const result = yield* parentEvalScope.eval(() => useEvalScope());
    childEvalScope = unbox(result) as EvalScope;
  }

  // Inject render closures into the component's binding environment.
  // These are generator functions that eval blocks can yield* to render
  // content within the current expansion context.
  //
  // renderChildren() — expands and renders this component's children.
  // render(markdown) — scans, expands, and renders arbitrary markdown.
  //
  // Both use parentEvalScope, not childEvalScope. Children are
  // caller-provided content — they expand in the caller's scope
  // context. The component's childEvalScope and its sequential
  // channel are for the component's own persist eval blocks
  // (middleware installation, etc.), not for expanding caller content.
  //
  // Children may contain operations that create resources (nested
  // components, persist eval blocks, daemons), but those resources
  // are scoped to the expansion — their lifecycle is bound by their
  // place in the structured concurrency tree. Inner components create
  // their own child scopes off parentEvalScope, and ancestor
  // middleware is visible through Effection's scope prototype chain.
  //
  // Both install env/evalScope middleware inside a fresh scope so the full
  // expansion context is available regardless of which task the closure
  // runs in (e.g., inside evalScope.eval()).
  //
  // These are non-serializable (functions) so serializeExports silently
  // omits them from the journal.
  const capturedMeta = definition.meta;
  const capturedProps = validatedProps;
  // Children are caller-provided content, not the component's own body.
  // Use the parent's hide set (without the current component name) so
  // that caller-provided children can reference the same component name
  // without triggering false cycle detection. True cycles in a component's
  // body are still caught because body expansion uses newHideSet.
  const capturedChildrenHideSet = hideSet;
  const capturedParentEvalScope = parentEvalScope;
  // Children are caller-provided content. Use the caller's eval env so
  // expression props (e.g., {pr}) resolve against the scope where the
  // JSX was written, not the wrapping component's env. Falls back to
  const capturedCallerEnv = callerEvalEnv ?? componentEnv;

  const renderInCallerScope = (segments: Segment[], override?: Record<string, unknown>) =>
    (function* () {
      const expanded = yield* expandChildrenScoped(
        segments,
        capturedCallerEnv,
        override,
        capturedParentEvalScope,
        capturedMeta,
        capturedProps,
        capturedChildrenHideSet,
        counter,
      );
      return renderSegments(expanded);
    })();

  componentEnv.values.renderChildren = (override?: unknown) =>
    renderInCallerScope(children, validateRenderOverride(override));

  componentEnv.values.render = (markdown: string) => renderInCallerScope(scanSegments(markdown));

  const expanded = yield* scoped(function* () {
    yield* provideEnv(componentEnv);
    if (childEvalScope) {
      yield* provideEvalScope(childEvalScope);
    }
    return yield* expandBody(
      definition.bodySegments,
      children,
      definition.meta,
      validatedProps,
      newHideSet,
      counter,
      callerEvalEnv ?? undefined,
    );
  });

  if (asBinding) {
    // Consumer boundary (spec §6.9): a capture never swallows an error. Hand
    // the error segments back so expandSegments applies the ambient policy
    // exactly once — a collecting policy keeps them in the document, a
    // throwing policy aborts — and leave the binding unset either way.
    const errors = expanded.filter((capturedSegment) => capturedSegment.type === "error");
    if (errors.length > 0) {
      return errors;
    }

    const parentEnv = yield* env;
    if (!parentEnv) {
      return [
        yield* raise({
          type: "error",
          message: `Prop "as" on <${name} /> requires a parent evaluation environment.`,
          source: name,
        }),
      ];
    }
    parentEnv.values[asBinding] = renderSegments(expanded);
    return [];
  }

  return expanded;
}

/**
 * Expand a function component (.ts file).
 *
 * Function components are generator functions that return a rendered
 * string. They receive validated props, raw child segments, and an
 * `expandChildren` helper that renders children.
 */
function* expandFunctionComponent(
  name: string,
  props: Record<string, Json>,
  expressions: Record<string, string>,
  children: Segment[],
  definition: FunctionComponentDefinition,
  hideSet: Set<string>,
  counter: BlockCounter,
  projectedEnv?: EvalEnv,
): Operation<Segment[]> {
  if ("as" in expressions) {
    return [
      yield* raise({
        type: "error",
        message: `Prop "as" on <${name} /> must be a string literal.`,
        source: name,
      }),
    ];
  }

  // Resolve expression props
  let resolvedProps: Record<string, Json>;
  try {
    resolvedProps = yield* resolveExpressionProps(props, expressions, name, projectedEnv);
  } catch (error) {
    return [
      yield* raise({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        source: name,
      }),
    ];
  }

  // Strip slot prop before validation
  const asBindingResult = validateBindingName(resolvedProps.as);
  if (!asBindingResult.ok) {
    return [
      yield* raise({
        type: "error",
        message: `Prop "as" on <${name} /> ${asBindingResult.error}`,
        source: name,
      }),
    ];
  }
  const asBinding = asBindingResult.value;
  const { slot: _slot, as: _as, ...propsForValidation } = resolvedProps;

  // Validate props
  let validatedProps: Record<string, Json>;
  try {
    validatedProps = validateProps(name, propsForValidation, definition.inputs);
  } catch (error) {
    return [yield* raise(propValidationErrorSegment(error, name))];
  }

  const slots = partitionBySlot(children);

  // Call the function component with content middleware in scope so it can
  // render children via `yield* useContent()` / `useContent("slot")`.
  try {
    const output = yield* scoped(function* () {
      yield* Component.around(
        {
          *content([slotName], _next) {
            if (slotName !== undefined) {
              const slotChildren = (slots.named.get(slotName) ?? []).map(stripSlotProp);
              if (slotChildren.length === 0) {
                return "";
              }
              const expanded = yield* expandSegments(slotChildren, {}, {}, hideSet, counter);
              return renderSegments(expanded);
            }
            const expanded = yield* expandSegments(slots.default, {}, {}, hideSet, counter);
            return renderSegments(expanded);
          },
        },
        { at: "min" },
      );
      return yield* definition.fn(validatedProps);
    });
    if (asBinding) {
      const parentEnv = yield* env;
      if (!parentEnv) {
        return [
          yield* raise({
            type: "error",
            message: `Prop "as" on <${name} /> requires a parent evaluation environment.`,
            source: name,
          }),
        ];
      }
      parentEnv.values[asBinding] = output;
      return [];
    }
    return [{ type: "text", content: output }];
  } catch (error) {
    // A DocumentationError from a content-rendering path (useContent) is
    // fail-fast — propagate it unchanged.
    if (error instanceof DocumentationError) {
      throw error;
    }
    return [
      yield* raise({
        type: "error",
        message:
          error instanceof Error
            ? `Function component ${name} error: ${error.message}`
            : `Function component ${name} error: ${String(error)}`,
        source: name,
      }),
    ];
  }
}

export function validateBindingName(
  value: Json | undefined,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "must be a non-empty string literal." };
  }
  if (value.length === 0) {
    return { ok: false, error: "must be non-empty." };
  }
  if (!IDENTIFIER_RE.test(value)) {
    return {
      ok: false,
      error: `must be a valid JavaScript identifier. Got: "${value}"`,
    };
  }
  // The identifier shape is not sufficient: reserved and contextual words
  // (in, let, await, ...) match the regex but cannot form an ES-module
  // binding, which is where these names end up (eval preamble destructures
  // `const { name } = env;`). Parse the destructuring shape to reject them.
  if (!isModuleBindingName(value)) {
    return {
      ok: false,
      error: `must be a valid JavaScript binding name. Got: "${value}"`,
    };
  }
  return { ok: true, value };
}

function isModuleBindingName(name: string): boolean {
  try {
    parse(`const { ${name} } = 0;`, { ecmaVersion: "latest", sourceType: "module" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve eval expression props against env.values using the shared VM
 * context. Merges resolved values into the props record.
 *
 * Expression props are stored as raw expression text in the
 * `expressions` field of `ComponentInvocation`. At expansion time,
 * they are evaluated as JavaScript using `new Function()` with
 * `env.values` destructured into scope.
 *
 * Errors are thrown (not ErrorSegments), consistent with PropValidationError.
 *
 * Uses `new Function()` instead of `node:vm` — Deno's permission model
 * provides the security boundary. The expression text comes from the
 * document author (trusted), and results must pass serialization check.
 */
function* resolveExpressionProps(
  props: Record<string, Json>,
  expressions: Record<string, string>,
  componentName: string,
  explicitEnv?: EvalEnv,
): Operation<Record<string, Json>> {
  // Start with already-resolved props
  const resolved = { ...props };

  // Nothing to evaluate
  if (Object.keys(expressions).length === 0) {
    return resolved;
  }

  const contextEnv = yield* env;

  // For projected children (substituted via <Content />), merge the
  // caller's env (explicitEnv) with the wrapping component's env
  // (contextEnv). The component's env takes priority because its eval
  // blocks run before <Content /> and may define bindings that children
  // reference. The caller's env provides fallback bindings from the
  const evalEnv =
    explicitEnv && contextEnv
      ? { values: { ...explicitEnv.values, ...contextEnv.values } }
      : (contextEnv ?? explicitEnv);

  if (!evalEnv) {
    const names = Object.keys(expressions).join(", ");
    throw new Error(
      `Expression props (${names}) on <${componentName} /> cannot be ` +
        `resolved: no eval context available. Expression props require ` +
        `a preceding eval block that defines the referenced bindings.`,
    );
  }

  const envKeys = Object.keys(evalEnv.values);
  const envValues = envKeys.map((k) => evalEnv.values[k]);

  for (const [propName, expression] of Object.entries(expressions)) {
    try {
      // Evaluate expression with env.values destructured into scope
      // via new Function() parameter injection.
      const fn = new Function(...envKeys, `return (${expression})`);
      const result = fn(...envValues);

      if (typeof result === "function" || typeof result === "undefined") {
        throw new Error(
          `Expression prop "${propName}" on <${componentName} /> evaluated ` +
            `to a non-serializable value (${typeof result}). Props must be ` +
            `JSON-serializable.`,
        );
      }

      let serialized: Json;
      try {
        serialized = JSON.parse(JSON.stringify(result)) as Json;
      } catch {
        throw new Error(
          `Expression prop "${propName}" on <${componentName} /> evaluated ` +
            `to a non-serializable value (${typeof result}). Props must be ` +
            `JSON-serializable.`,
        );
      }

      resolved[propName] = serialized;
    } catch (error) {
      if (error instanceof Error && error.message.includes("non-serializable")) {
        throw error;
      }
      throw new Error(
        `Failed to evaluate expression prop "${propName}={${expression}}" ` +
          `on <${componentName} />: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return resolved;
}

/**
 * Slot name validation pattern: must start with a letter, followed by
 * letters, digits, underscores, or hyphens.
 */
const SLOT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function propValidationErrorSegment(error: unknown, name: string): ErrorSegment {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PropValidationError) {
    return {
      type: "error",
      message,
      source: name,
      cause: parseJson({ componentName: error.componentName, errors: error.issues }),
    };
  }
  return { type: "error", message, source: name };
}

/**
 * Validate a slot name. Returns an ErrorSegment if invalid, undefined if ok.
 */
function validateSlotName(name: string, source: string): ErrorSegment | undefined {
  if (name === "") {
    return {
      type: "error",
      message: "Invalid slot name: slot name must not be empty",
      source,
    };
  }
  if (!SLOT_NAME_RE.test(name)) {
    return {
      type: "error",
      message: `Invalid slot name "${name}": must match [a-zA-Z][a-zA-Z0-9_-]*`,
      source,
    };
  }
  return undefined;
}

/**
 * Slot assignment: returns the slot name if the segment is a component
 * invocation with a `slot` prop, undefined otherwise.
 *
 * Only ComponentInvocation segments can carry a `slot` prop. Text
 * segments and code blocks are always default-slot content.
 */
function getSlotAssignment(segment: Segment): string | undefined {
  if (segment.type === "component" && segment.props.slot !== undefined) {
    return String(segment.props.slot);
  }
  return undefined;
}

/**
 * Slot map produced by partitionBySlot.
 */
export interface SlotMap {
  /** Children without a `slot` prop. */
  default: Segment[];
  /** Children keyed by slot name. */
  named: Map<string, Segment[]>;
  /** Validation errors from invalid slot names. */
  errors: ErrorSegment[];
}

/**
 * Partition children into slot buckets. Only ComponentInvocation segments
 * with a `slot` prop are assigned to named slots. Everything else goes
 * to the default slot.
 *
 * Invalid slot names produce ErrorSegments in the `errors` array.
 */
export function partitionBySlot(children: Segment[]): SlotMap {
  const named = new Map<string, Segment[]>();
  const defaultSlot: Segment[] = [];
  const errors: ErrorSegment[] = [];

  for (const child of children) {
    const slotName = getSlotAssignment(child);
    if (slotName !== undefined) {
      const error = validateSlotName(slotName, `slot="${slotName}"`);
      if (error) {
        errors.push(error);
        continue;
      }
      let bucket = named.get(slotName);
      if (!bucket) {
        bucket = [];
        named.set(slotName, bucket);
      }
      bucket.push(child);
    } else {
      defaultSlot.push(child);
    }
  }

  return { default: defaultSlot, named, errors };
}

/**
 * Strip the `slot` prop from a segment. Returns a shallow clone with
 * `slot` removed from props. Non-component segments pass through unchanged.
 */
export function stripSlotProp(segment: Segment): Segment {
  if (segment.type === "component" && "slot" in segment.props) {
    const { slot: _, ...rest } = segment.props;
    return { ...segment, props: rest };
  }
  return segment;
}

type ProjectFn = (segments: Segment[]) => Segment[];

/** Mutable flag so slot validation errors are emitted only once. */
interface SubstitutionState {
  errorsEmitted: boolean;
}

/**
 * Build the projection function that tags substituted children with the
 * caller's eval env so their expression props resolve in the caller's scope.
 */
function makeProjectFn(callerEnv: EvalEnv | undefined): ProjectFn {
  const project: ProjectFn = (segments) => {
    if (!callerEnv) {
      return segments;
    }
    return segments.map((seg) => {
      if (seg.type === "component") {
        return {
          ...seg,
          projectedEnv: callerEnv,
          children: project(seg.children),
        };
      }
      return seg;
    });
  };
  return project;
}

/**
 * Replace `<Content />` / `<Content slot="X" />` in a segment list with the
 * caller's children (partitioned by slot) and interpolate {meta}/{props} in
 * text. Slot validation errors are emitted once, at the first projection
 * point, tracked via the shared `state`.
 */
function substituteSegmentList(
  segments: Segment[],
  slots: SlotMap,
  meta: Record<string, unknown>,
  props: Record<string, Json>,
  project: ProjectFn,
  state: SubstitutionState,
): Segment[] {
  return segments.flatMap((segment) => {
    if (segment.type === "component" && segment.name === "Content") {
      const targetSlot = segment.props.slot;
      const pendingErrors = !state.errorsEmitted ? slots.errors : [];
      if (pendingErrors.length > 0) {
        state.errorsEmitted = true;
      }

      if (targetSlot !== undefined) {
        const slotKey = String(targetSlot);
        return [...pendingErrors, ...project((slots.named.get(slotKey) ?? []).map(stripSlotProp))];
      }
      return [...pendingErrors, ...project(slots.default)];
    }
    if (segment.type === "text") {
      return [{ ...segment, content: interpolate(segment.content, meta, props) }];
    }
    return [segment];
  });
}

/**
 * Replace `<Content />` and `<Content slot="X" />` invocations with the
 * caller's children, partitioned by slot assignment.
 * Also interpolates {meta.key} and {props.key} in text segments.
 *
 * When no `slot` props are present anywhere, this behaves identically
 * to the original single-slot substituteContent.
 */
function substituteContent(
  bodySegments: Segment[],
  children: Segment[],
  meta: Record<string, unknown>,
  props: Record<string, Json>,
  callerEnv?: EvalEnv,
): Segment[] {
  const slots = partitionBySlot(children);
  const state: SubstitutionState = { errorsEmitted: false };
  const project = makeProjectFn(callerEnv);
  return substituteSegmentList(bodySegments, slots, meta, props, project, state);
}

interface BodyChunk {
  /** true = a rendered `<Output>` region; false = documentation (executed, not rendered). */
  output: boolean;
  segments: Segment[];
}

function isTopLevelOutput(segment: Segment): boolean {
  return segment.type === "component" && segment.name === "Output";
}

export function bodyHasOutput(bodySegments: Segment[]): boolean {
  return bodySegments.some(isTopLevelOutput);
}

function misplacedOutputError(): ErrorSegment {
  return {
    type: "error",
    message:
      "<Output> must be a direct top-level child of the component or document " +
      "that declares it. For conditional rendering, use <Show> inside <Output>.",
    source: "Output",
  };
}

function previewOutput(segment: ComponentInvocation): string {
  const text = segment.children
    .filter((child): child is TextSegment => child.type === "text")
    .map((child) => child.content)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) {
    return "<Output> (empty)";
  }
  const clipped = text.slice(0, 40);
  return `<Output> containing "${clipped}${text.length > 40 ? "…" : ""}"`;
}

/**
 * Structural preflight (spec §6.9). Validates `<Output>` placement against the
 * body's own source AST. Only a direct top-level `<Output>` is a valid
 * declaration; any `<Output>` at depth > 0 — including inside unreachable or
 * discarded children — is a placement violation. All violations are combined
 * into a single aggregate ErrorSegment. Returns undefined when placement is
 * valid.
 */
export function validateOutputPlacement(bodySegments: Segment[]): ErrorSegment | undefined {
  const violations: string[] = [];

  const walk = (segments: Segment[], depth: number): void => {
    for (const segment of segments) {
      if (segment.type !== "component") {
        continue;
      }
      if (segment.name === "Output" && depth > 0) {
        violations.push(previewOutput(segment));
      }
      walk(segment.children, depth + 1);
    }
  };

  walk(bodySegments, 0);

  if (violations.length === 0) {
    return undefined;
  }

  const list = violations.map((entry) => `  - ${entry}`).join("\n");
  return {
    type: "error",
    message:
      "<Output> must be a direct top-level child of the component or document " +
      "that declares it. For conditional rendering, use <Show> inside " +
      `<Output>. Misplaced <Output> found:\n${list}`,
    source: "Output",
  };
}

function validateOutputProps(segment: ComponentInvocation): ErrorSegment | undefined {
  const hasProps = Object.keys(segment.props).length > 0;
  const hasExpressions = Object.keys(segment.expressions).length > 0;
  if (hasProps || hasExpressions) {
    return { type: "error", message: "<Output> accepts no props.", source: "Output" };
  }
  return undefined;
}

/**
 * Partition a definition body into ordered chunks (spec §6.9). Output policy
 * is determined by definition provenance — top-level `<Output>` segments in
 * the source, before `<Content />` substitution — so caller-projected
 * `<Output>` can neither activate nor alter it. `<Content />` inside a
 * top-level `<Output>` is substituted one level in; slot errors are emitted
 * once across the whole body via the shared substitution state.
 */
function buildBody(
  bodySegments: Segment[],
  children: Segment[],
  meta: Record<string, unknown>,
  props: Record<string, Json>,
  callerEnv: EvalEnv | undefined,
): BodyChunk[] {
  const slots = partitionBySlot(children);
  const state: SubstitutionState = { errorsEmitted: false };
  const project = makeProjectFn(callerEnv);
  const chunks: BodyChunk[] = [];

  for (const segment of bodySegments) {
    if (segment.type === "component" && segment.name === "Output") {
      const propsError = validateOutputProps(segment);
      if (propsError) {
        chunks.push({ output: true, segments: [propsError] });
        continue;
      }
      const outputSegments = substituteSegmentList(
        segment.children,
        slots,
        meta,
        props,
        project,
        state,
      );
      chunks.push({ output: true, segments: outputSegments });
      continue;
    }

    const docSegments = substituteSegmentList([segment], slots, meta, props, project, state);
    chunks.push({ output: false, segments: docSegments });
  }

  return chunks;
}

/**
 * Expand a definition body (spec §6.9). Without a top-level `<Output>`, the
 * whole body renders (backward compatible). With `<Output>`, only the declared
 * regions render; documentation executes for its side effects under a throwing
 * raise policy (fail-fast) and its rendered result is discarded; output
 * regions install a collecting raise that shadows any inherited throwing
 * middleware (innermost min runs first), so their errors render as comments.
 * Regions and documentation run in document order, so output can depend on
 * bindings computed by preceding documentation.
 */
export function* expandBody(
  bodySegments: Segment[],
  children: Segment[],
  meta: Record<string, unknown>,
  props: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
  callerEnv: EvalEnv | undefined,
): Operation<Segment[]> {
  if (!bodyHasOutput(bodySegments)) {
    const substituted = substituteContent(bodySegments, children, meta, props, callerEnv);
    return yield* expandSegments(substituted, meta, props, hideSet, counter);
  }

  const chunks = buildBody(bodySegments, children, meta, props, callerEnv);
  const output: Segment[] = [];

  for (const chunk of chunks) {
    if (chunk.output) {
      const expanded = yield* scoped(function* () {
        yield* Component.around(
          {
            // deno-lint-ignore require-yield
            *raise([error], _next) {
              return error;
            },
          },
          { at: "min" },
        );
        return yield* expandSegments(chunk.segments, meta, props, hideSet, counter);
      });
      output.push(...expanded);
    } else {
      // Documentation: execute for side effects, discard rendered output.
      yield* scoped(function* () {
        yield* Component.around(
          {
            // deno-lint-ignore require-yield
            *raise([error], _next) {
              throw new DocumentationError(error);
            },
          },
          { at: "min" },
        );
        return yield* expandSegments(chunk.segments, meta, props, hideSet, counter);
      });
    }
  }

  return output;
}
