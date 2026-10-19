/**
 * Publish the contextual checkout's current branch to its Repository origin
 * (specs/workflow-workspace-spec.md §7.4).
 *
 * The enclosing Repository and cwd select the checkout, including a linked
 * worktree reached through Dir. Remote, branch, commit, refspec and force are
 * not authored inputs, and the remote cannot join the local transaction: what
 * reconciliation proves before it publishes belongs to the host policy beneath
 * this body and stays in the journal.
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
import { boundComponent } from "../invocation-binding.ts";
import type { BindOperations, ComponentBody } from "../invocation-binding.ts";

export const PUSH = "<Git.Push>";

export const props: PropsSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const documentation: FirstPartyDocumentation = {
  description:
    `Publish the current branch. \`<Git.Push />\` pushes its current commit to the same branch ` +
    `on \`origin\` without forcing.`,
  as: null,
  context: null,
};

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

const METADATA = {
  name: "Git.Push",
  origin: COMPOSITION_ORIGIN,
  props,
  forms: ["self-closing"] as const,
  ...documented(documentation),
};

/**
 * The form comes from the scan, not from a contextual `hasContent()` answer: an
 * irreversible publication is not something an installed handler may select.
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

/** An ordinary registered default, over whichever provider the host installed. */
export function pushRegistration(push: GitApi["push"]): ComponentRegistration {
  return { ...METADATA, fn: dispatched((props) => body(props, push)) };
}

/** A declaration, for an execution that owns this operation's policy. */
export function pushDeclaration(bind: BindOperations<GitApi["push"]>): IdentityComponent {
  return {
    ...METADATA,
    factory: (claim: IdentityClaimant) => dispatched(boundComponent(claim, bind, body)),
  };
}
