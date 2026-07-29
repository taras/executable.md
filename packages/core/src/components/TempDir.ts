/**
 * `<TempDir>` — an isolated temporary directory (specs/executable-mdx-spec.md §6.11).
 *
 * Written with content it is a working directory: everything expanded inside
 * observes it as the contextual `Env.cwd`, and it is removed when the content
 * finishes, fails, or is cancelled. Written self-closing it is an allocation:
 * the directory is retained at the invocation site so a later sibling can use
 * the path it renders, and removed with that scope.
 */

import { ensure, resource, until } from "effection";
import type { Operation } from "effection";
import { rm } from "@effectionx/fs";
import { API } from "@executablemd/runtime";
import { ReplayGuard, StaleInputError } from "@executablemd/durable-streams";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retain } from "../component-api.ts";
import { hasContent, useContent } from "../content-context.ts";

export const props = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/**
 * A directory this call created, named by its canonical path.
 *
 * `mkdtemp` creates and names in one step, so the directory cannot already
 * exist and cannot be claimed between the two — which generating a name and
 * then creating it does not rule out.
 *
 * The path is then canonicalized: on macOS `tmpdir()` is a symlink
 * (`/var/folders/…`) while a child process resolves it (`/private/var/…`).
 * Canonicalizing is what makes the rendered path, `Env.cwd`, and a
 * subprocess's own `cwd` the same string, so a document can compare them.
 *
 * `@effectionx/fs` has neither operation, so both come from Node.
 */
function useTemporaryDirectory(): Operation<string> {
  return resource(function* (provide) {
    const created = yield* until(mkdtemp(join(tmpdir(), "xmd-tempdir-")));
    yield* ensure(() => rm(created, { recursive: true, force: true }));
    yield* provide(yield* until(realpath(created)));
  });
}

/**
 * Refuse to replay a recorded effect inside this directory.
 *
 * Every run creates a *new* directory, but a journaled effect is matched by
 * description alone. Replaying one recorded under an earlier run would hand
 * the document output naming a directory that no longer exists, and the
 * filesystem work the effect stands for would never happen in the directory
 * this run created. Neither is detectable downstream, so the effect is refused
 * where it is recognised.
 *
 * Re-executing recorded effects inside a freshly established environment is a
 * durability design of its own (#218); until then a document that resumes from
 * a partial journal stops here rather than continuing on stale results.
 */
function refuseReplayInside(directory: string): Operation<void> {
  return ReplayGuard.around({
    decide([event], _next) {
      return {
        outcome: "error",
        // A StaleInputError, so expansion propagates it instead of rendering
        // it: the ambient error policy must not be able to downgrade a
        // durability failure to a comment and let later siblings run.
        error: new StaleInputError(
          `<TempDir> cannot replay the recorded ${event.description.type} effect ` +
            `"${event.description.name}": this run created ${directory}, and the recorded ` +
            "result belongs to a directory an earlier run created and removed. Re-run the " +
            "document from the start rather than resuming from a partial journal.",
          { coroutineId: event.coroutineId, description: event.description },
        ),
      };
    },
  });
}

export default function* (): Operation<string> {
  if (yield* hasContent()) {
    const directory = yield* useTemporaryDirectory();
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd() {
          return directory;
        },
      },
      { at: "min" },
    );
    yield* refuseReplayInside(directory);
    return yield* useContent();
  }
  return yield* retain(useTemporaryDirectory);
}
