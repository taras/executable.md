/**
 * The harness the invocation-lifetime suites share (spec §4.4).
 *
 * Expansion is driven through `expandSegments` with stub providers, so the
 * orderings these suites assert are the engine's own and not a property of any
 * particular runtime. A `watch` modifier retains a probe in whatever eval scope
 * is current — the same anchoring `daemon` and `persist eval` use — and each
 * probe records its acquisition and release on a shared timeline.
 */

import { ensure, resource, scoped, suspend } from "effection";
import type { Operation } from "effection";
import { useEvalScope } from "@effectionx/scope-eval";
import { Component } from "../src/component-api.ts";
import { collectFailures } from "../src/component-failures.ts";
import { expandSegments } from "../src/expand.ts";
import { scanSegments } from "../src/scanner.ts";
import type { ComponentDefinition, FunctionComponentDefinition, Segment } from "../src/types.ts";

export type Definition = ComponentDefinition | FunctionComponentDefinition;

const NO_PROPS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

/** Records `start:<label>` on acquisition and `stop:<label>` on teardown. */
export function useWatch(timeline: string[], label: string, failOnStop = false): Operation<void> {
  return resource(function* (provide) {
    timeline.push(`start:${label}`);
    yield* ensure(() => {
      timeline.push(`stop:${label}`);
      if (failOnStop) {
        throw new Error(`teardown failed: ${label}`);
      }
    });
    yield* provide();
  });
}

export function markdown(name: string, body: string): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `components/${name}.md`,
    meta: {},
    props: NO_PROPS,
    bodySegments: scanSegments(body),
  };
}

/**
 * A TypeScript component written the way an author would: ordinary operations,
 * no ephemeral(), no scoped(), no lifetime plumbing.
 */
export function component(
  name: string,
  body: () => Operation<string>,
): FunctionComponentDefinition {
  // These fixtures exist to be observed failing, so they collect rather than
  // stopping the expansion the assertion is about.
  return { kind: "function", name, props: NO_PROPS, fn: collectFailures(body) };
}

/**
 * Install the providers expansion needs, plus a `watch` modifier that retains a
 * probe in whatever eval scope is current — the same anchoring `daemon` uses.
 */
export function useHarness(
  definitions: Record<string, Definition>,
  timeline: string[],
  onBlock?: (snapshot: string[]) => void,
): Operation<void> {
  return Component.around(
    {
      // deno-lint-ignore require-yield
      *importComponent([name], _next) {
        const definition = definitions[name];
        if (!definition) {
          throw new Error(`Component not found: ${name}`);
        }
        return definition;
      },
      *applyModifiers([modifiers, block], _next) {
        const label = block.content.trim();
        onBlock?.([...timeline]);
        const watches = modifiers.some((modifier) => modifier.name === "watch");
        const failing = modifiers.some((modifier) => modifier.name === "watch-fails");
        const hangs = modifiers.some((modifier) => modifier.name === "watch-hangs");
        if (modifiers.some((modifier) => modifier.name === "boom")) {
          throw new Error("body exploded");
        }
        if (watches || failing || hangs) {
          const scope = yield* Component.operations.evalScope;
          if (!scope) {
            throw new Error("watch requires an eval scope");
          }
          yield* scope.eval(() => useWatch(timeline, label, failing));
        }
        if (hangs) {
          yield* suspend();
        }
        return { output: "", exitCode: 0, stderr: "" };
      },
    },
    { at: "min" },
  );
}

export function expandAll(
  source: string,
  definitions: Record<string, Definition>,
  timeline: string[],
  onBlock?: (snapshot: string[]) => void,
): Operation<Segment[]> {
  return scoped(function* () {
    const root = yield* useEvalScope();
    yield* useHarness(definitions, timeline, onBlock);
    yield* Component.around({ evalScope: () => root }, { at: "min" });
    // One environment for the whole expansion. A provider returning a fresh
    // object per read would hand every caller its own, and a binding written
    // by `as` would be invisible to the next sibling that reads it.
    const rootEnv = { values: {} };
    yield* Component.around({ env: () => rootEnv }, { at: "min" });
    return yield* expandSegments(scanSegments(source), {}, {}, new Set());
  });
}

export const WATCH_BLOCK = "```sh watch exec\nprojected\n```";
export const BOOM_BLOCK = "```sh boom exec\nboom\n```";
export const HANG_BLOCK = "```sh watch-hangs exec\nprojected\n```";
export const WATCH_BLOCK_OWN = "```sh watch exec\nown\n```";
export const FAILING_WATCH_BLOCK = "```sh watch-fails exec\nprojected\n```";
