/**
 * Which scopes inside a Plan writer frame may read the document filesystem.
 *
 * The writer frame refuses every capability it can reach: a Plan decides what
 * to write, and writing a file, running a command, starting a service and
 * reaching the network are all the approved document's business. One phase of
 * the Component is the exception. A `<PlanInformation>` projection runs public
 * `<Evaluate>` under the host's own ceiling so an Agent can ask what a file
 * holds before proposing a Plan — and that read now travels the ordinary Files
 * route, where the frame's ambient refusal is sitting.
 *
 * So the refusal needs to tell one thing from another: a read performed inside
 * a live information projection, and every other read in the frame. Both arrive
 * at the same guard, through the same Api, with the same arguments. What
 * separates them is **where** they are asked from, and that is what this
 * module keeps track of.
 *
 * ## Why scopes, and not a context
 *
 * A context is reachable to anything that can spell its name, and a flag in one
 * would be a permission a document could set. Private `WeakMap`s keyed by the
 * real `Scope` objects are reachable to nothing but this module: a scope cannot
 * be forged, cannot be named and cannot be handed over, so a holder either *is*
 * the scope the grant was opened for or is a descendant of it.
 *
 * Descendants are the whole difficulty. The engine hosts an invocation's
 * content in a scope it creates lazily from the invocation's body scope, and
 * every element inside the fragment runs in further children of that. Nothing
 * walks a scope's ancestry from outside, so membership is established as the
 * tree is built: a Plan-local observer on `api.Scope` sees each child as it is
 * created, delegates the creation unchanged, and records the child under
 * whatever its parent held. That covers the hosted content, `scoped()` children
 * and spawned tasks alike, because all of them create their scope through that
 * one API.
 *
 * ## What a grant is, and is not
 *
 * It is not a capability. The guard it unlocks *delegates* — the enclosing and
 * descendant Files middleware keep their ordinary turn, the installed provider
 * still performs the operation, and the effective `Permissions` of the scope
 * asking still decide it. A grant says only "this read is the information
 * phase's, so do not refuse it here".
 *
 * It is also not a mode. Every mutation stays refused inside the projection,
 * and every read stays refused outside it — a writer sibling created while a
 * projection is open inherits the writer record and no grant, and a nested
 * writer frame has a record of its own that another frame's grant does not
 * match. Nothing here is process-wide, and nothing survives the projection: the
 * grant is revoked in the projection's own `finally`, and the record with the
 * writer frame it belongs to.
 */

import { ensure, useScope } from "effection";
import type { Operation, Scope } from "effection";
import { api } from "effection/experimental";

/** One writer frame's private bookkeeping. */
interface WriterRecord {
  live: boolean;
}

/** One live information projection, belonging to one writer frame. */
interface ReadGrant {
  live: boolean;
  readonly record: WriterRecord;
}

/** What the writer frame's capability refusal asks before it refuses a read. */
export interface PlanWriterAccess {
  /**
   * Whether the scope asking is inside a live information projection of *this*
   * writer frame.
   *
   * Read at the call, from the consuming scope, so a read performed after the
   * projection settled — or in a sibling that never held a grant — is answered
   * no with nothing to reset.
   */
  reading(): Operation<boolean>;
}

/** The private access bookkeeping one `<Plan>` declaration owns. */
export interface PlanAccess {
  /**
   * Begin the writer frame, in the authenticated writer invocation's own scope.
   *
   * Registers its own revocation before the record exists, so a frame that is
   * torn down — or interrupted while being built — leaves nothing a later read
   * could match.
   */
  openWriter(): Operation<PlanWriterAccess>;
  /**
   * Open a read grant for this information projection, and answer with how to
   * close it.
   *
   * Called in the authenticated `<PlanInformation>` body, before its first
   * projection, so the scope it binds is the one the engine hosts that
   * projection's content from. A wrapper scope opened here instead would be a
   * sibling of the hosted content rather than its parent, and the content would
   * inherit nothing.
   */
  openInformation(): Operation<() => void>;
}

/**
 * One declaration's access bookkeeping.
 *
 * Built where the `<Plan>` declaration is built, and its closures handed to the
 * two private factories — so the maps are shared by exactly the phases of one
 * Component and reachable from nothing else. Not a package export, not a
 * context, and not a general facility: an implementation detail of this
 * Component with the lifetime of the declaration that holds it.
 */
export function createPlanAccess(): PlanAccess {
  const records = new WeakMap<Scope, WriterRecord>();
  const grants = new WeakMap<Scope, ReadGrant>();

  /**
   * Follow the tree as it grows.
   *
   * The delegation is unconditional and the result is returned exactly as it
   * came back: this observes scope creation and changes nothing about it. A
   * child is recorded under its parent's record, and under its parent's grant
   * when the parent is inside a live projection — which is how the hosted
   * content of an information body, and everything that content creates, come
   * to be covered without anything walking ancestry later.
   */
  function observe(scope: Scope): void {
    scope.around(api.Scope, {
      create([parent], next) {
        const created = next(parent);
        const child = created[0];
        const record = records.get(parent);
        if (record !== undefined) {
          records.set(child, record);
        }
        const grant = grants.get(parent);
        if (grant !== undefined) {
          grants.set(child, grant);
        }
        return created;
      },
    });
  }

  return {
    *openWriter(): Operation<PlanWriterAccess> {
      const scope = yield* useScope();
      const record: WriterRecord = { live: true };
      // Registered before the record is reachable, so an interruption between
      // the two leaves no record behind rather than one nothing revokes.
      yield* ensure(() => {
        record.live = false;
      });
      records.set(scope, record);
      observe(scope);
      return {
        *reading(): Operation<boolean> {
          const asking = yield* useScope();
          const grant = grants.get(asking);
          // All three, and the record identity is the one that is easy to
          // forget: a nested writer frame's projection holds a live grant, and
          // it is not this frame's to honour.
          return grant !== undefined && grant.live && grant.record.live && grant.record === record;
        },
      };
    },
    *openInformation(): Operation<() => void> {
      // The body's own scope, which is the parent the engine creates this
      // invocation's hosted content from.
      const scope = yield* useScope();
      const record = records.get(scope);
      if (record === undefined) {
        // An information phase outside any writer frame of this declaration.
        // Nothing to grant and nothing to refuse differently: the projection
        // runs under whatever the enclosing scope already permits.
        return () => {};
      }
      const grant: ReadGrant = { live: true, record };
      grants.set(scope, grant);
      return () => {
        grant.live = false;
      };
    },
  };
}
