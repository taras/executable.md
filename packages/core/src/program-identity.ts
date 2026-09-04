/**
 * What a complete program's components resolve to, and how a continuation is
 * held to it (specs/executable-mdx-spec.md §5.7).
 *
 * A program is admitted at a site, and a site is an environment: which
 * definition each name it writes resolves to is part of what the admission
 * granted. Retaining the names alone would let a run resume against a different
 * `<Report />` than the one it was admitted with — same bytes, different
 * program — so the admission retains the identity canonical resolution selected
 * for each name together with the form the element is written in, and a
 * continuation is refused when either has moved.
 *
 * The identity is a string rather than the selection itself because it is
 * durable data: it is written into a journal, read back from one, and compared
 * whole. Every tier that can answer a name contributes a distinguishable one,
 * and a name nothing answers is `unresolved` — which is an identity like any
 * other here, so a name that becomes resolvable between two runs is a change
 * the comparison sees.
 */

import type { ComponentSelection } from "./types.ts";

/** The authored forms an element is written in. */
export type ProgramComponentForm = "self-closing" | "paired";

/** One component a program names, with the form and identity it resolved to. */
export interface ProgramComponent {
  readonly name: string;
  readonly form: ProgramComponentForm;
  /** The identity canonical resolution selected, or `unresolved`. */
  readonly identity: string;
}

/** One element a program names, before its identity has been resolved. */
export interface ProgramComponentRef {
  readonly name: string;
  readonly form: ProgramComponentForm;
}

/** A name nothing at this site answers for. */
export const UNRESOLVED = "unresolved";

/** A program this site will not evaluate. */
export class ProgramEvaluationError extends Error {
  override name = "ProgramEvaluationError";
}

/**
 * What a continuation whose site has moved says.
 *
 * Distinct from an unreadable record on purpose. The journal is intact and says
 * exactly what it always said; what changed is the environment, and a run
 * resumed against a different implementation than it was admitted with is being
 * offered a different program under the same bytes.
 */
export const INCOMPATIBLE =
  "<Evaluate> was resumed at a site where a component this program names resolves differently " +
  "than it did when this evaluation was admitted.";

/**
 * Resolve one name to a component this execution may name durable work about.
 *
 * Held by canonical execution and handed to core's own expansion by value, like
 * the rest of the expansion authority. It answers with the identity selection
 * produced, and it imports nothing: resolving a name is a decision about which
 * definition answers it, and loading one is a durable effect a program's own
 * expansion performs where the element is written.
 */
export interface ProgramResolver {
  (name: string): import("effection").Operation<string>;
}

/**
 * The durable identity of what a name resolved to.
 *
 * Every tier is distinguishable, and each carries the part of its selection
 * that says which implementation it is: a registration is its origin and
 * whether it is reserved, a repository component is its path, a bundled one is
 * its path and object id, and declared Markdown is its origin and digest. A
 * private name resolves to nothing at all (`select.ts`), so a program naming one
 * carries the same identity as a program naming a component that does not
 * exist — which is what it is.
 */
export function componentIdentity(selection: ComponentSelection): string {
  switch (selection.kind) {
    case "structural":
      return `structural:${selection.construct}`;
    case "registered":
      return selection.origin.kind === "registered"
        ? `registered:${selection.origin.reserved ? "reserved" : "default"}:${selection.origin.origin}`
        : `registered:${selection.origin.kind}`;
    case "repository":
      return `repository:${selection.path}`;
    case "workflow":
      return `workflow:${selection.path}@${selection.sourceHash}`;
    case "declared-markdown":
      return `declared-markdown:${selection.origin}@${selection.digest}`;
    default:
      return UNRESOLVED;
  }
}

/** Whether a value is one of the two authored forms. */
export function isProgramComponentForm(value: unknown): value is ProgramComponentForm {
  return value === "self-closing" || value === "paired";
}

/** Whether two resolved component lists describe the same site. */
export function sameComponents(
  retained: readonly ProgramComponent[],
  current: readonly ProgramComponent[],
): boolean {
  if (retained.length !== current.length) {
    return false;
  }
  return retained.every((entry, index) => {
    const other = current[index];
    return (
      other !== undefined &&
      entry.name === other.name &&
      entry.form === other.form &&
      entry.identity === other.identity
    );
  });
}

/** Whether two lists name the same elements in the same forms, whatever they resolved to. */
export function sameElements(
  retained: readonly ProgramComponent[],
  current: readonly ProgramComponentRef[],
): boolean {
  if (retained.length !== current.length) {
    return false;
  }
  return retained.every((entry, index) => {
    const other = current[index];
    return other !== undefined && entry.name === other.name && entry.form === other.form;
  });
}
