/**
 * Expansion engine (spec §5).
 *
 * Term-rewriting process: each component invocation is replaced by the
 * component's body, with <Content /> substituted by the invocation's
 * children and {meta.key}/{props.key} resolved.
 *
 * Top-down with bottom-up child processing: children are expanded first,
 * then substituted into the component body, then the substituted body is
 * expanded recursively.
 */

import type { Operation } from "effection";
import type {
  Segment,
  ComponentDefinition,
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
// Types for the expansion context
// ---------------------------------------------------------------------------

/**
 * Function that imports a component by name.
 * During live execution: resolves + reads + hashes via durable effect.
 * During replay: returns stored result.
 */
export type ComponentImporter = (
  name: string,
) => Operation<ComponentDefinition>;

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

/**
 * Expand an array of segments, resolving components and executing code blocks.
 */
export function* expandSegments(
  segments: Segment[],
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  ctx: ExpansionContext,
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
        const expanded = yield* expandComponent(
          segment.name,
          segment.props,
          segment.children,
          hideSet,
          ctx,
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

        // Compose modifier chain from info string and run it
        const context: CodeBlockContext = {
          language: segment.language,
          content: interpolatedContent,
          blockId: `eval:${parentMeta["componentName"] ?? "root"}:${result.length}`,
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

// ---------------------------------------------------------------------------
// Component expansion with cycle detection (spec §5.2)
// ---------------------------------------------------------------------------

function* expandComponent(
  name: string,
  props: Record<string, Json>,
  children: Segment[],
  hideSet: Set<string>,
  ctx: ExpansionContext,
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
  let definition: ComponentDefinition;
  try {
    definition = yield* ctx.importComponent(name);
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

  // Validate props against declared inputs
  let validatedProps: Record<string, Json>;
  try {
    validatedProps = validateProps(name, props, definition.inputs);
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
  // Both wrap their expandSegments call in EvalEnvCtx.with() and
  // EvalScopeCtx.with() so the full expansion context is available
  // regardless of which task the closure runs in (e.g., evalScope.eval).
  //
  // IMPORTANT: Both closures use parentEvalScope (not childEvalScope)
  // for EvalScopeCtx. This prevents a deadlock when children contain
  // components that need their own eval scopes. The deadlock occurs
  // because persist eval blocks run inside childEvalScope.eval(), which
  // blocks the scope's sequential channel — any nested .eval() call on
  // the same scope (triggered by child component expansion) would wait
  // forever. Using parentEvalScope avoids re-entrant .eval() calls.
  // Children are caller-provided content and should see the caller's
  // scope chain, not the component's internal scope.
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
            children, capturedMeta, capturedProps, capturedChildrenHideSet, capturedCtx,
          );
          return renderSegments(expanded);
        });
      }
      const expanded = yield* expandSegments(
        children, capturedMeta, capturedProps, capturedChildrenHideSet, capturedCtx,
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
            segments, capturedMeta, capturedProps, capturedChildrenHideSet, capturedCtx,
          );
          return renderSegments(expanded);
        });
      }
      const expanded = yield* expandSegments(
        segments, capturedMeta, capturedProps, capturedChildrenHideSet, capturedCtx,
      );
      return renderSegments(expanded);
    });
  };

  return yield* EvalEnvCtx.with(
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
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Content slot substitution (spec §5.3)
// ---------------------------------------------------------------------------

/**
 * Replace `<Content />` invocations with the caller's expanded children.
 * Also interpolates {meta.key} and {props.key} in text segments.
 */
function substituteContent(
  bodySegments: Segment[],
  expandedChildren: Segment[],
  meta: Record<string, unknown>,
  props: Record<string, Json>,
): Segment[] {
  return bodySegments.flatMap((segment) => {
    if (segment.type === "component" && segment.name === "Content") {
      // Replace <Content /> with the caller's expanded children
      return expandedChildren;
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
