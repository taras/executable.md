/**
 * Presentation, computed outside the store.
 *
 * Nothing here is ever written back. The store holds what a Journal and a URL
 * say; a viewport is a property of the terminal the person happens to be
 * looking at, and reflowing for a narrower one is a different reading of the
 * same facts rather than a different set of them.
 *
 * `topology()` is what must not move: the entries, the scope tree, the drawer
 * stack and the names in the environment, with no width, no wrapping and no
 * value in it. `layout()` is what may: lines of text, wrapped and clipped to a
 * viewport. The evidence lays one hydrated state out at two sizes and checks
 * that exactly one of those two answers changed.
 */

import type { Scope, SemanticModel } from "./model.ts";
import type { SemanticState } from "./store.ts";

export interface Viewport {
  readonly columns: number;
  readonly rows: number;
}

function paths(scopes: readonly Scope[], prefix: string): readonly string[] {
  return scopes.flatMap((scope) => [
    `${prefix}/${scope.name}:${scope.outcome.status}`,
    ...paths(scope.children, `${prefix}/${scope.name}`),
  ]);
}

/**
 * The structure of one reconstructed moment, with nothing presentational in
 * it.
 *
 * Two viewports describe the same execution, so this is the answer that has to
 * be identical between them — and it is derived from the model rather than
 * from anything a renderer produced, so a layout that quietly dropped a scope
 * could not make it agree.
 */
export function topology(model: SemanticModel): readonly string[] {
  return [
    `execution ${model.execution}@${model.marker}`,
    ...model.entries.flatMap((entry) => [
      `entry ${entry.id}:${entry.outcome.status}`,
      ...paths(entry.scopes, entry.id),
    ]),
    ...model.bindings.map((binding) => `binding ${binding.name}`),
    ...model.suspensions.map((wait) => `drawer ${wait.entry}/${wait.wait}`),
    ...model.outcomes.map((outcome) => `outcome ${outcome.label}`),
  ];
}

function wrap(text: string, columns: number): readonly string[] {
  if (text.length <= columns) {
    return [text];
  }
  const lines: string[] = [];
  for (let at = 0; at < text.length; at += columns) {
    lines.push(text.slice(at, at + columns));
  }
  return lines;
}

/**
 * One hydrated state, drawn for one terminal.
 *
 * Plain text and no escape sequence anywhere: this experiment is about what
 * the store may hold, and a renderer that emitted styling bytes would put the
 * question the evidence asks — whether any of this reaches StarFX — one step
 * further away rather than answering it.
 */
export function layout(semantic: SemanticState, viewport: Viewport): readonly string[] {
  const body = [
    semantic.url,
    ...semantic.model.entries.map(
      (entry) => `${entry.id}  ${entry.title}  (${entry.outcome.status})`,
    ),
    ...semantic.model.bindings.map((binding) => `${binding.name} = ${binding.value}`),
    ...semantic.history.map((marker) => `${marker.position} ${marker.id} ${marker.kind}`),
  ];
  return body.flatMap((line) => wrap(line, viewport.columns)).slice(0, viewport.rows);
}
