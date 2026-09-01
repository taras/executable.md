/**
 * The component bundle one workflow execution is closed over.
 *
 * A workflow root may declare a fixed set of authored Markdown components, and
 * a run is a run *of* that set: the same pinned Git tree supplies the root and
 * every component, and nothing about the checkout beside it takes part. That
 * makes the bundle two things at once — immutable workflow-definition identity,
 * which the workflow package retains, and execution authority, which is what
 * this module is.
 *
 * ## How it enters core
 *
 * As plain immutable data on an `ExecutionInstallation`, captured by value
 * before any installation, middleware, or document code exists — the same terms
 * a `JournalAdmission` and a `DurablePreparation` cross on. It is not a
 * registration, a component directory, a contextual Api value, a context name,
 * or module state: a separately loaded workflow package hands canonical core
 * the sources it read, and there is nothing anyone else can reach, replace, or
 * agree on a name for.
 *
 * ## What it authorizes
 *
 * Resolution: a declared name resolves to its exact pinned source, ahead of
 * every registered default and without the filesystem being asked anything.
 *
 * Invocation: while a bundle is installed, the definition a document expands is
 * the definition canonical execution produced. `Component.importComponent`
 * middleware still composes around every import — it may observe one, delegate
 * one, and refuse one by throwing — but it cannot answer one. A handler that
 * returns without delegating, replaces what came back, or mutates it fails the
 * import before the component is invoked, because canonical core issues a
 * witness for the answer it produced and verifies it at the call site.
 *
 * All of it is execution-local. The authority is created per invocation and
 * reclaimed with it, so two concurrent workflows declaring one name with
 * different sources resolve their own and can observe neither.
 */

import type { ImportRefusal, ImportTier } from "./import-authority.ts";
import { CORE_COMPONENT_NAMES } from "./registry.ts";
import { isComponentName } from "./registration.ts";
import { RESERVED_STRUCTURAL } from "../structural.ts";
import type { ComponentRegistry } from "../types.ts";

/**
 * One authored Markdown component, as the pinned tree holds it.
 *
 * `path` is canonical repository-relative POSIX — the path the blob has in the
 * commit, never the `./Name.md` a root document wrote. `content` is that blob's
 * exact bytes as text, and `sourceHash` is its object id, so what executes and
 * what the definition identifies cannot drift apart.
 */
export interface WorkflowBundleComponent {
  readonly name: string;
  readonly path: string;
  readonly sourceHash: string;
  readonly content: string;
}

/** The execution view of one workflow's bundle: its entries and their sources. */
export interface WorkflowComponentBundle {
  readonly components: readonly WorkflowBundleComponent[];
}

/**
 * A bundle that cannot be installed, or an import a bundled execution refuses.
 *
 * Thrown before the root document is imported when it is the bundle itself that
 * is unusable, and out of one import when it is the answer that is.
 */
export class WorkflowBundleError extends Error {
  override name = "WorkflowBundleError";
}

/** The fixed diagnostic each verification failure produces. */
const REFUSED: Record<ImportRefusal, string> = {
  unissued:
    "Component.importComponent middleware answered an import with a definition canonical " +
    "execution did not produce. A handler may observe, delegate or refuse an import in a " +
    "workflow closed over a component bundle; only canonical execution answers one.",
  "another-name":
    "Component.importComponent middleware answered an import with the definition canonical " +
    "execution produced for another component.",
  changed:
    "Component.importComponent middleware changed the definition canonical execution " +
    "produced before it was invoked.",
};

/**
 * The bundle tier one bundled execution resolves and refuses through.
 *
 * Held by canonical core and passed by value into core's own expansion, so no
 * document, component, or middleware can reach it, replace it, or add to it.
 * Retention is the execution's — one answer per import, whichever tier produced
 * it — and this decides what a refusal of a bundled name says.
 *
 * The ways a handler can decide an import — answering without delegating,
 * replacing what came back, and changing it afterwards — are one question at
 * the call site: is this the answer canonical execution produced for this name,
 * still describing what core produced? What comes back there is core's own
 * copy, never the object that travelled through the chain, so the comparison
 * decides whether an import is *refused* and nothing a handler still holds
 * decides what is *invoked*.
 */
export class WorkflowImportAuthority implements ImportTier {
  readonly #components: ReadonlyMap<string, WorkflowBundleComponent>;

  constructor(components: ReadonlyMap<string, WorkflowBundleComponent>) {
    this.#components = components;
  }

  /** The pinned component this name resolves to, if the bundle declares it. */
  component(name: string): WorkflowBundleComponent | undefined {
    return this.#components.get(name);
  }

  claims(name: string): boolean {
    return this.#components.has(name);
  }

  refuse(refusal: ImportRefusal): Error {
    return new WorkflowBundleError(REFUSED[refusal]);
  }
}

/**
 * The authority one invocation runs under, or nothing when no bundle is
 * installed.
 *
 * Two installations carrying bundles is a host mistake rather than a merge: two
 * authorities for one execution would make what a name resolves to depend on
 * which was consulted first.
 *
 * The collision checks run here, before the root document is imported, because
 * a bundle that claims a name the engine or a host already owns describes a
 * document that cannot mean what it says. Structural syntax and core's defaults
 * are fixed; a reserved registration is whatever this host installed, read once
 * from the registry the execution starts with.
 */
export function installedBundle(
  bundles: readonly WorkflowComponentBundle[],
  registry: ComponentRegistry,
): WorkflowImportAuthority | undefined {
  if (bundles.length === 0) {
    return undefined;
  }
  if (bundles.length > 1) {
    throw new WorkflowBundleError(
      "two installations supplied a workflow component bundle. One execution runs under one " +
        "bundle, so which components a name resolves to is never a question of order.",
    );
  }
  const bundle = bundles[0];
  const components = new Map<string, WorkflowBundleComponent>();
  for (const component of bundle?.components ?? []) {
    const { name } = component;
    // The name is printed only once it has passed the grammar a document
    // writes: until then it is authored text of unknown provenance, and a
    // refusal is not a reason to publish it.
    if (!isComponentName(name)) {
      throw new WorkflowBundleError(
        "a workflow component bundle declared a name that is not a component name.",
      );
    }
    if (RESERVED_STRUCTURAL.has(name)) {
      throw new WorkflowBundleError(
        `a workflow component bundle declared "${name}", which is structural syntax the engine ` +
          "owns rather than a component.",
      );
    }
    if (CORE_COMPONENT_NAMES.has(name)) {
      throw new WorkflowBundleError(
        `a workflow component bundle declared "${name}", which is a component the engine ` +
          "supplies. A bundle adds names; it does not replace them.",
      );
    }
    if (registry.get(name)?.reserved !== undefined) {
      throw new WorkflowBundleError(
        `a workflow component bundle declared "${name}", which this host reserved. A reserved ` +
          "registration protects an invariant a bundle may not take back.",
      );
    }
    if (components.has(name)) {
      throw new WorkflowBundleError(`a workflow component bundle declared "${name}" twice.`);
    }
    components.set(name, component);
  }
  if (components.size === 0) {
    throw new WorkflowBundleError(
      "a workflow component bundle declared no components. A workflow closed over nothing is a " +
        "workflow with no bundle, which is a different definition.",
    );
  }
  return new WorkflowImportAuthority(components);
}
