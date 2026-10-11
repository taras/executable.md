/**
 * `<Repository>` and `<Worktree>`, as a REPL entry selects them.
 *
 * A selection is one ordinary live operation — the same managed placement an
 * ordinary run makes, with the same leases, the same metadata rules and the
 * same refusals — recorded once. What the record holds is the identity that
 * selection established and where it put the checkout, which is the small
 * logical fact a later open needs to send this entry's descendants to the same
 * place.
 *
 * A completed selection therefore replays without running the selector: no
 * clone, no `worktree add`, no metadata read and no proof that the checkout is
 * still what it was. The routing is rebuilt from the saved result and the
 * entry's own trusted placement; whether the directory still holds what it held
 * is the person's business, and a later operation that needs it will say so in
 * its own words.
 *
 * The native selection itself is the existing one. Nothing about placement,
 * metadata, reuse or refusal is reimplemented here: this adds the record and
 * the occurrence that names it.
 */

import { Ok } from "effection";
import type { Operation, Result } from "effection";
import { API, cwd } from "@executablemd/runtime";
import { content } from "@executablemd/core";
import type { IdentityClaimant, IdentityComponent } from "@executablemd/core/host";
import type { Json } from "@executablemd/durable-streams";
import { join } from "node:path";
import { props as repositoryProps } from "../../composition/components/Repository.ts";
import { props as worktreeProps } from "../../composition/components/Worktree.ts";
import { RepositoryCompositionError, WorktreeCompositionError } from "../../composition/errors.ts";
import { members, text } from "../../composition/parse.ts";
import { parseRepositoryIdentity } from "../../composition/selection.ts";
import type { RepositoryIdentity } from "../../composition/selection.ts";
import { gitSession } from "../composition/git.ts";
import type { RepositoryHost } from "../composition/host.ts";
import { selectManagedRepository, selectManagedWorktree } from "../run-composition/checkouts.ts";
import { checkoutOf, repositorySlot, worktreeSlot } from "../run-composition/placement.ts";
import type { Leases } from "../run-composition/leases.ts";
import type { RegisteredCheckout } from "../run-composition/operations.ts";
import { holdCommonDirectory, recorded } from "./local.ts";
import type { CheckoutPublication, RetainedFileHost, SelectedCheckout } from "./files.ts";
import { managedPublication } from "./publication.ts";

const RETAINED_ORIGIN = "@executablemd/git/retained";

/** What these two components need beyond the file host. */
export interface RetainedSelectionHost {
  readonly files: RetainedFileHost;
  readonly repository: RepositoryHost;
  /**
   * The trusted root managed placements live under, as one canonical path.
   *
   * An operation rather than a value, because the answer is infrastructure this
   * entry may never need: it is created and canonicalized by the first managed
   * selection that asks, and an entry that selects nothing asks nobody. Every
   * identity below is derived from what it answers — the slot, the common
   * directory and the lease — so that they are all derived from one spelling of
   * one directory.
   */
  root(): Operation<string>;
  /** The leases over that same canonical root. */
  slots(): Operation<Leases>;
  /** Remember a selection so later work in it is covered. */
  select(checkout: SelectedCheckout): void;
  /** The checkout a `<Worktree>` belongs to, which is where it is added from. */
  owner(): SelectedCheckout | undefined;
}

/**
 * What a selection establishes, as its own result reports it.
 *
 * Every member is a fact about identity or placement: where the checkout is,
 * which shared Git directory it administers, which repository it is a checkout
 * of and where that repository publishes. Nothing here describes the contents
 * of anything, which is what makes it replayable without reading a directory.
 */
export interface SelectionResult {
  readonly checkout: string;
  readonly common: string;
  readonly identity: RepositoryIdentity;
  readonly origin: string | null;
  /** The checkout of the repository this one belongs to. */
  readonly repositoryDirectory: string;
  readonly repositoryName: string;
  readonly worktreeName: string | null;
}

const SELECTION_RESULT_MEMBERS = [
  "type",
  "checkout",
  "common",
  "identity",
  "origin",
  "repositoryDirectory",
  "repositoryName",
  "worktreeName",
] as const;

/** This selection's own result, as the journal holds it. */
export function selectionResultJson(
  operation: "repository" | "worktree" | "ambient",
  selection: SelectionResult,
): Json {
  return {
    type: operation,
    checkout: selection.checkout,
    common: selection.common,
    identity: { ...selection.identity },
    origin: selection.origin,
    repositoryDirectory: selection.repositoryDirectory,
    repositoryName: selection.repositoryName,
    worktreeName: selection.worktreeName,
  };
}

/**
 * The selection this result describes, or `undefined`.
 *
 * Parsed exactly, including on the live path: one reader builds the routing
 * from one shape, so a replay and a first run reach the same association by the
 * same code rather than by two that happen to agree.
 */
export function parseSelectionResult(value: Json): SelectionResult | undefined {
  const read = members(value, SELECTION_RESULT_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const checkout = text(read["checkout"]);
  const common = text(read["common"]);
  const identity = parseRepositoryIdentity(read["identity"]);
  const origin = read["origin"] === null ? null : text(read["origin"]);
  const repositoryDirectory = text(read["repositoryDirectory"]);
  const repositoryName = text(read["repositoryName"]);
  const worktreeName = read["worktreeName"] === null ? null : text(read["worktreeName"]);
  if (
    checkout === undefined ||
    common === undefined ||
    identity === undefined ||
    origin === undefined ||
    repositoryDirectory === undefined ||
    repositoryName === undefined ||
    worktreeName === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    checkout,
    common,
    identity,
    origin,
    repositoryDirectory,
    repositoryName,
    worktreeName,
  });
}

/** The checkout this entry routes work in, built from one selection result. */
export function selectedFrom(
  selection: SelectionResult,
  git: ReturnType<typeof gitSession>,
  publication: () => Operation<Result<CheckoutPublication>>,
): SelectedCheckout {
  const registered: RegisteredCheckout = Object.freeze({
    root: selection.checkout,
    identity: selection.identity,
    repositoryName: selection.repositoryName,
    worktreeName: selection.worktreeName,
    origin: selection.origin ?? undefined,
  });
  return Object.freeze({
    checkout: selection.checkout,
    directory: selection.checkout,
    common: selection.common,
    git,
    registered,
    publication,
  });
}

/** `<Repository>`, with the placement it selected recorded. */
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

        const root = yield* host.root();
        const slot = repositorySlot(root, locator, name);
        const destination = checkoutOf(slot);
        // Leased before the slot is looked at, and held for the rest of the
        // entry: a slot or a shared Git directory another process is working in
        // refuses here rather than being discovered halfway through a clone. A
        // managed repository's own `.git` is its own, but it is leased all the
        // same — a `<Worktree>` of it later shares exactly this directory.
        yield* holdCommonDirectory(join(destination, ".git"), host.files.owner);
        yield* (yield* host.slots()).holdAll([
          { kind: "repository", slot, subject: `repository ${JSON.stringify(name)}` },
          {
            kind: "common",
            slot: join(destination, ".git"),
            subject: `the Git directory of repository ${JSON.stringify(name)}`,
          },
        ]);
        const git = gitSession(host.repository, root);

        const produced = yield* recorded({
          owner: host.files.owner,
          site: host.files.site(occurrence),
          operation: "repository",
          request: { name, url: locator, base: base ?? null },
          *perform(): Operation<Result<Json>> {
            // The ordinary managed selection: an existing compatible checkout
            // is reused, a missing one is created, a half-created one refuses,
            // and all of that is this host's existing behaviour.
            const managed = yield* selectManagedRepository(git, host.repository, slot, {
              name,
              locator,
              base,
            });
            const identity: RepositoryIdentity = Object.freeze({
              name,
              locatorFingerprint: managed.metadata.locatorFingerprint,
              requestedBase: managed.metadata.requestedBase,
              creationCommit: managed.creationCommit,
              primaryBranch: managed.metadata.primaryBranch,
              objectFormat: managed.objectFormat,
            });
            return Ok(
              selectionResultJson("repository", {
                checkout: managed.checkout,
                common: managed.commonDirectory,
                identity,
                origin: managed.metadata.locator,
                repositoryDirectory: managed.checkout,
                repositoryName: name,
                worktreeName: null,
              }),
            );
          },
        });
        if (!produced.ok) {
          throw produced.error;
        }
        const selection = parseSelectionResult(produced.value);
        if (selection === undefined) {
          throw new RepositoryCompositionError(
            name,
            "unusable-repository",
            "<Repository> has a recorded selection this host cannot read, so where its content " +
              "belongs is not something this history says.",
          );
        }
        // The destination this request names is the destination the record
        // names. A record is entitled to say which checkout it selected;
        // whether that is the checkout this document is asking for is decided
        // here, where the trusted root is known.
        if (selection.checkout !== destination) {
          throw new RepositoryCompositionError(
            name,
            "unusable-repository",
            "<Repository> has a recorded selection of a different managed placement than the " +
              "one this request names.",
          );
        }

        const checkout = selectedFrom(selection, git, () =>
          managedPublication(slot, selection.checkout),
        );
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

/** `<Worktree>`, with the placement it selected recorded. */
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

        const root = yield* host.root();
        const slot = worktreeSlot(root, owner.common, name);
        const destination = checkoutOf(slot);
        // Both leases before anything is inspected: the destination's slot and
        // the owner's shared directory, because adding a worktree moves refs
        // the owner shares. The owner's lease is normally already held — this
        // entry selected it — and asking again for one it holds costs nothing.
        yield* holdCommonDirectory(owner.common, host.files.owner);
        yield* (yield* host.slots()).holdAll([
          { kind: "worktree", slot, subject: `worktree ${JSON.stringify(name)}` },
          {
            kind: "common",
            slot: owner.common,
            subject: `the Git directory worktree ${JSON.stringify(name)} is added to`,
          },
        ]);
        const git = gitSession(host.repository, root);

        const produced = yield* recorded({
          owner: host.files.owner,
          site: host.files.site(occurrence),
          operation: "worktree",
          request: { name, branch, base: base ?? null, owner: owner.checkout },
          *perform(): Operation<Result<Json>> {
            const managed = yield* selectManagedWorktree(git, slot, {
              name,
              branch,
              base,
              owner: owner.common,
              ownerCheckout: owner.directory,
            });
            return Ok(
              selectionResultJson("worktree", {
                checkout: managed.checkout,
                // The owner's shared directory: a linked worktree administers
                // the repository's own, which is the object database both of
                // them publish from.
                common: owner.common,
                identity: owner.registered.identity,
                origin: owner.registered.origin ?? null,
                repositoryDirectory: owner.directory,
                repositoryName: owner.registered.repositoryName,
                worktreeName: name,
              }),
            );
          },
        });
        if (!produced.ok) {
          throw produced.error;
        }
        const selection = parseSelectionResult(produced.value);
        if (selection === undefined || selection.checkout !== destination) {
          throw new WorktreeCompositionError(
            name,
            "unusable-repository",
            "<Worktree> has a recorded selection this host cannot read as the placement this " +
              "request names.",
          );
        }

        const checkout = selectedFrom(selection, git, () => owner.publication());
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
