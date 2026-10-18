/**
 * One REPL entry's Repository and Worktree selections, performed once and
 * answered from what they recorded.
 *
 * A `<Repository>` or `<Worktree>` in a REPL entry asks the ordinary managed
 * selector for a checkout under the host's repository root — the same selector
 * `xmd run` asks, with the same reuse, conflict and interrupted-creation policy
 * — and records where it ended up. Reopen the entry at a question and that
 * recorded placement is the answer: the path is bound, the body expands, and no
 * selector is called, nothing is cloned, no `worktree add` runs, no sidecar is
 * read, no credential is opened and no lock is taken.
 *
 * That is the whole of the honesty here. A completed selection says where this
 * entry was working. It does not say that the checkout still exists, still
 * holds those bytes, or is still a Git checkout at all — somebody may have
 * edited it, moved it or deleted it between the question and the answer.
 * Genuinely new work afterwards meets today's environment and gets today's
 * answer, including an ordinary missing-file failure.
 *
 * ## Why a saved selector answer is never re-checked
 *
 * Re-running the selector to "make sure" would undo the exercise. It reads
 * metadata, resolves commits and takes the slot's lock, and any of those can
 * refuse — so a continuation would fail at a question the person already
 * answered, over a checkout whose current state the recorded result was never
 * about. The saved facts are parsed, their relationships are checked against
 * this call with pure arithmetic, and that is all.
 *
 * ## Two holds, two jobs
 *
 * A **slot lease** says one entry at a time owns a managed checkout. A live
 * selection takes it before it inspects or creates anything, and it is held
 * until the entry tears down so a later `<Dir>` inside the same entry is still
 * protected. A completed replay takes none; the first genuinely new file
 * operation inside a restored placement reacquires it then, without revalidating
 * the checkout.
 *
 * The **common-directory lease** is PR 1's kernel lock on the shared Git
 * directory, and only a *new* Worktree selector takes it here: `worktree add`
 * writes refs and linked administration into the repository everybody else's
 * checkouts share. Whether it will create or reuse is not predicted, because
 * finding out is the selector's own job. A Repository clone creates its own
 * repository under its slot lease and takes no common hold.
 *
 * Both are acquired inside the recorded operation, so a replayed selection
 * acquires neither. When both are needed the slot comes first.
 *
 * ## The selector finishes before its answer is written down
 *
 * What the selector itself acquires is shorter-lived than the entry: the
 * authentication a clone opens belongs to that one clone. It runs in a scope of
 * its own that is torn down and joined before the placement is published, so no
 * record and no body work can precede that cleanup. A cleanup that fails takes
 * the ordinary fatal path, publishing nothing — a selector whose own teardown
 * did not finish has not described a checkout anybody may work in.
 */

import { Err, Ok, scoped, withResolvers } from "effection";
import type { Operation, Result, WithResolvers } from "effection";
import { createDurableOperation, StaleInputError } from "@executablemd/durable-streams";
import { retainedRecordAhead } from "./local.ts";
import type {
  ActivateDurabilityFailure,
  Json,
  LiveDurableOperationCoordinator,
  Result as ProtocolResult,
} from "@executablemd/durable-streams";
import type { RepositoryRequest, WorktreeRequest } from "../../composition/api.ts";
import {
  RepositoryCompositionError,
  RepositorySelectionError,
  WorktreeCompositionError,
} from "../../composition/errors.ts";
import {
  sameRepositoryIdentity,
  type RepositoryIdentity,
  type RepositorySelection,
} from "../../composition/selection.ts";
import {
  parseReplPlacementRecord,
  REPL_REPOSITORY_PLACEMENT,
  ReplPlacementRefusal,
  replPlacementFingerprint,
  replPlacementRecordJson,
  replPlacementRecordName,
  type ReplManagedRefusalReason,
  type ReplPlacement,
  type ReplPlacementRefusalData,
  type ReplPlacementRequest,
} from "../../retained-repository/placement-records.ts";
import { admitLocator, locatorFingerprint } from "../composition/locator.ts";
import { GitRefusal, type GitSession } from "../composition/git.ts";
import type { RepositoryHost } from "../composition/host.ts";
import {
  CompositionRefusal,
  refusalReason,
  repositoryRefusal,
  worktreeRefusal,
} from "../composition/refusals.ts";
import { selectManagedRepository, selectManagedWorktree } from "../run-composition/checkouts.ts";
import { ManagedCheckoutError, NoAmbientRepositoryError } from "../run-composition/errors.ts";
import type { SlotKind } from "../run-composition/leases.ts";
import { checkoutOf, repositorySlot, worktreeSlot } from "../run-composition/checkout-layout.ts";
import type { AmbientRepository } from "../run-composition/ambient.ts";
import type { SelectionRegistry } from "../selections.ts";

/**
 * A saved placement standing where this selection belongs that it cannot read.
 *
 * Fatal, on the same terms as a saved local result this host cannot read: a
 * record that does not describe this selection is not an outcome of it, so it
 * does not belong in the result channel and `<PrintErrors>` may not carry on
 * past it.
 */
export class ReplPlacementRecordError extends StaleInputError {
  override name = "ReplPlacementRecordError";
}

/** One placement this entry holds, and the managed slot it occupies. */
export interface ReplPlacementRegistration {
  readonly placement: ReplPlacement;
  /**
   * The managed slot and its lock kind, or absent for an ambient owner.
   *
   * What the first genuinely new file operation inside a restored placement
   * reacquires. Private entry state: a slot is derived from the request and the
   * recorded root, never read out of the journal.
   */
  readonly slot: { readonly kind: SlotKind; readonly path: string } | undefined;
  /**
   * Where a branch of this checkout would be published, or absence.
   *
   * Private entry state, and deliberately not part of any record: a saved
   * placement carries a locator *fingerprint* and never the bytes, so a
   * publication reauthenticates its destination from what this entry can see
   * now rather than from what a journal says. A managed selection answers with
   * the locator the document wrote and this provider admitted; a linked
   * checkout answers with its owner's; an ambient owner answers from the
   * discovery this entry already shares, which is why this is an operation
   * rather than a value — a replayed publication asks it nothing.
   *
   * Absence is an ordinary answer. A checkout that records no usable origin has
   * nowhere to publish to, and that is a refusal a document can act on rather
   * than something to invent a destination for.
   */
  origin(): Operation<string | undefined>;
}

/** What a recorded selection needs from the entry that owns it. */
export interface ReplSelectionEntry {
  /** The native Git host, which is also what lends clone authentication. */
  readonly host: RepositoryHost;
  /** This entry's Git session, acquired once into the entry's own scope. */
  git(): Operation<GitSession>;
  /** The canonical managed root, created before it is canonicalized, once. */
  root(): Operation<string>;
  /** The repository this invocation started in, discovered at most once. */
  ambient(): Operation<AmbientRepository | undefined>;
  /**
   * Hold a managed slot for the entry, single-flight per root and slot.
   *
   * The root is stated rather than taken from today's configuration, because a
   * slot's lock sidecar lives under the root the slot belongs to: a replayed
   * placement's slot belongs to the root its own record carries, and locking it
   * under a different one excludes nobody.
   */
  holdSlot(root: string, kind: SlotKind, path: string, subject: string): Operation<void>;
  /** Hold the shared Git directory a new Worktree selector may change. */
  holdCommon(commonDirectory: string): Operation<void>;
  /** Run live selector work for one slot in order within this entry. */
  serialize<T>(key: string, work: () => Operation<T>): Operation<T>;
  /** This entry's private map from the selections it minted to what it holds. */
  readonly selections: SelectionRegistry<ReplPlacementRegistration>;
  /** Remember a placement so file work can route into it and reacquire its slot. */
  remember(registration: ReplPlacementRegistration): void;
}

/**
 * Select the managed Repository this invocation names, or answer from the
 * record of selecting it.
 *
 * The locator is admitted before anything else, because admission is pure and
 * its refusal is the same on every run: a url this provider will not hand to
 * Git is refused without a record, so a continuation refuses it again rather
 * than replaying a verdict about a string it can still see.
 */
export function* selectReplRepository(
  entry: ReplSelectionEntry,
  request: RepositoryRequest,
): Operation<RepositorySelection> {
  const locator = admitLocator(request.locator);
  if (locator === undefined) {
    throw repositoryRefusal(request.name, "invalid-locator");
  }
  const recorded: ReplPlacementRequest = Object.freeze({
    kind: "repository" as const,
    name: request.name,
    locatorFingerprint: locatorFingerprint(locator),
    base: request.base ?? null,
  });

  const registration = yield* recordedPlacement(entry, recorded, {
    slot: (root) => repositorySlot(root, locator, request.name),
    // The locator this invocation admitted, which is where a branch of this
    // Repository publishes to. Nothing is read for it and nothing is recorded.
    origin: () => admitted(locator),
    // The slot lease, before anything inspects or creates the checkout, and
    // held until this entry tears down.
    acquire: (root, slot) =>
      entry.holdSlot(root, "repository", slot, `repository ${JSON.stringify(request.name)}`),
    *perform(root, slot) {
      {
        const managed = yield* selectManagedRepository(yield* entry.git(), entry.host, slot, {
          name: request.name,
          locator,
          base: request.base,
        });
        const identity: RepositoryIdentity = Object.freeze({
          name: request.name,
          locatorFingerprint: managed.metadata.locatorFingerprint,
          requestedBase: managed.metadata.requestedBase,
          creationCommit: managed.creationCommit,
          primaryBranch: managed.metadata.primaryBranch,
          objectFormat: managed.objectFormat,
        });
        return Object.freeze({
          kind: "repository" as const,
          managedRoot: root,
          checkoutRoot: managed.checkout,
          commonDirectory: managed.commonDirectory,
          identity,
          displayName: request.name,
          // A Repository's own checkout is where a Worktree of it runs
          // `worktree add`.
          ownerCheckout: managed.checkout,
        });
      }
    },
  });

  return mint(entry, registration);
}

/**
 * Select a named linked checkout of a Repository this entry already selected.
 *
 * The owner is authenticated against this entry's own registry before any
 * native work, so a Repository selection that was copied, rebuilt or edited
 * names no checkout here. Its stable facts — identity, common directory and
 * owner checkout — are what the record is named by, because the selection the
 * provider minted for it is fresh every entry and would name a different
 * question each time.
 */
export function* selectReplWorktree(
  entry: ReplSelectionEntry,
  repository: RepositorySelection,
  request: WorktreeRequest,
): Operation<RepositorySelection> {
  const held = entry.selections.authenticate(
    repository,
    () => new RepositorySelectionError("<Worktree>"),
  );
  const owner = held.placement;
  const recorded: ReplPlacementRequest = Object.freeze({
    kind: "worktree" as const,
    name: request.name,
    branch: request.branch,
    base: request.base ?? null,
    owner: owner.identity,
    commonDirectory: owner.commonDirectory,
    ownerCheckout: owner.ownerCheckout,
  });

  const registration = yield* recordedPlacement(entry, recorded, {
    slot: (root) => worktreeSlot(root, owner.commonDirectory, request.name),
    // A linked checkout publishes where its own repository does, so this is
    // the owner's answer and never a second admission of anything.
    origin: () => held.origin(),
    *acquire(root, slot) {
      yield* entry.holdSlot(root, "worktree", slot, `worktree ${JSON.stringify(request.name)}`);
      // Before the selector, not after: `worktree add` writes refs and linked
      // administration into the Git directory every checkout of that repository
      // shares, and whether this call creates or reuses is the selector's own
      // answer rather than something to predict.
      yield* entry.holdCommon(owner.commonDirectory);
    },
    *perform(root, slot) {
      {
        const managed = yield* selectManagedWorktree(yield* entry.git(), slot, {
          name: request.name,
          branch: request.branch,
          base: request.base,
          owner: owner.commonDirectory,
          ownerCheckout: owner.ownerCheckout,
        });
        return Object.freeze({
          kind: "worktree" as const,
          managedRoot: root,
          checkoutRoot: managed.checkout,
          commonDirectory: managed.commonDirectory,
          // The owner's identity, because that is the repository this checkout
          // belongs to; the worktree's own name, because that is which checkout
          // of it this selection points at.
          identity: owner.identity,
          displayName: request.name,
          ownerCheckout: owner.ownerCheckout,
        });
      }
    },
  });

  return mint(entry, registration);
}

/**
 * The Repository this entry is standing in, as a root-level `<Worktree>` needs
 * it.
 *
 * Recorded, so a continuation learns which repository a root Worktree belonged
 * to without asking Git again — including when the session was opened inside a
 * linked worktree, where the checkout the command ran in and the repository it
 * belongs to are two different paths.
 *
 * Being outside a checkout is not a recordable answer. It is the existing
 * actionable refusal, and it is fatal for the same reason it always was: later
 * siblings must not run as though a repository had been found.
 */
export function* selectReplAmbientOwner(
  entry: ReplSelectionEntry,
  from: string,
): Operation<RepositorySelection> {
  const recorded: ReplPlacementRequest = Object.freeze({
    kind: "ambient-owner" as const,
    cwd: from,
  });

  const registration = yield* recordedPlacement(entry, recorded, {
    slot: () => undefined,
    // Nothing is held for it: this is the checkout the person was already in.
    acquire: () => nothing(),
    // The ambient repository's own recorded origin, admitted when it was
    // discovered. Asked through the entry's shared discovery and only when a
    // publication needs it, so a replayed selection reaches no `git`.
    *origin(): Operation<string | undefined> {
      return (yield* entry.ambient())?.origin;
    },
    *perform() {
      const ambient = yield* entry.ambient();
      if (ambient === undefined) {
        throw new NoAmbientRepositoryError("this element");
      }
      const identity: RepositoryIdentity = Object.freeze({
        name: ambient.name,
        locatorFingerprint:
          ambient.originFingerprint ?? locatorFingerprint(ambient.commonDirectory),
        requestedBase: null,
        creationCommit: ambient.head,
        primaryBranch: ambient.defaultBranch,
        objectFormat: ambient.objectFormat,
      });
      return Object.freeze({
        kind: "ambient-owner" as const,
        // Nothing placed it: this is the checkout the person was already in.
        managedRoot: undefined,
        checkoutRoot: ambient.checkoutRoot,
        commonDirectory: ambient.commonDirectory,
        identity,
        displayName: ambient.name,
        ownerCheckout: ambient.checkoutRoot,
      });
    },
  });

  return mint(entry, registration);
}

/**
 * Perform this selection once, or answer with the placement performing it
 * produced.
 *
 * The durable operation consumes its own position, so two equal selections at
 * two positions each record and replay their own. The live work is handed the
 * managed root, because that is the one fact a live selection needs and a
 * replayed one must not ask for: recanonicalizing today's configured root to
 * check a historical answer would make an answer about yesterday depend on what
 * is on disk now.
 */
function* recordedPlacement(
  entry: ReplSelectionEntry,
  request: ReplPlacementRequest,
  selector: ReplPlacementSelector,
): Operation<ReplPlacementRegistration> {
  const fingerprint = yield* replPlacementFingerprint(request);
  const name = replPlacementRecordName({ kind: request.kind, fingerprint });

  // Journal data on a replay, so it arrives as the unknown it is and is parsed
  // below rather than trusted as this code's own.
  const stored: unknown = yield* performed(entry, request, selector, fingerprint, name);

  const parsed = parseReplPlacementRecord(stored);
  if (parsed === undefined) {
    throw new ReplPlacementRecordError(
      `the saved ${describe(request)} is not one this host can read, so what it says about the ` +
        "checkout this entry was working in is unknown.",
    );
  }
  if (parsed.kind !== request.kind || parsed.fingerprint !== fingerprint) {
    throw new ReplPlacementRecordError(
      `the saved placement standing where ${describe(request)} belongs describes another ` +
        "selection, so this history does not say what happened here.",
    );
  }
  if (!parsed.outcome.ok) {
    throw placementFailure(request, refusalOf(parsed.outcome.error));
  }
  return registered(request, parsed.outcome.value, selector.slot, selector.origin);
}

/**
 * How one selection derives its slot, takes its holds and performs itself.
 *
 * The slot is a function of the root rather than a value, because a live
 * selection derives it from the configured root and a replayed one from the
 * root its own result recorded. Both derive it from what the document wrote —
 * the name, the locator, the owner — which is why the record needs to carry
 * neither the slot nor the locator.
 */
interface ReplPlacementSelector {
  slot(root: string): string | undefined;
  /** The holds a genuinely new selection needs, taken before it runs. */
  acquire(root: string, slot: string): Operation<void>;
  /** Call the ordinary selector, and describe what it selected. */
  perform(root: string, slot: string): Operation<ReplPlacement>;
  /**
   * Where a publication from this checkout would go, asked only when one is.
   *
   * Live and replayed selections share it, because it is not a fact about
   * either: it is what this entry can see about the destination now, and a
   * selection that was answered from a record still knows the locator the
   * document in front of it wrote.
   */
  origin(): Operation<string | undefined>;
}

/**
 * Perform this selection, or read the record of performing it — and reach the
 * holds only for the first.
 *
 * The retained cursor is read before anything is acquired, because a lease is
 * not something a saved answer needs: a continuation standing on a completed
 * placement answers from it, and taking the slot to do so would be a hold
 * nobody asked for and a refusal nobody can act on.
 *
 * Acquisition therefore happens *outside* the recorded operation. That is what
 * keeps a slot another entry is holding an ordinary refusal the person can act
 * on — close the other session and ask again — rather than a durability failure
 * the entry cannot recover from, and what keeps temporary contention out of the
 * journal.
 *
 * The peek is a hint and never an authority: the durable engine remains the
 * only judge of position. A hint that guessed wrong costs a hold this entry
 * would have taken a moment later, which is why {@link attempted} asks for the
 * same holds again — idempotently — around work that really does run live.
 */
function* performed(
  entry: ReplSelectionEntry,
  request: ReplPlacementRequest,
  selector: ReplPlacementSelector,
  fingerprint: string,
  name: string,
): Operation<unknown> {
  function* once(): Operation<unknown> {
    const stored: unknown = yield createDurableOperation<Json>(
      { type: REPL_REPOSITORY_PLACEMENT, name },
      function* () {
        const outcome = yield* attempted(request, selector, yield* entry.root());
        return replPlacementRecordJson({ fingerprint, request, outcome });
      },
      { coordinator: placementCoordinator },
    );
    return stored;
  }

  if (yield* retainedRecordAhead(REPL_REPOSITORY_PLACEMENT, name)) {
    return yield* once();
  }
  const root = yield* entry.root();
  const slot = selector.slot(root);
  if (slot === undefined) {
    return yield* once();
  }
  // One slot, one live selector at a time inside this entry. Two `<All>`
  // branches asking for the same checkout both record at their own positions,
  // and both must; what they may not do is have two clones racing into one
  // directory, so the second waits and then performs its own ordinary reuse
  // check — which is what it would have done arriving a moment later.
  return yield* entry.serialize(slot, function* () {
    yield* selector.acquire(root, slot);
    return yield* once();
  });
}

/**
 * Run the live selector, or classify its refusal as one this record may carry.
 *
 * A classified refusal is an answer the document asked for and is written down.
 * Anything else is infrastructure: it publishes no completion, so a continuation
 * reaches the ordinary live path rather than replaying a verdict this host has
 * no word for.
 */
function* attempted(
  request: ReplPlacementRequest,
  selector: ReplPlacementSelector,
  root: string,
): Operation<Result<ReplPlacement>> {
  const slot = selector.slot(root) ?? "";
  try {
    yield* selector.acquire(root, slot);
    // Scoped, so everything the selector itself acquired — the authentication a
    // clone opened above all — is released and *joined* before this answer
    // becomes a result. Without it the selector's resources outlive the
    // publication: the durable substrate runs this callback and its append in
    // one task, so a credential would still be being torn down while the
    // placement was already acknowledged and the body had begun. What stays
    // outside is what the entry owns: the Git session, its isolation directory
    // and both holds, each acquired into the entry's own scope above.
    return Ok(yield* scoped(() => selector.perform(root, slot)));
  } catch (error) {
    const refusal = classified(request, error);
    if (refusal === undefined) {
      throw error;
    }
    return Err(new ReplPlacementRefusal(refusal));
  }
}

/**
 * The closed classification this failure refuses under, or `undefined`.
 *
 * Three conditions and no more. A native `GitRefusal` from a clone or a
 * `worktree add` and a `CompositionRefusal` both carry a word from the
 * composition vocabulary and are translated through that vocabulary's own
 * sentence, which is how a live refusal and a replayed one end up as the same
 * text. A `ManagedCheckoutError` keeps its own word.
 *
 * `in-use` is not one of them. A slot another entry holds is contention decided
 * before this selection begins, and writing it down would make somebody else's
 * open session the permanent answer to this question.
 */
function classified(
  request: ReplPlacementRequest,
  error: unknown,
): ReplPlacementRefusalData | undefined {
  if (request.kind === "ambient-owner") {
    // Discovery answers with a repository or with nothing, and nothing is the
    // existing actionable refusal rather than an outcome worth writing down.
    return undefined;
  }
  if (error instanceof ManagedCheckoutError) {
    const reason = MANAGED_REFUSALS.find((word) => word === error.reason);
    return reason === undefined
      ? undefined
      : { vocabulary: "managed", reason, sentence: error.message };
  }
  const word = gitWord(error) ?? compositionWord(request, error);
  if (word === undefined) {
    return undefined;
  }
  if (request.kind === "worktree") {
    const refusal = worktreeRefusal(request.name, word);
    return { vocabulary: "worktree", reason: refusal.reason, sentence: refusal.message };
  }
  const refusal = repositoryRefusal(request.name, word);
  return { vocabulary: "repository", reason: refusal.reason, sentence: refusal.message };
}

function gitWord(error: unknown): string | undefined {
  return error instanceof GitRefusal ? error.reason : undefined;
}

function compositionWord(request: ReplPlacementRequest, error: unknown): string | undefined {
  if (!(error instanceof CompositionRefusal)) {
    return undefined;
  }
  return refusalReason(error, request.kind === "worktree" ? "worktree" : "repository");
}

/**
 * The failure a refused selection reaches the document as.
 *
 * Built here on a live refusal and on a replayed one alike, so the two cannot
 * diverge: what the record carries is a word and a sentence, and this is the one
 * place either of them becomes an error a component shows.
 */
function placementFailure(request: ReplPlacementRequest, data: ReplPlacementRefusalData): Error {
  if (data.vocabulary === "managed") {
    return new ManagedCheckoutError(data.reason, data.sentence);
  }
  if (data.vocabulary === "worktree") {
    return new WorktreeCompositionError(named(request), data.reason, data.sentence);
  }
  return new RepositoryCompositionError(named(request), data.reason, data.sentence);
}

/**
 * The managed words a completed selection may carry, as this adapter writes
 * them.
 *
 * Assigned to the provider's own vocabulary beside it, so a renamed or removed
 * managed reason fails to compile here rather than silently leaving a word the
 * record format still names.
 */
const MANAGED_REFUSALS: readonly ReplManagedRefusalReason[] = [
  "incompatible-reuse",
  "partial-creation",
  "unusable-checkout",
];

/**
 * The refusal data a parsed failure carries.
 *
 * The codec's failure side is this class by construction, so anything else here
 * is this host's own invariant rather than something a record did.
 */
function refusalOf(error: Error): ReplPlacementRefusalData {
  if (!(error instanceof ReplPlacementRefusal)) {
    throw new ReplPlacementRecordError(
      "a saved placement refusal carries no closed classification, so what it refused is unknown.",
    );
  }
  return error.refusal;
}

/**
 * Hold a parsed placement to the call it is standing at, with pure arithmetic.
 *
 * Three questions, and none of them touches a filesystem. The result describes
 * the same request it is named by; the identity it carries is the one that
 * request asked for; and the checkout it names is the one this request's own
 * slot would hold under the root the result itself records. A record that
 * disagrees with any of them is not an answer to this call.
 */
function registered(
  request: ReplPlacementRequest,
  placement: ReplPlacement,
  slotOf: (root: string) => string | undefined,
  origin: () => Operation<string | undefined>,
): ReplPlacementRegistration {
  if (placement.kind !== request.kind) {
    throw mismatch(request);
  }
  if (request.kind === "ambient-owner") {
    if (placement.managedRoot !== undefined || placement.ownerCheckout !== placement.checkoutRoot) {
      throw mismatch(request);
    }
    return Object.freeze({ placement, slot: undefined, origin });
  }
  const root = placement.managedRoot;
  if (root === undefined || placement.displayName !== request.name) {
    throw mismatch(request);
  }
  if (request.kind === "repository") {
    if (
      placement.identity.name !== request.name ||
      placement.identity.locatorFingerprint !== request.locatorFingerprint ||
      placement.identity.requestedBase !== request.base ||
      placement.ownerCheckout !== placement.checkoutRoot
    ) {
      throw mismatch(request);
    }
  } else if (
    !sameRepositoryIdentity(placement.identity, request.owner) ||
    placement.commonDirectory !== request.commonDirectory ||
    placement.ownerCheckout !== request.ownerCheckout
  ) {
    throw mismatch(request);
  }
  // Derived from the root the result itself records, never from today's
  // configured one: a check of a historical answer that recanonicalized the
  // root would answer about the filesystem rather than about the record.
  const path = slotOf(root);
  if (path === undefined || checkoutOf(path) !== placement.checkoutRoot) {
    throw mismatch(request);
  }
  return Object.freeze({
    placement,
    slot: Object.freeze({ kind: request.kind, path }),
    origin,
  });
}

/** A locator this provider already admitted, as an answer rather than a read. */
// deno-lint-ignore require-yield
function* admitted(locator: string): Operation<string> {
  return locator;
}

function mismatch(request: ReplPlacementRequest): ReplPlacementRecordError {
  return new ReplPlacementRecordError(
    `the saved ${describe(request)} describes a checkout that is not the one this selection ` +
      "names, so this history does not say where the entry was working.",
  );
}

/**
 * Remember this placement for the entry, and mint this execution's selection.
 *
 * The selection is fresh every entry and private to this provider: the record
 * holds the stable facts, and nothing a document can see, copy or rebuild names
 * a checkout on its own.
 */
function mint(
  entry: ReplSelectionEntry,
  registration: ReplPlacementRegistration,
): RepositorySelection {
  entry.remember(registration);
  const placement = registration.placement;
  const key =
    registration.slot?.path ?? `ambient ${placement.commonDirectory} ${placement.checkoutRoot}`;
  return entry.selections.mint(
    key,
    placement.displayName,
    placement.identity,
    placement.checkoutRoot,
    registration,
  );
}

/**
 * How a managed slot's refusal names what it is about.
 *
 * Derived from the placement rather than from the request, so a live selection
 * and a restored one that reacquires the same slot say the same thing about it.
 */
export function placementSubject(placement: ReplPlacement): string {
  return `${placement.kind} ${JSON.stringify(placement.displayName)}`;
}

/** An operation that acquires nothing, for a selection that holds nothing. */
// deno-lint-ignore require-yield
function* nothing(): Operation<void> {}

function named(request: ReplPlacementRequest): string {
  return request.kind === "ambient-owner" ? "" : request.name;
}

function describe(request: ReplPlacementRequest): string {
  if (request.kind === "ambient-owner") {
    return "ambient repository for this entry";
  }
  return `${request.kind} selection ${JSON.stringify(request.name)}`;
}

/**
 * The live boundary one recorded selection publishes through.
 *
 * The same contract PR 1's local operations publish under, for the same reason:
 * the default coordinator would serialize whatever was thrown and publish it as
 * this selection's outcome, and a provider that broke its contract may or may
 * not have cloned a repository. So a throw activates the durability fence and is
 * re-raised with its identity intact, publishing nothing — and a continuation
 * takes the ordinary live path, where the existing partial-creation policy
 * decides what to do about whatever native work did happen.
 *
 * A valid outcome — a placement or a classified refusal — is published once. A
 * failing append is the engine's own persistence fence and is not caught here.
 */
const placementCoordinator: LiveDurableOperationCoordinator = {
  *run<T extends Json>(
    execute: () => Operation<T>,
    publish: (result: ProtocolResult) => Operation<void>,
    activateFailure: ActivateDurabilityFailure,
  ): Operation<ProtocolResult> {
    let value: T;
    try {
      value = yield* execute();
    } catch (error) {
      throw activateFailure(error);
    }
    const result: ProtocolResult = { status: "ok", value };
    yield* publish(result);
    return result;
  },
};

/**
 * Run work keyed on one slot in order, within one entry.
 *
 * Two `<All>` branches may ask for the same Repository at the same time. Both
 * record at their own positions and both must, so neither may be suppressed —
 * but both calling the selector at once would have two clones racing into one
 * directory. So the second waits for the first and then performs its own
 * ordinary reuse check, which is what it would have done arriving a moment
 * later.
 *
 * ## A waiter that leaves releases nothing
 *
 * The turn is a queue with one holder, rather than a chain of waiters each
 * signalling the next. Chaining is what made a cancelled waiter grant the slot:
 * its cleanup resolved its own completion, which is all its successor was
 * waiting for, so the successor entered while the *holder* was still working.
 *
 * Here a waiter that is cancelled before it is granted the turn takes itself
 * out of the queue and signals nothing, so exclusion stays with whoever has it.
 * Its own teardown is prompt and waits for no live work. A waiter that was
 * granted the turn and then cancelled before it resumed hands the turn on
 * rather than stranding it, which is the one case the two cleanups have to tell
 * apart.
 */
/**
 * The one turn an entry's native Git for one shared Git directory takes.
 *
 * Named here rather than spelled at each caller, because the key *is* the
 * exclusion: every operation of this entry that runs `git` against one common
 * directory — Add, Switch, Commit, the publication's observation, and the four
 * reads — has to name the same string. A caller that spelled its own would be
 * handed its own queue by a serializer the two were sharing, which looks like
 * participation and is not.
 */
export function nativeGitTurn(commonDirectory: string): string {
  return `git ${commonDirectory}`;
}

export function slotTurns(): <T>(key: string, work: () => Operation<T>) => Operation<T> {
  interface Waiting {
    readonly granted: WithResolvers<void>;
    /** Whether the turn has been handed to this waiter. */
    taken: boolean;
  }
  interface Slot {
    held: boolean;
    readonly queue: Waiting[];
  }
  const slots = new Map<string, Slot>();

  /** Hand the turn to the next waiter, or leave the slot free. */
  function release(key: string, slot: Slot): void {
    const next = slot.queue.shift();
    if (next === undefined) {
      slot.held = false;
      slots.delete(key);
      return;
    }
    next.taken = true;
    next.granted.resolve();
  }

  return function* <T>(key: string, work: () => Operation<T>): Operation<T> {
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = { held: false, queue: [] };
      slots.set(key, slot);
    }
    const here = slot;
    if (here.held) {
      const mine: Waiting = { granted: withResolvers<void>(), taken: false };
      here.queue.push(mine);
      let entered = false;
      try {
        yield* mine.granted.operation;
        entered = true;
      } finally {
        if (!entered) {
          if (mine.taken) {
            // Granted and never taken up: the turn is this waiter's to hand on.
            release(key, here);
          } else {
            // Never granted: there is nothing to release, and the holder keeps
            // what it has.
            const at = here.queue.indexOf(mine);
            if (at >= 0) {
              here.queue.splice(at, 1);
            }
          }
        }
      }
    }
    here.held = true;
    try {
      return yield* work();
    } finally {
      release(key, here);
    }
  };
}
