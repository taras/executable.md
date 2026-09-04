/**
 * What a complete program's components resolve to, and how a continuation is
 * held to it (specs/executable-mdx-spec.md §5.7).
 *
 * A program is admitted at a site, and a site is an environment: which
 * definition each name it writes resolves to is part of what the admission
 * granted. Retaining the names alone would let a run resume against a different
 * `<Report />` than the one it was admitted with — same bytes, different
 * program — so the admission retains the identity of what each name actually
 * resolved to together with the form the element is written in, and a
 * continuation is refused when either has moved.
 *
 * ## The identity is the answer's, not the selector's
 *
 * What runs is what the ordinary `Component.importComponent` chain returns, and
 * a provider may answer without delegating or replace what came back. Resolving
 * the name a second way and describing *that* would retain an identity for a
 * definition nobody invokes, so two different middleware answers would compare
 * equal and a continuation would silently run the other one. The identity is
 * therefore taken from the final answer the chain supplied.
 *
 * A canonical tier's answer keeps its canonical identity. An answer an
 * identified middleware provider supplied keeps that provider's own versioned
 * identity — a stable origin, the provider's stable key for the name, and a
 * revision that changes whenever the implementation changes incompatibly. That
 * identity is stated by the provider outside the definition, because a
 * definition is data an answer can copy, and it is bound to the exact answer in
 * execution-private state rather than carried on it.
 *
 * An answer nobody identified is not refused for ordinary expansion — a
 * document that installs a raw replacement keeps working exactly as it did —
 * but a complete program cannot be admitted against one, because there would be
 * nothing for a continuation to compare.
 *
 * ## Records, not strings
 *
 * The identity is a closed tagged record because it is durable data: it is
 * written into a journal, read back from one, and compared whole. Every tier
 * contributes a distinguishable tag, no tag can be spelled as another, and a
 * name nothing answers is `unresolved` — an identity like any other here, so a
 * name that becomes resolvable between two runs is a change the comparison
 * sees.
 */

import type { Operation } from "effection";

import type { ImportedDefinition } from "./components/import-authority.ts";
import type { ComponentSelection, Json, JsonObject } from "./types.ts";

/** The authored forms an element is written in. */
export type ProgramComponentForm = "self-closing" | "paired";

/**
 * What an identified import provider states about itself and its answers.
 *
 * Stated by the provider, at the installation boundary, and outside every
 * definition it supplies. It is an assertion by the authority installed at the
 * site — like a registration's origin or a declared component's — and reusing
 * one revision for a different implementation is that provider breaking its own
 * contract. The engine compares the assertion; it never tries to repair one by
 * reading the definition.
 */
export interface ImportProviderIdentity {
  /** The stable origin this provider answers under. */
  readonly origin: string;
  /** A revision that changes when the supplied implementation changes. */
  readonly revision: string;
}

/** The identity of what one name resolved to, as the run retains it. */
export type ProgramIdentity =
  | { readonly tag: "structural"; readonly construct: string }
  | { readonly tag: "registered"; readonly origin: string; readonly reserved: boolean }
  | { readonly tag: "repository"; readonly path: string }
  | { readonly tag: "workflow"; readonly path: string; readonly object: string }
  | { readonly tag: "declared-markdown"; readonly origin: string; readonly digest: string }
  | {
      readonly tag: "middleware";
      readonly origin: string;
      readonly key: string;
      readonly revision: string;
    }
  | { readonly tag: "unresolved" };

/** The members each identity tag has, and the only members it has. */
const IDENTITY_MEMBERS: Record<ProgramIdentity["tag"], readonly string[]> = {
  structural: ["tag", "construct"],
  registered: ["tag", "origin", "reserved"],
  repository: ["tag", "path"],
  workflow: ["tag", "path", "object"],
  "declared-markdown": ["tag", "origin", "digest"],
  middleware: ["tag", "origin", "key", "revision"],
  unresolved: ["tag"],
};

/** A name nothing at this site answers for. */
export const UNRESOLVED: ProgramIdentity = { tag: "unresolved" };

/** One component a program names, with the form and identity it resolved to. */
export interface ProgramComponent {
  readonly name: string;
  readonly form: ProgramComponentForm;
  readonly identity: ProgramIdentity;
}

/** One element a program names, before its identity has been resolved. */
export interface ProgramComponentRef {
  readonly name: string;
  readonly form: ProgramComponentForm;
}

/**
 * What canonical resolution settled for one name: its identity, and the copy of
 * the answer core will invoke.
 *
 * The two travel together because they are one decision. Carrying the identity
 * without the answer would leave expansion to ask the chain again, and a
 * provider that answered one way for the comparison could answer another way
 * for the invocation.
 */
export interface ResolvedProgramComponent extends ProgramComponent {
  /**
   * Core's own copy of the answer, or `undefined` when nothing was resolved or
   * the answer could not be copied.
   */
  readonly definition: ImportedDefinition | undefined;
  /** Whether the chain's final answer carried no witness at all. */
  readonly unidentified: boolean;
}

/**
 * Resolve one name through the site's own import chain.
 *
 * Held by canonical execution and handed to core's own expansion by value, like
 * the rest of the expansion authority. It resolves through the ordinary chain,
 * so what it describes is what would run; it invokes no component
 * implementation and performs no program effect.
 */
export interface ProgramResolver {
  (name: string): Operation<ResolvedProgramComponent>;
}

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
 * What a program naming a component nobody identified says.
 *
 * Ordinary expansion is unaffected: a raw replacement keeps answering there
 * exactly as it did. What it cannot do is stand behind a durable grant, because
 * a continuation would have nothing to compare and would run whatever answered
 * on the day it resumed.
 */
export const UNIDENTIFIED =
  "<Evaluate> cannot evaluate a program naming a component supplied by import middleware that " +
  "states no identity: a continuation has nothing to hold the site to.";

/**
 * What an answer that moved on its way back through the chain says.
 *
 * A provider marks an answer and then edits it, or hands back something other
 * than what it marked. Either way what the chain returned is not what was
 * claimed, so there is nothing here to admit a program against.
 */
export const ANSWER_CHANGED =
  "<Evaluate> cannot evaluate a program whose component answer was changed after the provider " +
  "that supplied it claimed it.";

/** The canonical identity of what a selection chose. */
export function selectionIdentity(selection: ComponentSelection): ProgramIdentity {
  switch (selection.kind) {
    case "structural":
      return { tag: "structural", construct: selection.construct };
    case "registered":
      return selection.origin.kind === "registered"
        ? {
            tag: "registered",
            origin: selection.origin.origin,
            reserved: selection.origin.reserved,
          }
        : { tag: "registered", origin: selection.origin.kind, reserved: false };
    case "repository":
      return { tag: "repository", path: selection.path };
    case "workflow":
      return { tag: "workflow", path: selection.path, object: selection.sourceHash };
    case "declared-markdown":
      return { tag: "declared-markdown", origin: selection.origin, digest: selection.digest };
    default:
      return UNRESOLVED;
  }
}

/** The identity an identified provider's answer carries. */
export function providerIdentity(provider: ImportProviderIdentity, key: string): ProgramIdentity {
  return { tag: "middleware", origin: provider.origin, key, revision: provider.revision };
}

/** Whether a value is one of the two authored forms. */
export function isProgramComponentForm(value: unknown): value is ProgramComponentForm {
  return value === "self-closing" || value === "paired";
}

/**
 * One retained identity, read back from the journal as a closed tagged record.
 *
 * The tag decides which members the record has, and it has exactly those: a
 * missing, additional or misspelled member is a record this version did not
 * write, whatever its tag says. An empty string is not an identity either — a
 * provider that states nothing has stated nothing.
 */
export function readIdentity(value: Json | undefined): ProgramIdentity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as JsonObject;
  const tag = record.tag;
  if (typeof tag !== "string" || !Object.hasOwn(IDENTITY_MEMBERS, tag)) {
    return undefined;
  }
  const members = IDENTITY_MEMBERS[tag as ProgramIdentity["tag"]];
  const own = Object.keys(record);
  if (own.length !== members.length || !members.every((member) => Object.hasOwn(record, member))) {
    return undefined;
  }
  for (const member of members) {
    const held = record[member];
    if (member === "reserved") {
      if (typeof held !== "boolean") {
        return undefined;
      }
      continue;
    }
    if (typeof held !== "string" || held.length === 0) {
      return undefined;
    }
  }
  return record as unknown as ProgramIdentity;
}

/** Whether two retained identities describe the same implementation. */
export function sameIdentity(one: ProgramIdentity, other: ProgramIdentity): boolean {
  if (one.tag !== other.tag) {
    return false;
  }
  const members = IDENTITY_MEMBERS[one.tag];
  return members.every(
    (member) =>
      (one as unknown as Record<string, Json>)[member] ===
      (other as unknown as Record<string, Json>)[member],
  );
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
      sameIdentity(entry.identity, other.identity)
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
