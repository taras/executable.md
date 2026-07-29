/**
 * Content projection (spec §6.3).
 *
 * `<Content />`, `useContent()`, `renderChildren()` and `render()` are one
 * mechanism. A component invocation publishes a handle describing what it can
 * project and where; the handle expands the requested segments inside the
 * invocation's content scope, so their live effects belong to the invocation
 * rather than to the caller that wrote the content.
 *
 * The handle is deliberately not part of the public API: it carries the
 * invocation's slot map, its content scope and its enclosing handle, none of
 * which an extension has any business reaching.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";
import type { ErrorPolicy } from "./errors.ts";
import type { Segment } from "./types.ts";

/**
 * What to project.
 *
 * `policy` is set only by a persistent evaluation's env facade, which knows the
 * policy of the block that started it; every other caller leaves it unset and
 * the projection site's ambient policy applies.
 */
export type ProjectionRequest = { policy?: ErrorPolicy } & (
  | { kind: "slot"; name?: string }
  | { kind: "children"; override?: Record<string, unknown> }
  | { kind: "markdown"; segments: Segment[] }
);

export interface ProjectionHandle {
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
