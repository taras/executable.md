/**
 * Content projection (spec §6.3).
 *
 * A component invocation publishes a handle describing what it can project and
 * where. Every projection — Markdown `<Content />`, `useContent()`,
 * `renderChildren()` and `render()` — expands inside the invocation's content
 * scope, so its live effects belong to the invocation rather than to the caller
 * that wrote the content, and stop before the invocation cleans up its own.
 *
 * `<Content />` differs only in how its segments are chosen: slots are resolved
 * during body substitution, and the resolved segments ride on the element the
 * handle claims. The other three ask the handle to select their segments.
 *
 * The handle is deliberately not part of the public API: it carries the
 * invocation's slot map, its content scope and its enclosing handle, none of
 * which an extension has any business reaching.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";
import type { ErrorPolicy } from "./errors.ts";
import type { ComponentElement, Json, Segment } from "./types.ts";

/**
 * What to project.
 *
 * `policy` is set only by a persistent evaluation's binding snapshot, which knows the
 * policy of the block that started it; every other caller leaves it unset and
 * the projection site's ambient policy applies.
 */
export type ProjectionRequest = { policy?: ErrorPolicy } & (
  | { kind: "slot"; name?: string }
  | { kind: "children"; override?: Record<string, unknown> }
  | { kind: "markdown"; segments: Segment[] }
);

export interface ProjectionHandle {
  /**
   * Mark a `<Content />` element as carrying a resolved projection, so
   * expansion runs its children in this invocation's content scope. Identity
   * is the boundary: an unclaimed `<Content />` is not a projection.
   */
  claim(element: ComponentElement): ComponentElement;
  claims(element: ComponentElement): boolean;
  /** Expand a claimed element's children inside the content scope. */
  expandClaimed(
    element: ComponentElement,
    meta: Record<string, unknown>,
    props: Record<string, Json>,
    hideSet: Set<string>,
  ): Operation<Segment[]>;
  /** Structured result — ErrorSegments stay identifiable to the caller. */
  project(request: ProjectionRequest): Operation<Segment[]>;
  /**
   * `project`, recording any ErrorSegments where the invocation collects them
   * before rendering, so a string result never hides a failure from `as=`.
   */
  projectToString(request: ProjectionRequest): Operation<string>;
}

/**
 * The invocation whose content is projected here.
 *
 * An invocation publishes its handle on its eval scope, which every task it
 * owns descends from. A projection republishes the *enclosing* handle for the
 * content it expands, so a `<Content />` written by the caller means the
 * caller's content rather than recursing into the callee's.
 */
export const ActiveProjection: Context<ProjectionHandle | undefined> = createContext<
  ProjectionHandle | undefined
>("component.projection", undefined);
