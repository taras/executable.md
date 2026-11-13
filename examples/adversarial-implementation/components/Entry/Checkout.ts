import { GitRepositoryError } from "@executablemd/git";
import { gitRoot } from "@executablemd/git/api";
import { cwd, realpath } from "@executablemd/runtime";
import type { Operation } from "effection";
import { z } from "zod";
import { retainedVerdict } from "../Delivery/observation.ts";

export const props = {
  type: "object",
  properties: { root: { type: "string", minLength: 1 } },
  required: ["root"],
  additionalProperties: false,
};

const input = z.strictObject({ root: z.string().min(1) });

export default function* Checkout(value: unknown): Operation<string | null> {
  const { root } = input.parse(value);
  return yield* retainedVerdict("entry-checkout-verdict", z.string().nullable(), () =>
    observe(root),
  );
}

function* observe(root: string): Operation<string | null> {
  const expected = yield* realpath(root);
  if (expected === undefined) {
    throw new Error("The assigned Git checkout is no longer available: " + root);
  }
  const directory = yield* cwd();
  let observedRoot: string;
  try {
    observedRoot = yield* gitRoot();
  } catch (error) {
    if (
      error instanceof GitRepositoryError &&
      /exited 128 — fatal: (not a git repository|this operation must be run in a work tree)/.test(
        error.message,
      )
    ) {
      return `The selected entry directory ${directory} is outside a Git worktree. Run from the assigned checkout ${expected}.`;
    }
    throw error;
  }
  const observed = yield* realpath(observedRoot);
  if (observed === undefined) {
    throw new Error("The selected Git checkout is no longer available: " + observedRoot);
  }
  return observed === expected
    ? null
    : `Run from the assigned checkout ${expected}. The selected entry checkout is ${observed}.`;
}
