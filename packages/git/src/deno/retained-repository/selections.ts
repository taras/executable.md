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
import { selectManagedRepository, selectManagedWorktree } from "../run-composition/checkouts.ts";
import { repositorySlot, worktreeSlot } from "../run-composition/placement.ts";
import type { Leases } from "../run-composition/leases.ts";
import { inventoryFrontier } from "./frontier.ts";
import { retain } from "./local.ts";
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
        // Leased before anything is created, and held for the rest of the
        // entry: a slot another process is working in refuses here rather than
        // being discovered halfway through a clone.
        yield* host.leases.hold("repository", slot, `repository ${JSON.stringify(name)}`);
        const git = gitSession(host.repository, host.managedRoot);
        const selected = yield* selectManagedRepository(git, host.repository, slot, {
          name,
          locator,
          base,
        });
        const checkout: SelectedCheckout = Object.freeze({
          checkout: selected.checkout,
          directory: selected.checkout,
          common: selected.commonDirectory,
          git,
        });
        host.select(checkout);

        const retained = yield* retainSelection(host, checkout, occurrence, "repository", {
          name,
          locator,
          base: base ?? null,
        });
        if (!retained.ok) {
          throw retained.error;
        }

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
        yield* host.leases.hold("worktree", slot, `worktree ${JSON.stringify(name)}`);
        const git = gitSession(host.repository, host.managedRoot);
        const selected = yield* selectManagedWorktree(git, slot, {
          name,
          branch,
          base,
          owner: owner.common,
          ownerCheckout: owner.directory,
        });
        const checkout: SelectedCheckout = Object.freeze({
          checkout: selected.checkout,
          directory: selected.checkout,
          common: selected.commonDirectory,
          git,
        });
        host.select(checkout);

        const retained = yield* retainSelection(host, checkout, occurrence, "worktree", {
          name,
          branch,
          base: base ?? null,
          owner: owner.checkout,
        });
        if (!retained.ok) {
          throw retained.error;
        }

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

/**
 * Retain one selection as its lane's baseline.
 *
 * Its two ends are one state, so a resume adopts it: a selection that has
 * already happened is a checkout that is simply there, and holding it to the
 * snapshot it recorded would refuse every entry that went on to do anything in
 * it.
 */
function* retainSelection(
  host: RetainedSelectionHost,
  checkout: SelectedCheckout,
  occurrence: string,
  operation: "repository" | "worktree",
  request: Record<string, string | null>,
): Operation<Result<unknown>> {
  return yield* retain(
    {
      owner: host.files.owner,
      site: host.files.site(occurrence),
      operation,
      checkout: checkout.checkout,
      common: checkout.common,
      position: host.files.position(checkout.common),
      selection: { checkout: checkout.checkout },
      request,
      inventory: () =>
        inventoryFrontier({
          git: checkout.git,
          checkout: checkout.checkout,
          directory: checkout.directory,
        }),
      // deno-lint-ignore require-yield
      *prepare(preState) {
        return Ok({
          postState: preState,
          prepared: { checkout: checkout.checkout, common: checkout.common },
          evidence: { type: operation, checkout: checkout.checkout },
        });
      },
      // deno-lint-ignore require-yield
      *perform() {
        return Ok({ type: operation, checkout: checkout.checkout });
      },
    },
    host.files.resume,
    host.files.lanes,
  );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A selection this entry could not make. */
export function selectionRefused(sentence: string): Result<never> {
  return Err(new Error(sentence));
}
