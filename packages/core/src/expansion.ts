/**
 * Expansion identity (spec §5.6).
 *
 * What an executable element can learn about its own expansion: the authored
 * tag name, where it was written, and a deterministic identifier for this one
 * logical evaluation.
 *
 * The identifier is derived from the root document and the structural path that
 * reached the element — never from a counter, a clock, randomness, or the order
 * work happened to be scheduled in. Two runs of the same document therefore
 * derive the same identifiers, and a replay or a retried attempt arrives at the
 * ones already recorded.
 *
 * The path is carried as the digest so far rather than as a list of frames, so
 * extending it costs one hash instead of re-hashing the whole ancestry, and the
 * result is opaque: an identifier supports equality and nothing else.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";
import { canonicalFingerprint } from "./canonical.ts";
import type { Json, SourcePosition } from "./types.ts";

/**
 * One logical evaluation of an authored executable element.
 *
 * A detached snapshot: a component learns which element it is and where that
 * element was written, and reaches nothing else about the expansion — no props,
 * no bindings, no projected content, no selected definition, no live scope.
 */
export interface Expansion {
  readonly id: string;
  readonly name: string;
  /** Absent for an element that carries no position of its own. */
  readonly position?: Readonly<SourcePosition>;
}

/**
 * The element currently being expanded.
 *
 * An Effection context is identified by its name, and two descriptors built with
 * the same name address the same context. That is the portability mechanism, not
 * a hole to plug: a second loaded copy of this module — a repository `.ts`
 * component importing core from disk while the compiled binary carries its own
 * copy — reads the expansion the engine published. Branding the value with
 * anything instance-local would reject exactly those genuine reads.
 *
 * The same property means a descendant may bind this name for its own
 * descendants, so nothing that must be authoritative may depend on this value.
 */
const CurrentExpansion: Context<Expansion | undefined> = createContext<Expansion | undefined>(
  "expand.current",
  undefined,
);

/** The element currently being expanded; throws outside an expansion. */
export function* getExpansion(): Operation<Expansion> {
  const expansion = yield* CurrentExpansion.get();
  if (expansion === undefined) {
    throw new Error("getExpansion() is available only while an executable element is expanding.");
  }
  return expansion;
}

/** One step of the structural path. */
export type ExpansionFrame = Record<string, Json>;

/** Extend a structural path by one frame. */
export function extendPath(parent: string, frame: ExpansionFrame): string {
  return canonicalFingerprint([parent, frame]);
}

/**
 * Where an element sits inside its own source file.
 *
 * Deliberately not an index into the list being expanded: a root document's
 * segments are expanded one call at a time, which would make every one of them
 * index 0. The index is the fallback for an element that carries no position at
 * all, which the scanner never produces.
 */
export function elementSite(position: SourcePosition | undefined, index: number): string {
  if (position === undefined) {
    return `@${index}`;
  }
  if (position.path === undefined) {
    return `#${position.offset}`;
  }
  return `${position.path}#${position.offset}`;
}

/** The frame an authored element contributes. */
export function elementFrame(name: string, site: string): ExpansionFrame {
  return { f: "el", name, at: site };
}

/** The detached, frozen snapshot an element's expansion answers with. */
export function snapshot(
  id: string,
  name: string,
  position: SourcePosition | undefined,
): Expansion {
  if (position === undefined) {
    return Object.freeze({ id, name });
  }
  return Object.freeze({
    id,
    name,
    position: Object.freeze({
      ...(position.path === undefined ? {} : { path: position.path }),
      offset: position.offset,
      line: position.line,
      column: position.column,
    }),
  });
}

/**
 * The path and the snapshot one authored element's expansion runs under.
 *
 * Derived before the element's body runs and unchanged by anything it does, so
 * re-expanding the same element arrives at the same identifier.
 */
export function enterElement(
  parent: string,
  name: string,
  site: string,
  position: SourcePosition | undefined,
): { path: string; expansion: Expansion } {
  const path = extendPath(parent, elementFrame(name, site));
  return { path, expansion: snapshot(path, name, position) };
}

/**
 * Publish an expansion for the operation that runs the element's body.
 *
 * Nesting needs no save and restore: the value belongs to the scope it is set
 * on, so leaving that scope uncovers the enclosing one.
 */
export function* publishExpansion(expansion: Expansion): Operation<void> {
  yield* CurrentExpansion.set(expansion);
}
