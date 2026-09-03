/**
 * Which Durable Object owns one run.
 *
 * The public run ID selects it arithmetically, through the namespace's own
 * `idFromName`. There is no registry, no lookup table and nothing to keep in
 * agreement with the objects themselves: a second authority that could disagree
 * with the arithmetic is exactly what "one issue, one run, one owner" cannot
 * have.
 *
 * The id is admitted before it is used. A malformed one must not reach
 * `idFromName` at all — that call answers with an object for any string, so a
 * mistyped id would silently address a fresh, empty owner rather than fail.
 */

/** What a run ID has to be to address an owner. */
export type RunIdRefusal = "run-id-absent" | "run-id-empty" | "run-id-has-nul" | "run-id-too-long";

export class RunIdError extends Error {
  override name = "RunIdError";

  constructor(readonly refusal: RunIdRefusal) {
    super(`this run id cannot address a workflow owner (${refusal})`);
  }
}

/**
 * The longest run ID this host routes.
 *
 * Public run IDs are opaque and caller-selectable, so a bound belongs here
 * rather than in the derivation: the factory's own is 52 characters, and this
 * leaves room for an authorized caller's without letting an unbounded string
 * reach the runtime.
 */
const MAX_RUN_ID = 512;

/** Hold a run ID to what storage requires of one, changing nothing about it. */
export function admitRunId(value: unknown): string {
  if (typeof value !== "string") {
    throw new RunIdError("run-id-absent");
  }
  if (value === "") {
    throw new RunIdError("run-id-empty");
  }
  if (value.includes("\0")) {
    throw new RunIdError("run-id-has-nul");
  }
  if (value.length > MAX_RUN_ID) {
    throw new RunIdError("run-id-too-long");
  }
  return value;
}

/** The one namespace operation this host routes through. */
export interface OwnerNamespace<Stub> {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): Stub;
}

/**
 * The owner for one run.
 *
 * Deterministic in the run ID and in nothing else: the same id reaches the same
 * object from any worker, on any request, without either side having recorded
 * where it went.
 */
export function ownerFor<Stub>(namespace: OwnerNamespace<Stub>, runId: unknown): Stub {
  return namespace.get(namespace.idFromName(admitRunId(runId)));
}
