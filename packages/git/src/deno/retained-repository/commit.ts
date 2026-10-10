/**
 * `Git.Commit`, with the object it writes decided before it is written.
 *
 * A commit's identity is a digest of everything that goes into it — the tree,
 * the ordered parents, the exact message bytes, both names and addresses, and
 * both timestamps with their offsets. All of it is frozen here, and the object
 * id it produces is computed in a disposable copy of the administration, so the
 * intent records the exact commit that is about to exist.
 *
 * That is what makes an interrupted commit recoverable. A resume compares the
 * checkout against the two states the intent froze: HEAD already at the
 * predicted commit means the commit happened and is adopted, HEAD still at the
 * parent means it did not and the saved inputs may be committed. Choosing a new
 * clock or a new identity on that second attempt would produce a different
 * object, so neither is chosen again — they are read out of the intent.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { cwd } from "@executablemd/runtime";
import { content } from "@executablemd/core";
import type { IdentityClaimant, IdentityComponent } from "@executablemd/core/host";
import type { Json } from "@executablemd/durable-streams";
import {
  admitCommitMessage,
  composeCommitMessage,
  props as commitProps,
  returns as commitReturns,
} from "../../composition/components/GitCommit.ts";
import { GitOperationError } from "../../composition/errors.ts";
import { commitIndex, headTree, indexTree, resolveCommit } from "../composition/git.ts";
import { captureCommitIdentity, denoIdentityReader } from "../run-composition/identity.ts";
import type { GitCommitIdentity } from "../run-composition/identity.ts";
import type { RepositoryHost } from "../composition/host.ts";
import { inventoryFrontier } from "./frontier.ts";
import { retain } from "./local.ts";
import type { RetainedFileHost, SelectedCheckout } from "./files.ts";
import { useScratchAdministration } from "./scratch.ts";
import type { RetainedFrontier, RetainedRef } from "../../retained-repository/records.ts";

const COMMIT = "Git.Commit";

/** `Git.Commit`, as a retained entry answers for it. */
export function retainedCommit(
  host: RetainedFileHost,
  repository: RepositoryHost,
): IdentityComponent {
  return {
    name: COMMIT,
    origin: "@executablemd/git/retained",
    props: commitProps,
    returns: commitReturns,
    description:
      "Commit what is staged. `<Git.Commit message={summary} />` writes one commit in the " +
      "selected checkout.",
    factory: (claim: IdentityClaimant) =>
      function* GitCommit(props, invocation): Operation<string> {
        const directory = yield* cwd();
        const occurrence = yield* claim(invocation);
        const selected = yield* host.covering(directory);
        if (selected === undefined) {
          throw new GitOperationError(
            COMMIT,
            "invalid-invocation",
            "<Git.Commit> is written outside a repository this entry has selected.",
          );
        }
        // Composed once, from what the document wrote, and canonicalized once:
        // a commit message is authored prose, and the bytes that go into the
        // object are the bytes the intent freezes.
        const message = admitCommitMessage(
          composeCommitMessage(
            typeof props.message === "string" ? props.message : undefined,
            invocation.hasContent() ? yield* content() : "",
          ).message,
        );

        const produced = yield* retain(
          {
            owner: host.owner,
            site: host.site(occurrence),
            operation: "commit",
            checkout: selected.checkout,
            common: selected.common,
            position: host.position(selected.common),
            selection: { checkout: selected.checkout },
            request: { cwd: directory, message },
            inventory: () =>
              inventoryFrontier({
                git: selected.git,
                checkout: selected.checkout,
                directory: selected.directory,
              }),
            *prepare(preState) {
              if (preState === null) {
                return Err(
                  new GitOperationError(
                    COMMIT,
                    "invalid-invocation",
                    "<Git.Commit> has no absent state: it commits in a checkout that exists.",
                  ),
                );
              }
              return yield* predictCommit(repository, selected, preState, message);
            },
            *perform(transition) {
              const frozen = frozenCommit(transition.prepared);
              if (frozen === undefined) {
                return Err(
                  new GitOperationError(
                    COMMIT,
                    "invalid-invocation",
                    "<Git.Commit> cannot be performed from what its intent froze.",
                  ),
                );
              }
              yield* commitIndex(selected.git, {
                operation: COMMIT,
                workingDirectory: directory,
                message: frozen.message,
                committedAt: frozen.committedAt,
                ...(frozen.identity === undefined ? {} : { identity: frozen.identity }),
              });
              const written = yield* resolveCommit(selected.git, selected.directory, "HEAD");
              if (written === undefined) {
                return Err(
                  new GitOperationError(
                    COMMIT,
                    "invalid-invocation",
                    "<Git.Commit> wrote a commit the checkout did not report.",
                  ),
                );
              }
              return Ok({ type: "commit", commit: written });
            },
          },
          host.resume,
          host.lanes,
        );
        if (!produced.ok) {
          throw produced.error;
        }
        const commit = produced.value;
        return typeof commit === "object" && commit !== null && !Array.isArray(commit)
          ? String(Reflect.get(commit, "commit") ?? "")
          : "";
      },
  };
}

/** Everything one commit is made of, frozen before it exists. */
interface FrozenCommit {
  readonly message: string;
  readonly committedAt: number;
  readonly identity: GitCommitIdentity | undefined;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly commit: string;
}

/**
 * The exact commit this operation will write.
 *
 * Nothing here touches the selected checkout. The tree and the object id are
 * computed in a copy of the administration, which goes away with this
 * operation; the repository the document is working in has the same objects
 * and the same refs afterwards as before.
 */
function* predictCommit(
  repository: RepositoryHost,
  selected: SelectedCheckout,
  preState: RetainedFrontier,
  message: string,
): Operation<Result<{ postState: RetainedFrontier; prepared: Json; evidence: Json }>> {
  // The one condition a document can act on, decided from the checkout's own
  // state before anything is predicted or recorded.
  const staged = yield* indexTree(selected.git, selected.directory);
  const committed = yield* headTree(selected.git, selected.directory);
  if (staged === undefined) {
    return Err(
      new GitOperationError(COMMIT, "invalid-invocation", "<Git.Commit> could not read the index."),
    );
  }
  if (staged === committed) {
    return Err(
      new GitOperationError(
        COMMIT,
        "empty-index",
        "<Git.Commit> has nothing staged to commit: the index holds what HEAD already does.",
      ),
    );
  }

  const identity = yield* captureCommitIdentity(denoIdentityReader(selected.directory));
  // Captured once and frozen. A retry reads this out of the intent rather than
  // asking the clock again, because a different second is a different object.
  const committedAt = Math.floor(Date.now() / 1000);
  const parents = preState.head.oid === null ? [] : [preState.head.oid];

  const scratch = yield* useScratchAdministration(repository, preState.administration.common);
  const tree = yield* selected.git.read(
    ["--git-dir", scratch.gitDir, "write-tree"],
    selected.directory,
  );
  if (tree === undefined) {
    return Err(
      new GitOperationError(
        COMMIT,
        "invalid-invocation",
        "<Git.Commit> could not predict the tree it would commit.",
      ),
    );
  }
  // `run` rather than `read`, because this one command needs the message on
  // standard input and the frozen instant and identity in its environment.
  const written = yield* selected.git.run(
    [
      "--git-dir",
      scratch.gitDir,
      "commit-tree",
      tree,
      ...parents.flatMap((parent) => ["-p", parent]),
    ],
    selected.directory,
    {
      input: message,
      committedAt,
      ...(identity === undefined ? {} : { identity }),
    },
  );
  const predicted =
    written.code === 0 && written.stdout.trim() !== "" ? written.stdout.trim() : undefined;
  if (predicted === undefined) {
    return Err(
      new GitOperationError(
        COMMIT,
        "invalid-invocation",
        "<Git.Commit> could not predict the commit it would write.",
      ),
    );
  }

  const frozen: FrozenCommit = {
    message,
    committedAt,
    identity,
    tree,
    parents,
    commit: predicted,
  };
  return Ok({
    postState: advanced(preState, predicted),
    prepared: frozenJson(frozen),
    evidence: { type: "commit", commit: predicted },
  });
}

/** The checkout with HEAD, and the branch it is on, at the new commit. */
function advanced(preState: RetainedFrontier, commit: string): RetainedFrontier {
  const on = preState.head.kind === "symbolic" ? preState.head.ref : undefined;
  const head =
    on === undefined
      ? { kind: "detached" as const, oid: commit }
      : { kind: "symbolic" as const, ref: on, oid: commit };
  const refs: RetainedRef[] = preState.refs.map((ref) =>
    ref.name === on ? { name: ref.name, oid: commit } : ref,
  );
  if (on !== undefined && !refs.some((ref) => ref.name === on)) {
    // The first commit on an unborn branch creates the ref it is on.
    refs.push({ name: on, oid: commit });
    refs.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  }
  return Object.freeze({
    checkout: preState.checkout,
    administration: preState.administration,
    objectFormat: preState.objectFormat,
    head: Object.freeze(head),
    refs: Object.freeze(refs),
    index: preState.index,
    worktree: preState.worktree,
  });
}

function frozenJson(frozen: FrozenCommit): Json {
  return {
    message: frozen.message,
    committedAt: frozen.committedAt,
    identity:
      frozen.identity === undefined
        ? null
        : {
            authorName: frozen.identity.authorName,
            authorEmail: frozen.identity.authorEmail,
            committerName: frozen.identity.committerName,
            committerEmail: frozen.identity.committerEmail,
          },
    tree: frozen.tree,
    parents: [...frozen.parents],
    commit: frozen.commit,
  };
}

/** What a retained intent froze, read back out of it. */
function frozenCommit(prepared: Json): FrozenCommit | undefined {
  if (typeof prepared !== "object" || prepared === null || Array.isArray(prepared)) {
    return undefined;
  }
  const message = Reflect.get(prepared, "message");
  const committedAt = Reflect.get(prepared, "committedAt");
  const tree = Reflect.get(prepared, "tree");
  const commit = Reflect.get(prepared, "commit");
  const parents = Reflect.get(prepared, "parents");
  if (
    typeof message !== "string" ||
    typeof committedAt !== "number" ||
    typeof tree !== "string" ||
    typeof commit !== "string" ||
    !Array.isArray(parents)
  ) {
    return undefined;
  }
  return {
    message,
    committedAt,
    identity: identityOf(Reflect.get(prepared, "identity")),
    tree,
    parents: parents.filter((parent): parent is string => typeof parent === "string"),
    commit,
  };
}

function identityOf(value: unknown): GitCommitIdentity | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const authorName = Reflect.get(value, "authorName");
  const authorEmail = Reflect.get(value, "authorEmail");
  const committerName = Reflect.get(value, "committerName");
  const committerEmail = Reflect.get(value, "committerEmail");
  if (
    typeof authorName !== "string" ||
    typeof authorEmail !== "string" ||
    typeof committerName !== "string" ||
    typeof committerEmail !== "string"
  ) {
    return undefined;
  }
  return Object.freeze({ authorName, authorEmail, committerName, committerEmail });
}
