/**
 * Publish the contextual checkout's current branch to its Repository origin
 * (specs/workflow-workspace-spec.md §7.4).
 *
 * `<Git.Push />` takes no props or content, renders nothing and binds nothing.
 * The enclosing Repository and cwd select the checkout, including a linked
 * worktree reached through Dir. Remote, branch, commit, refspec and force are not
 * authored inputs; reconciliation evidence stays in the journal.
 *
 * The remote cannot join the local transaction. Shared Git-host reconciliation
 * observes first, adopts this exact commit, publishes a proven absence or advances
 * a proven ancestor once, and refuses unproven compatibility. It never force-pushes
 * or changes upstream tracking.
 *
 * Git.Switch's failure policy applies. Detached HEAD is a fixed GitOperationError
 * before remote contact; missing Repository is an admission failure that printing
 * cannot recover.
 *
 * The form is settled by canonical dispatch rather than read from the
 * invocation: an irreversible publication is not something a composable
 * `hasContent()` answer may select.
 */

import { cwd } from "@executablemd/runtime";
import { documented, formDispatcher } from "@executablemd/core";
import type {
  ComponentRegistration,
  FirstPartyDocumentation,
  FunctionComponent,
  PropsSchema,
} from "@executablemd/core";
import type { IdentityClaimant, IdentityComponent } from "@executablemd/core/host";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { GitApi } from "../git-api.ts";
import { COMPOSITION_ORIGIN } from "../definitions.ts";
import { selectedRepository } from "../context.ts";
import { GitOperationAdmissionError, GitOperationError } from "../errors.ts";
import { boundComponent, unboundComponent } from "../invocation-binding.ts";
import type { BindOperations, ComponentBody, InvocationGate } from "../invocation-binding.ts";

/** The component name, as a document writes it and as a refusal names it. */
export const PUSH = "<Git.Push>";

export const props: PropsSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/** What a reader is told about this component, in one place. */
export const documentation: FirstPartyDocumentation = {
  description:
    `Publish the current branch. \`<Git.Push />\` pushes its current commit to the same branch ` +
    `on \`origin\` without forcing.`,
  as: null,
  context: null,
};

/**
 * The one implementation, whatever host performs it.
 *
 * It observes the two facts a document can see — the Repository in scope and
 * the contextual working directory — and asks the publication operation this
 * invocation was bound to. Which journal that operation writes to, and whether
 * it reconciles a request made an hour ago, belongs to the host policy beneath
 * it and appears nowhere here.
 */
export const body: ComponentBody<GitApi["push"]> = function* GitPush(
  _props: Record<string, Json>,
  push: GitApi["push"],
): Operation<Json> {
  const repository = yield* selectedRepository();
  if (repository === undefined) {
    throw new GitOperationAdmissionError(
      PUSH,
      "it is written outside a lexical <Repository>, so there is no repository in scope whose " +
        "origin a branch could be published to",
    );
  }
  yield* push({ repository, workingDirectory: yield* cwd() });
  return "";
};

/**
 * What a catalog says about this component, whichever path declares it.
 *
 * One object, because one component is described one way: a host that
 * registers it ordinarily and a host that declares it with policy of its own
 * are the same `Git.Push` to a reader.
 */
const METADATA = {
  name: "Git.Push",
  origin: COMPOSITION_ORIGIN,
  props,
  forms: ["self-closing"] as const,
  ...documented(documentation),
};

/**
 * Canonical form dispatch, so the form is settled by the scan before the body
 * runs.
 *
 * A contextual `hasContent()` answer cannot admit a paired publication: the
 * chain that answers one is composed by whoever installed a handler, and an
 * irreversible external effect is not something a handler may choose.
 */
function dispatched(fn: FunctionComponent): FunctionComponent {
  return formDispatcher({
    forms: "self-closing",
    fn,
    refuse: () =>
      new GitOperationError(
        PUSH,
        "invalid-invocation",
        `${PUSH} renders nothing, so it takes no content. Write it as <Git.Push />.`,
      ),
  });
}

/** `Git.Push` as an ordinary registered default, over the public Git Api. */
export function pushRegistration(
  operations: (gate: InvocationGate) => GitApi["push"],
): ComponentRegistration {
  return { ...METADATA, fn: dispatched(unboundComponent(PUSH, operations, body)) };
}

/** `Git.Push` as a declaration, for a host that supplies its own policy. */
export function pushDeclaration(bind: BindOperations<GitApi["push"]>): IdentityComponent {
  return {
    ...METADATA,
    factory: (claim: IdentityClaimant) =>
      dispatched(boundComponent(claim, { element: PUSH, bind, body })),
  };
}
