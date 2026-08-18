/**
 * The installation that closes one document execution over a component bundle.
 *
 * A workflow whose root declares components runs against exactly those
 * components, read from the run's own pinned commit before anything executed.
 * That single fact has to hold in two directions, and this installation
 * supplies both halves as values a trusted host hands to `executeInstalled()`:
 *
 * - **Live import.** `bundle` is the execution view — the authored names,
 *   their canonical paths inside the pinned tree, their blob object ids, and
 *   the exact sources. Canonical core captures it before any installation,
 *   middleware, or document code exists, resolves declared names against it,
 *   and invokes only the definitions it produced from it.
 * - **Retained history.** `admissions` holds every recorded component import
 *   to the same authority, inside canonical core's own journal read: before
 *   public replay policy, before any retained effect reaches execution, before
 *   a retained terminal result is reused, and before anything is appended. A
 *   history that recorded a name this bundle does not declare, a path or hash
 *   the definition does not name, or source the commit does not hold, appends
 *   nothing and invokes nothing.
 *
 * What the admission deliberately leaves alone is the ordinary registered
 * default: a `<Test>` or a `<File>` recorded by origin is replayed by core's
 * own exact-origin check, which this neither repeats nor relaxes. And the root
 * import stays the root import — a repository selection under `__root__`,
 * already held to the run's exact root source by core.
 */

import type { DurableEvent, Json, Yield } from "@executablemd/durable-streams";
import type {
  ExecutionInstallation,
  JournalAdmission,
  WorkflowBundleComponent,
} from "@executablemd/core/host";

/** The root's own import, which is not a bundle member and is admitted elsewhere. */
const ROOT = "__root__";

const IMPORT_COMPONENT = "import_component";

const WORKFLOW_SELECTION_MEMBERS: readonly string[] = ["kind", "path", "sourceHash", "content"];

/**
 * A retained component import this run's bundle does not authorize.
 *
 * Fixed diagnostics throughout. What a history recorded is journal data, and a
 * refusal that quoted a planted name, path, or source would publish exactly the
 * value it exists to reject.
 */
export class WorkflowBundleHistoryError extends Error {
  override name = "WorkflowBundleHistoryError";
}

const REFUSALS = {
  unreadable: "A retained component import cannot be read by this run's component bundle.",
  undeclared: "A retained component import names a component this run's bundle does not declare.",
  mismatched: "A retained component import does not match the component this run's bundle holds.",
  wrongKind:
    "A retained component import recorded a declared component as something other than a " +
    "component this run's bundle supplies.",
  repository:
    "A retained component import recorded a repository file, which a workflow run resolves none of.",
} as const;

/**
 * Read one journal-controlled value, or answer that reading it refused.
 *
 * As narrow as the reads the run record is parsed through, and for the same
 * reason: a throwing accessor, a proxy trap, and a revoked proxy all mean this
 * record does not describe an import, and nothing wider should be swallowed.
 */
function reading<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** The name a retained event imported, when the event is a settled import at all. */
function importedName(event: DurableEvent): string | undefined {
  const type = reading(() => event.type);
  if (type !== "yield") {
    return undefined;
  }
  const description = reading(() => (event as Yield).description);
  if (description === undefined) {
    return undefined;
  }
  return reading(() => description.type) === IMPORT_COMPONENT
    ? reading(() => description.name)
    : undefined;
}

/**
 * A retained value that refuses to be read.
 *
 * Distinct from absence. A settlement that is simply not there is an import
 * that failed, which this admission has nothing to say about; a settlement that
 * will not say what it is, is a record this run cannot account for — and
 * conflating them would let a planted accessor pass the gate and surface later
 * as somebody else's failure, carrying the words it was planted with.
 */
const UNREADABLE: unique symbol = Symbol("unreadable");

/** The value a settled import recorded, when it settled successfully. */
function importedValue(event: DurableEvent): { value: unknown } | undefined | typeof UNREADABLE {
  let result: unknown;
  try {
    result = (event as Yield).result;
  } catch {
    return UNREADABLE;
  }
  if (result === undefined || typeof result !== "object" || result === null) {
    return UNREADABLE;
  }
  const status = reading(() => (result as { status?: unknown }).status);
  if (status === undefined) {
    return UNREADABLE;
  }
  if (status !== "ok") {
    return undefined;
  }
  const value = reading(() => ("value" in result ? (result as { value: Json }).value : UNREADABLE));
  return value === undefined || value === UNREADABLE ? UNREADABLE : { value };
}

/**
 * Hold one retained import to the bundle, or refuse it.
 *
 * Every branch is a decision about what the record *is*, taken before anything
 * is replayed from it. A declared name must have been recorded as a bundled
 * component, with this bundle's exact path, hash, and source; an undeclared
 * name must not claim to be one; and a repository selection is admitted only
 * for the root, which core holds to the run's own root source.
 */
function admitImport(
  event: DurableEvent,
  components: ReadonlyMap<string, WorkflowBundleComponent>,
): void {
  const name = importedName(event);
  if (name === undefined || name === ROOT) {
    return;
  }
  const settled = importedValue(event);
  if (settled === UNREADABLE) {
    throw new WorkflowBundleHistoryError(REFUSALS.unreadable);
  }
  if (settled === undefined) {
    // A failed or cancelled import recorded no selection to hold to anything.
    return;
  }
  const record = settled.value;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new WorkflowBundleHistoryError(REFUSALS.unreadable);
  }

  const kind = reading(() => (record as Record<string, unknown>)["kind"]);
  const declared = components.get(name);

  if (kind === "workflow") {
    if (declared === undefined) {
      throw new WorkflowBundleHistoryError(REFUSALS.undeclared);
    }
    const members = reading(() => Object.keys(record));
    if (members === undefined || members.length !== WORKFLOW_SELECTION_MEMBERS.length) {
      throw new WorkflowBundleHistoryError(REFUSALS.unreadable);
    }
    for (const member of WORKFLOW_SELECTION_MEMBERS) {
      if (!members.includes(member)) {
        throw new WorkflowBundleHistoryError(REFUSALS.unreadable);
      }
    }
    const read = (member: string) => reading(() => (record as Record<string, unknown>)[member]);
    if (
      read("path") !== declared.path ||
      read("sourceHash") !== declared.sourceHash ||
      read("content") !== declared.content
    ) {
      throw new WorkflowBundleHistoryError(REFUSALS.mismatched);
    }
    return;
  }

  if (declared !== undefined) {
    // The bundle declares this name, so a history that resolved it any other
    // way resolved something this run is not closed over.
    throw new WorkflowBundleHistoryError(REFUSALS.wrongKind);
  }
  if (kind === "repository") {
    throw new WorkflowBundleHistoryError(REFUSALS.repository);
  }
}

function admits(components: ReadonlyMap<string, WorkflowBundleComponent>): JournalAdmission {
  // deno-lint-ignore require-yield
  return function* (retained: readonly DurableEvent[]) {
    for (const event of retained) {
      admitImport(event, components);
    }
  };
}

/**
 * Close one document execution over the components a workflow definition names.
 *
 * Constructing it resolves nothing: the sources were read from the pinned
 * commit before this was called, and this value only carries them. Executing a
 * document under it is what makes the names resolvable and the history
 * admissible.
 *
 * ```ts
 * yield* executeInstalled(options, [
 *   retainedWorkflowInstallation(run),
 *   workflowBundleInstallation(components),
 * ]);
 * ```
 */
export function workflowBundleInstallation(
  components: readonly WorkflowBundleComponent[],
): ExecutionInstallation {
  // Copied entry by entry at construction, so the authority this installation
  // carries is closed over these values rather than over an array the caller
  // still holds and could rewrite between installation and import.
  const index = new Map<string, WorkflowBundleComponent>(
    components.map((component) => [
      component.name,
      Object.freeze({
        name: component.name,
        path: component.path,
        sourceHash: component.sourceHash,
        content: component.content,
      }),
    ]),
  );
  return {
    admissions: [admits(index)],
    bundle: { components: Object.freeze([...index.values()]) },
  };
}
