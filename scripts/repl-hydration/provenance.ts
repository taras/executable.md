/**
 * Following a fork back to where it came from, when that is possible.
 *
 * A fork records its parent's name and the marker it was taken at, so what it
 * came from is a fact in its own Journal and survives whatever happens to the
 * parent. Whether that fact can be *followed* is a different question, asked
 * of whatever journals this process can reach, and answered here.
 *
 * The distinction is the whole point of the module. Removing the parent must
 * cost the link and nothing else: the fork still reconstructs, still says
 * where it came from, and merely has nowhere to send someone who clicks. A
 * design that resolved provenance while hydrating would have made the parent
 * a dependency of the fork, which is exactly what #842 forbids.
 *
 * Nothing here is imported by the projector or the store. A link is computed
 * from a model that is already built.
 */

import { encodeRoute, surfaceRoute } from "./location.ts";
import { parseJournal } from "./journal.ts";
import type { SemanticModel } from "./model.ts";
import { markersOf, projectPrefix } from "./project.ts";

/** One execution's records, if this process can reach them. */
export type Found =
  | { readonly found: true; readonly records: readonly unknown[] }
  | { readonly found: false };

/** The journals this process can reach. A cold one reaches none. */
export interface Library {
  journalOf(execution: string): Found;
}

/** A library holding the executions it was given. */
export function library(journals: Readonly<Record<string, readonly unknown[]>>): Library {
  return {
    journalOf(execution) {
      const records = journals[execution];
      return records === undefined ? { found: false } : { found: true, records };
    },
  };
}

/** A process that can reach nothing but the execution in front of it. */
export function alone(): Library {
  return { journalOf: () => ({ found: false }) };
}

/**
 * What the transcript shows above a fork.
 *
 * `none` is a root execution. `unavailable` still names the parent and the
 * marker, because that is what the fork recorded and it stays true; it simply
 * cannot be opened from here. `resolvable` carries the one canonical URL that
 * opens the parent at the marker this fork was taken from.
 */
export type ProvenanceLink =
  | { readonly kind: "none" }
  | {
      readonly kind: "unavailable";
      readonly parent: string;
      readonly source: string;
      readonly why: string;
    }
  | {
      readonly kind: "resolvable";
      readonly parent: string;
      readonly source: string;
      readonly url: string;
    };

/**
 * Where this execution came from, and whether it can be opened from here.
 *
 * Unreadable parent records make the link unavailable rather than making this
 * a failure: a fork whose parent's Journal is corrupt is still a fork that
 * reconstructs, and refusing here would let the parent's condition decide
 * whether the fork works.
 */
export function provenanceLink(model: SemanticModel, reachable: Library): ProvenanceLink {
  if (model.provenance.kind === "root") {
    return { kind: "none" };
  }
  const { parent, source } = model.provenance;

  const found = reachable.journalOf(parent);
  if (!found.found) {
    return { kind: "unavailable", parent, source, why: `${parent} is not available here` };
  }

  const events = parseJournal(found.records);
  if (!events.ok) {
    return { kind: "unavailable", parent, source, why: `${parent} cannot be read` };
  }
  if (!markersOf(events.value).includes(source)) {
    return {
      kind: "unavailable",
      parent,
      source,
      why: `${parent} has no marker ${source}`,
    };
  }
  // A parent that reads but cannot have happened has nothing to open at that
  // marker either. Every one of these is the link going dark, never the fork
  // failing: whether the parent is well is not the fork's business.
  const at = projectPrefix(parent, events.value, source);
  if (!at.ok) {
    return { kind: "unavailable", parent, source, why: `${parent} cannot be reconstructed` };
  }

  const route = surfaceRoute({
    execution: parent,
    surface: "transcript",
    at: source,
    inspect: false,
    draft: "",
  });
  if (!route.ok) {
    return { kind: "unavailable", parent, source, why: route.error.message };
  }
  return { kind: "resolvable", parent, source, url: encodeRoute(route.value) };
}
