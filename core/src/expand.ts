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

import { useScope } from "effection";
import type { Operation } from "effection";
import { ContentCtx } from "./content-context.ts";
import type { ContentHandle } from "./content-context.ts";
import type {
  Segment,
  ErrorSegment,
  ComponentDefinition,
  FunctionComponentDefinition,
  Json,
  CodeBlockContext,
  CodeBlockResult,
  Modifier,
} from "./types.ts";
import { interpolate } from "./interpolate.ts";
import { interpolateEvalBindings } from "./eval-interpolate.ts";
import { EvalEnvCtx, EvalScopeCtx } from "./eval-env.ts";
import type { EvalEnv } from "./eval-env.ts";
import { useEvalScope, unbox } from "@effectionx/scope-eval";
import type { EvalScope } from "@effectionx/scope-eval";
import { validateProps } from "./validate.ts";
import { healSegment } from "./heal.ts";
import { scanSegments } from "./scanner.ts";
import { renderSegments } from "./render.ts";

// ---------------------------------------------------------------------------
// Block ID counter (spec §6.1)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Types for the expansion context
// ---------------------------------------------------------------------------

/**
 * Function that imports a component by name.
 * During live execution: resolves + reads + hashes via durable effect.
 * During replay: returns stored result.
 */
export type ComponentImporter = (
  name: string,
) => Operation<ComponentDefinition | FunctionComponentDefinition>;

/**
 * Function that executes a modifier chain for a code block.
 */
export type ModifierChainRunner = (
  modifiers: Modifier[],
  context: CodeBlockContext,
) => Operation<CodeBlockResult>;

export interface ExpansionContext {
  importComponent: ComponentImporter;
  runModifierChain: ModifierChainRunner;
}

// ---------------------------------------------------------------------------
// Expansion algorithm (spec §5.1)
// ---------------------------------------------------------------------------

const MAX_EXPANSION_DEPTH = 64;
const IDENTIFIER_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/**
 * Expand an array of segments, resolving components and executing code blocks.
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
  ctx: ExpansionContext,
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
        const interpolated = interpolate(
          healed,
          parentMeta,
          parentProps,
        );
        result.push({ type: "text", content: interpolated });
        break;
      }

      case "component": {
        if (segment.name === "Capture") {
          const captureResult = yield* expandCapture(
            segment,
            parentMeta,
            parentProps,
            hideSet,
            ctx,
            counter,
          );
          if (captureResult) {
            result.push(captureResult);
          }
          break;
        }

        const expanded = yield* expandComponent(
          segment.name,
          segment.props,
          segment.expressions,
          segment.children,
          hideSet,
          ctx,
          counter,
        );
        result.push(...expanded);
        break;
      }

      case "codeBlock": {
        // Interpolate eval bindings into content before the modifier chain.
        // EvalEnvCtx may not be set (e.g., blocks outside component expansion),
        // so we use .get() and fall back to the original content.
        //
        // Skip interpolation for eval blocks — they access bindings directly
        // via the env preamble (const { name } = env;). Interpolating would
        // mangle JS template literals like `${name}` into `$<value>`.
        const evalEnv = yield* EvalEnvCtx.get();
        const lastModifier = segment.modifiers[segment.modifiers.length - 1];
        const isEvalTerminal = lastModifier !== undefined &&
          lastModifier.name === "eval";
        const interpolatedContent = evalEnv && !isEvalTerminal
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
          const codeResult = yield* ctx.runModifierChain(
            segment.modifiers,
            context,
          );

          if (codeResult.exitCode !== 0 && codeResult.output === "") {
            result.push({
              type: "error",
              message: `Command failed (exit ${codeResult.exitCode}): ${codeResult.stderr}`,
              source: segment.content,
            });
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
          result.push({
            type: "error",
            message:
              error instanceof Error ? error.message : String(error),
            source: segment.content,
          });
        }
        break;
      }

      default:
        result.push(segment);
    }
  }

  return result;
}

function* expandCapture(
  segment: Extract<Segment, { type: "component" }>,
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  ctx: ExpansionContext,
  counter: BlockCounter,
): Operation<ErrorSegment | undefined> {
  if (segment.selfClosing || segment.children.length === 0) {
    return {
      type: "error",
      message: '<Capture> must have children. Use <Capture as="x">...</Capture>.',
      source: "Capture",
    };
  }

  const propNames = Object.keys(segment.props);
  if (propNames.some((name) => name !== "as")) {
    return {
      type: "error",
      message: '<Capture> only accepts the "as" prop.',
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
    return {
      type: "error",
      message: '<Capture> only accepts the "as" prop.',
      source: "Capture",
    };
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
    ctx,
    counter,
  );
  const rendered = renderSegments(expandedChildren).replace(/\s+$/, "");

  const env = yield* EvalEnvCtx.get();
  if (!env) {
    return {
      type: "error",
      message: "<Capture> requires an evaluation environment.",
      source: "Capture",
    };
  }
  env.values[bindingName] = rendered;
  return undefined;
}

// ---------------------------------------------------------------------------
// Component expansion with cycle detection (spec §5.2)
// ---------------------------------------------------------------------------

function* expandComponent(
  name: string,
  props: Record<string, Json>,
  expressions: Record<string, string>,
  children: Segment[],
  hideSet: Set<string>,
  ctx: ExpansionContext,
  counter: BlockCounter,
): Operation<Segment[]> {
  // Cycle detection — Prosser's algorithm
  if (hideSet.has(name)) {
    return [
      {
        type: "error",
        message: `Cycle detected: ${name} is already being expanded (hide set: ${[...hideSet].join(" → ")})`,
        source: name,
      },
    ];
  }

  if (hideSet.size >= MAX_EXPANSION_DEPTH) {
    return [
      {
        type: "error",
        message: `Maximum expansion depth (${MAX_EXPANSION_DEPTH}) exceeded`,
        source: name,
      },
    ];
  }

  // Import — single durable effect (resolve + read + hash)
  let imported: ComponentDefinition | FunctionComponentDefinition;
  try {
    imported = yield* ctx.importComponent(name);
  } catch (error) {
    return [
      {
        type: "error",
        message:
          error instanceof Error
            ? `Failed to import component ${name}: ${error.message}`
            : `Failed to import component ${name}: ${String(error)}`,
        source: name,
      },
    ];
  }

  // Function component: call the generator function directly
  if ("kind" in imported && imported.kind === "function") {
    return yield* expandFunctionComponent(
      name,
      props,
      expressions,
      children,
      imported,
      hideSet,
      ctx,
      counter,
    );
  }

  const definition = imported as ComponentDefinition;

  // Resolve eval expression props against env.values using the shared
  // VM context. This must happen before validation so that resolved
  // values can be type-checked. See spec §5.1 (expression prop evaluation).
  let resolvedProps: Record<string, Json>;
  try {
    resolvedProps = yield* resolveExpressionProps(props, expressions, name);
  } catch (error) {
    return [
      {
        type: "error",
        message:
          error instanceof Error ? error.message : String(error),
        source: name,
      },
    ];
  }

  if ("as" in expressions) {
    return [
      {
        type: "error",
        message: `Prop "as" on <${name} /> must be a string literal.`,
        source: name,
      },
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
    return [
      {
        type: "error",
        message:
          error instanceof Error ? error.message : String(error),
        source: name,
      },
    ];
  }

  // Substitute raw children into <Content /> positions. Children are NOT
  // pre-expanded — they expand in document order when the component body
  // is expanded. This ensures eval blocks before <Content /> (e.g.,
  // provider middleware installation) run before children's code blocks.
  const substituted = substituteContent(
    definition.bodySegments,
    children,
    definition.meta,
    validatedProps,
  );

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
  const parentEvalScope = yield* EvalScopeCtx.get();
  let childEvalScope: EvalScope | undefined = undefined;
  if (parentEvalScope) {
    const result = yield* parentEvalScope.eval(() =>
      useEvalScope(),
    );
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
  // Both wrap their expandSegments call in EvalEnvCtx.with() and
  // EvalScopeCtx.with() so the full expansion context is available
  // regardless of which task the closure runs in (e.g., inside
  // evalScope.eval()).
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
  const capturedCtx = ctx;
  const capturedParentEvalScope = parentEvalScope;

  componentEnv.values.renderChildren = function* () {
    return yield* EvalEnvCtx.with(componentEnv, function* () {
      if (capturedParentEvalScope) {
        return yield* EvalScopeCtx.with(capturedParentEvalScope, function* () {
          const expanded = yield* expandSegments(
            children, capturedMeta, capturedProps, capturedChildrenHideSet, capturedCtx, counter,
          );
          return renderSegments(expanded);
        });
      }
      const expanded = yield* expandSegments(
        children, capturedMeta, capturedProps, capturedChildrenHideSet, capturedCtx, counter,
      );
      return renderSegments(expanded);
    });
  };

  componentEnv.values.render = function* (markdown: string) {
    const segments = scanSegments(markdown);
    return yield* EvalEnvCtx.with(componentEnv, function* () {
      if (capturedParentEvalScope) {
        return yield* EvalScopeCtx.with(capturedParentEvalScope, function* () {
          const expanded = yield* expandSegments(
            segments, capturedMeta, capturedProps, capturedChildrenHideSet, capturedCtx, counter,
          );
          return renderSegments(expanded);
        });
      }
      const expanded = yield* expandSegments(
        segments, capturedMeta, capturedProps, capturedChildrenHideSet, capturedCtx, counter,
      );
      return renderSegments(expanded);
    });
  };

  const expanded = yield* EvalEnvCtx.with(
    componentEnv,
    function* () {
      if (childEvalScope) {
        return yield* EvalScopeCtx.with(
          childEvalScope,
          function* () {
            return yield* expandSegments(
              substituted,
              definition.meta,
              validatedProps,
              newHideSet,
              ctx,
              counter,
            );
          },
        );
      }
      return yield* expandSegments(
        substituted,
        definition.meta,
        validatedProps,
        newHideSet,
        ctx,
        counter,
      );
    },
  );

  if (asBinding) {
    const parentEnv = yield* EvalEnvCtx.get();
    if (!parentEnv) {
      return [
        {
          type: "error",
          message: `Prop "as" on <${name} /> requires a parent evaluation environment.`,
          source: name,
        },
      ];
    }
    parentEnv.values[asBinding] = renderSegments(expanded);
    return [];
  }

  return expanded;
}

// ---------------------------------------------------------------------------
// Function component expansion (spec §5.3)
// ---------------------------------------------------------------------------

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
  ctx: ExpansionContext,
  counter: BlockCounter,
): Operation<Segment[]> {
  if ("as" in expressions) {
    return [
      {
        type: "error",
        message: `Prop "as" on <${name} /> must be a string literal.`,
        source: name,
      },
    ];
  }

  // Resolve expression props
  let resolvedProps: Record<string, Json>;
  try {
    resolvedProps = yield* resolveExpressionProps(props, expressions, name);
  } catch (error) {
    return [
      {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        source: name,
      },
    ];
  }

  // Strip slot prop before validation
  const asBindingResult = validateBindingName(resolvedProps.as);
  if (!asBindingResult.ok) {
    return [
      {
        type: "error",
        message: `Prop "as" on <${name} /> ${asBindingResult.error}`,
        source: name,
      },
    ];
  }
  const asBinding = asBindingResult.value;
  const { slot: _slot, as: _as, ...propsForValidation } = resolvedProps;

  // Validate props
  let validatedProps: Record<string, Json>;
  try {
    validatedProps = validateProps(name, propsForValidation, definition.inputs);
  } catch (error) {
    return [
      {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        source: name,
      },
    ];
  }

  // Set ContentCtx on the scope so the function component can
  // access children via `yield* useContent()`. Supports named
  // slots: `yield* useContent("header")`.
  const slots = partitionBySlot(children);
  const scope = yield* useScope();

  const contentHandle: ContentHandle = {
    segments: children,
    *renderDefault() {
      const expanded = yield* expandSegments(
        slots.default,
        {},
        {},
        hideSet,
        ctx,
        counter,
      );
      return renderSegments(expanded);
    },
    *renderSlot(slotName: string) {
      const slotChildren = (slots.named.get(slotName) ?? []).map(stripSlotProp);
      if (slotChildren.length === 0) return "";
      const expanded = yield* expandSegments(
        slotChildren,
        {},
        {},
        hideSet,
        ctx,
        counter,
      );
      return renderSegments(expanded);
    },
  };
  scope.set(ContentCtx, contentHandle);

  // Call the function component
  try {
    const output = yield* definition.fn(validatedProps);
    if (asBinding) {
      const parentEnv = yield* EvalEnvCtx.get();
      if (!parentEnv) {
        return [
          {
            type: "error",
            message:
              `Prop "as" on <${name} /> requires a parent evaluation environment.`,
            source: name,
          },
        ];
      }
      parentEnv.values[asBinding] = output;
      return [];
    }
    return [{ type: "text", content: output }];
  } catch (error) {
    return [
      {
        type: "error",
        message: error instanceof Error
          ? `Function component ${name} error: ${error.message}`
          : `Function component ${name} error: ${String(error)}`,
        source: name,
      },
    ];
  }
}

function validateBindingName(
  value: Json | undefined,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (typeof value !== "string") {
    return { ok: false, error: 'must be a non-empty string literal.' };
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
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Expression prop evaluation (spec §5.1)
// ---------------------------------------------------------------------------

/**
 * Resolve eval expression props against env.values using the shared VM
 * context. Merges resolved values into the props record.
 *
 * Expression props are stored as raw expression text in the
 * `expressions` field of `ComponentInvocation`. At expansion time,
 * they are evaluated as JavaScript using `new Function()` with
 * `env.values` destructured into scope.
 *
 * Results must be JSON-serializable — props must survive replay.
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
): Operation<Record<string, Json>> {
  // Start with already-resolved props
  const resolved = { ...props };

  // Nothing to evaluate
  if (Object.keys(expressions).length === 0) {
    return resolved;
  }

  // Get the eval environment
  const evalEnv = yield* EvalEnvCtx.get();

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

      // Validate serialization — props must survive replay
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
      if (
        error instanceof Error &&
        error.message.includes("non-serializable")
      ) {
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

// ---------------------------------------------------------------------------
// Named slot support (spec §6.3)
// ---------------------------------------------------------------------------

/**
 * Slot name validation pattern: must start with a letter, followed by
 * letters, digits, underscores, or hyphens.
 */
const SLOT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Validate a slot name. Returns an ErrorSegment if invalid, undefined if ok.
 */
function validateSlotName(
  name: string,
  source: string,
): ErrorSegment | undefined {
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

// ---------------------------------------------------------------------------
// Content slot substitution (spec §6.3)
// ---------------------------------------------------------------------------

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
): Segment[] {
  const slots = partitionBySlot(children);
  // Track whether errors have been emitted (only emit once)
  let errorsEmitted = false;

  return bodySegments.flatMap((segment) => {
    if (segment.type === "component" && segment.name === "Content") {
      const targetSlot = segment.props.slot as string | undefined;
      // Emit slot validation errors at the first Content projection point
      const pendingErrors = !errorsEmitted ? slots.errors : [];
      if (pendingErrors.length > 0) errorsEmitted = true;

      if (targetSlot !== undefined) {
        // Named slot projection — strip slot prop from each child
        return [
          ...pendingErrors,
          ...(slots.named.get(targetSlot) ?? []).map(stripSlotProp),
        ];
      }
      // Default slot projection
      return [...pendingErrors, ...slots.default];
    }
    if (segment.type === "text") {
      return [
        {
          ...segment,
          content: interpolate(segment.content, meta, props),
        },
      ];
    }
    return [segment];
  });
}
