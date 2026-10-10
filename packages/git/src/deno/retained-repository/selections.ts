/**
 * `<Repository>` and `<Worktree>`, as a retained entry selects them.
 *
 * These two differ from the mutations beside them in what they are fenced by.
 * A mutation freezes the state it expects to find and is held to finding it; a
 * selection has no such state, because the checkout it is about to establish
 * does not exist yet. What fences a selection is its placement: the managed
 * slot is leased before anything is created, an existing compatible checkout is
 * observed rather than reset, and a half-created one is preserved and refused
 * instead of being completed on a guess.
 *
 * What a selection retains is therefore the identity and the initial state it
 * established — the baseline every mutation in that lane is held to following.
 * Its two frozen ends are one state, because selecting changed nothing about a
 * checkout that is now simply there.
 *
 * The native selection itself is the existing one. Nothing about placement,
 * metadata, reuse or refusal is reimplemented here: this adds the record and
 * the occurrence that names it.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { cwd } from "@executablemd/runtime";
import { content } from "@executablemd/core";
import type { IdentityClaimant, IdentityComponent } from "@executablemd/core/host";
import { API } from "@executablemd/runtime";
import { props as repositoryProps } from "../../composition/components/Repository.ts";
import { props as worktreeProps } from "../../composition/components/Worktree.ts";
import { RepositoryCompositionError, WorktreeCompositionError } from "../../composition/errors.ts";
import { gitSession } from "../composition/git.ts";
import type { RepositoryHost } from "../composition/host.ts";
import {
  observeManagedSlot,
  selectManagedRepository,
  selectManagedWorktree,
} from "../run-composition/checkouts.ts";
import { ManagedCheckoutError } from "../run-composition/errors.ts";
import { checkoutOf, repositorySlot, worktreeSlot } from "../run-composition/placement.ts";
import { join } from "node:path";
import { predictRepositoryCreation, predictWorktreeCreation } from "./creation.ts";
import type { Leases } from "../run-composition/leases.ts";
import { inventoryFrontier } from "./frontier.ts";
import { retain } from "./local.ts";
import type { CreationObservation } from "./local.ts";
import type { RetainedFileHost, SelectedCheckout } from "./files.ts";

const RETAINED_ORIGIN = "@executablemd/git/retained";

/** What these two components need beyond the file host. */
export interface RetainedSelectionHost {
  readonly files: RetainedFileHost;
  readonly repository: RepositoryHost;
  /** The trusted root managed placements live under. */
  readonly managedRoot: string;
  readonly leases: Leases;
  /** Remember a selection so later work in it is covered. */
  select(checkout: SelectedCheckout): void;
  /** The checkout a `<Worktree>` belongs to, which is where it is added from. */
  owner(): SelectedCheckout | undefined;
}

/** `<Repository>`, retained. */
export function retainedRepository(host: RetainedSelectionHost): IdentityComponent {
  return {
    name: "Repository",
    origin: RETAINED_ORIGIN,
    props: repositoryProps,
    forms: ["paired"],
    description:
      'Clone or use a repository. `<Repository name="project" url={props.repository}>…' +
      "</Repository>` expands its content in the specified checkout.",
    factory: (claim: IdentityClaimant) =>
      function* Repository(props, invocation): Operation<string> {
        const name = text(props.name);
        const locator = text(props.url);
        if (name === undefined || locator === undefined) {
          throw new RepositoryCompositionError(
            String(props.name ?? ""),
            "invalid-locator",
            "<Repository> needs a name and a url.",
          );
        }
        const base = text(props.base);
        const occurrence = yield* claim(invocation);

        const slot = repositorySlot(host.managedRoot, locator, name);
        // Leased before the slot is even looked at, and held for the rest of
        // the entry: a slot another process is working in refuses here rather
        // than being discovered halfway through a clone.
        yield* host.leases.hold("repository", slot, `repository ${JSON.stringify(name)}`);
        const git = gitSession(host.repository, host.managedRoot);
        const destination = checkoutOf(slot);
        const common = join(destination, ".git");

        const observed = yield* observeManagedSlot(slot);
        if (observed.state === "partial") {
          throw new ManagedCheckoutError(
            "partial-creation",
            `the managed checkout for repository ${JSON.stringify(name)} holds an interrupted ` +
              `creation: ${observed.reason}. Every byte was left where it was.`,
          );
        }
        // An existing compatible checkout is verified by the ordinary managed
        // selection, which changes nothing when it is reusing one. Creation is
        // the only branch that mutates, and it happens inside `perform`.
        const established =
          observed.state === "established"
            ? yield* selectManagedRepository(git, host.repository, slot, { name, locator, base })
            : undefined;

        const checkout: SelectedCheckout = Object.freeze({
          checkout: destination,
          directory: destination,
          common: established?.commonDirectory ?? common,
          git,
        });

        const retained = yield* retain(
          {
            owner: host.files.owner,
            site: host.files.site(occurrence),
            operation: "repository",
            checkout: checkout.checkout,
            common: checkout.common,
            position: host.files.position(checkout.common),
            selection: { checkout: checkout.checkout },
            request: {
              name,
              url: locator,
              base: base ?? null,
            },
            inventory: () => inventoryOf(checkout),
            *observe() {
              return yield* observeDestination(checkout, slot);
            },
            *prepare(preState) {
              if (preState !== null) {
                // Already there: selecting it changes nothing.
                return Ok({
                  postState: preState,
                  prepared: { checkout: checkout.checkout, common: checkout.common },
                  evidence: {
                    type: "repository",
                    checkout: checkout.checkout,
                    commit: established?.creationCommit ?? null,
                  },
                });
              }
              return yield* predictRepositoryCreation(host.repository, slot, {
                name,
                locator,
                base,
              });
            },
            *perform() {
              // The first mutation of this slot, and it happens only after the
              // intent above was acknowledged.
              const created = yield* selectManagedRepository(git, host.repository, slot, {
                name,
                locator,
                base,
              });
              return Ok({
                type: "repository",
                checkout: created.checkout,
                commit: created.creationCommit,
              });
            },
          },
          host.files.resume,
          host.files.lanes,
        );
        if (!retained.ok) {
          throw retained.error;
        }
        host.select(checkout);

        yield* API.Env.around(
          {
            // deno-lint-ignore require-yield
            *cwd(): Operation<string> {
              return checkout.directory;
            },
          },
          { at: "min" },
        );
        return yield* content();
      },
  };
}

/** `<Worktree>`, retained. */
export function retainedWorktree(host: RetainedSelectionHost): IdentityComponent {
  return {
    name: "Worktree",
    origin: RETAINED_ORIGIN,
    props: worktreeProps,
    forms: ["paired"],
    description:
      'Create or use a worktree. `<Worktree name="review" branch="issue-643">…</Worktree>` ' +
      "expands its content in the worktree.",
    factory: (claim: IdentityClaimant) =>
      function* Worktree(props, invocation): Operation<string> {
        const name = text(props.name);
        const branch = text(props.branch);
        if (name === undefined || branch === undefined) {
          throw new WorktreeCompositionError(
            String(props.name ?? ""),
            "no-repository-context",
            "<Worktree> needs a name and a branch.",
          );
        }
        const base = text(props.base);
        const occurrence = yield* claim(invocation);

        const owner = host.owner() ?? (yield* host.files.covering(yield* cwd()));
        if (owner === undefined) {
          throw new WorktreeCompositionError(
            name,
            "no-repository-context",
            "<Worktree> is written outside a repository this entry has selected, so there is " +
              "nothing for it to be a worktree of.",
          );
        }

        const slot = worktreeSlot(host.managedRoot, owner.common, name);
        // Both leases before anything is inspected: the destination's slot and
        // the owner's shared directory, because adding a worktree moves refs
        // the owner shares.
        yield* host.leases.hold("worktree", slot, `worktree ${JSON.stringify(name)}`);
        const git = gitSession(host.repository, host.managedRoot);
        const destination = checkoutOf(slot);

        const observed = yield* observeManagedSlot(slot);
        if (observed.state === "partial") {
          throw new ManagedCheckoutError(
            "partial-creation",
            `the managed checkout for worktree ${JSON.stringify(name)} holds an interrupted ` +
              `creation: ${observed.reason}. Every byte was left where it was.`,
          );
        }
        const established =
          observed.state === "established"
            ? yield* selectManagedWorktree(git, slot, {
                name,
                branch,
                base,
                owner: owner.common,
                ownerCheckout: owner.directory,
              })
            : undefined;

        const checkout: SelectedCheckout = Object.freeze({
          checkout: destination,
          directory: destination,
          common: owner.common,
          git,
        });

        const retained = yield* retain(
          {
            owner: host.files.owner,
            site: host.files.site(occurrence),
            operation: "worktree",
            checkout: checkout.checkout,
            // The owner's shared directory, which is the lane this creation
            // advances: its refs are what moves.
            common: owner.common,
            position: host.files.position(owner.common),
            selection: { checkout: checkout.checkout },
            request: {
              name,
              branch,
              base: base ?? null,
              owner: owner.checkout,
            },
            inventory: () => inventoryOf(checkout),
            *observe() {
              return yield* observeDestination(checkout, slot);
            },
            *prepare(preState) {
              if (preState !== null) {
                return Ok({
                  postState: preState,
                  prepared: { checkout: checkout.checkout, common: checkout.common },
                  evidence: {
                    type: "worktree",
                    checkout: checkout.checkout,
                    commit: established?.creationCommit ?? null,
                  },
                });
              }
              return yield* predictWorktreeCreation(host.repository, slot, owner, {
                name,
                branch,
                base,
              });
            },
            *perform() {
              const created = yield* selectManagedWorktree(git, slot, {
                name,
                branch,
                base,
                owner: owner.common,
                ownerCheckout: owner.directory,
              });
              return Ok({
                type: "worktree",
                checkout: created.checkout,
                commit: created.creationCommit,
              });
            },
          },
          host.files.resume,
          host.files.lanes,
        );
        if (!retained.ok) {
          throw retained.error;
        }
        host.select(checkout);

        yield* API.Env.around(
          {
            // deno-lint-ignore require-yield
            *cwd(): Operation<string> {
              return checkout.directory;
            },
          },
          { at: "min" },
        );
        return yield* content();
      },
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** This checkout's state right now. */
function inventoryOf(checkout: SelectedCheckout) {
  return inventoryFrontier({
    git: checkout.git,
    checkout: checkout.checkout,
    directory: checkout.directory,
  });
}

/**
 * What is where this destination will be, for a resume to decide from.
 *
 * The slot is asked first, because it is the slot that says whether a creation
 * finished: the metadata is written last, so a checkout without it is an
 * interrupted creation however complete the directory looks.
 */
function* observeDestination(
  checkout: SelectedCheckout,
  slot: string,
): Operation<Result<CreationObservation>> {
  const observed = yield* observeManagedSlot(slot);
  if (observed.state === "absent") {
    return Ok({ state: "absent" });
  }
  if (observed.state === "partial") {
    return Ok({ state: "partial", reason: observed.reason });
  }
  const frontier = yield* inventoryOf(checkout);
  if (!frontier.ok) {
    return Ok({
      state: "partial",
      reason: "the slot holds a checkout this host cannot describe",
    });
  }
  return Ok({ state: "established", frontier: frontier.value });
}
