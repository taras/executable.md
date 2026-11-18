import { registerComponents } from "@executablemd/core";
import { Component, Plugin } from "@executablemd/core/api";
import { API, cwd } from "@executablemd/runtime";
import { z } from "zod";
import RecoveryOwner, {
  props as ownerProps,
} from "../../../../../examples/adversarial-implementation/recovery/components/Ticket/RecoveryOwner.ts";

export default Plugin({
  name: "test://joined-response-source-boundary",
  *install() {
    yield* Component.around({
      *expand([request], next) {
        if (request.expansion.name === "Ticket.SelectModel") {
          throw new Error("UnexpectedModelSelection");
        }
        yield* next(request);
      },
    });
    yield* registerComponents([
      {
        name: "Fixture.Owner",
        props: ownerProps,
        returns: { type: "object" },
        fn: RecoveryOwner,
        origin: "test://joined-response",
      },
      {
        name: "Git.Changes",
        origin: "test://joined-response",
        props: { type: "object" },
        returns: { type: "object" },
        fn: observeChanges,
      },
    ]);
    return undefined;
  },
});

export function* observeChanges(value: unknown) {
  const input = z
    .object({
      compare: z.enum(["staged", "unstaged", "commits"]),
      base: z.string().optional(),
      head: z.string().optional(),
    })
    .parse(value);
  const repository = yield* cwd();
  const head = yield* API.Process.operations.exec({
    command: ["git", "rev-parse", "HEAD"],
    cwd: repository,
  });
  if (head.exitCode !== 0) {
    throw new Error(head.stderr);
  }
  const args =
    input.compare === "commits"
      ? [input.base ?? "", input.head ?? ""]
      : input.compare === "staged"
        ? ["--cached"]
        : [];
  const paths = yield* API.Process.operations.exec({
    command: ["git", "diff", "--name-only", "-z", ...args],
    cwd: repository,
  });
  if (paths.exitCode !== 0) {
    throw new Error(paths.stderr);
  }
  return {
    comparison: { base: (head.stdout ?? "").trim() },
    changes: (paths.stdout ?? "")
      .split("\0")
      .filter(Boolean)
      .map((path) => ({ path, status: "modified" })),
    next: null,
  };
}
