/**
 * `<TempDir>` — an isolated temporary directory (specs/executable-mdx-spec.md §6.11).
 *
 * Written with content it is a working directory: everything expanded inside
 * observes it as the contextual `Env.cwd`, and it is removed when the content
 * finishes, fails, or is cancelled. Written self-closing it is an allocation:
 * the directory is retained at the invocation site so a later sibling can use
 * the path it renders, and removed with that scope.
 *
 * The directory comes from the installed `API.Files` provider, so this
 * component neither creates nor removes anything itself. A provider that has no
 * temporary directories to give — one whose whole filesystem is a database
 * transaction — refuses the operation outright, and that refusal is fatal
 * rather than a printed error: there is no directory to run inside, so the
 * content must not run and the siblings after it must not proceed as though it
 * had.
 *
 * What a failure *inside* the directory means is not this component's to say.
 * The `printErrors` declaration below covers acquisition — the one thing this
 * component does on its own — while the content belongs to the region it is
 * written in: printed at a root, fail-closed inside an `<Output>` region, and
 * continued only where an author asked for that with `<PrintErrors>` (§6.11).
 */

import type { Operation } from "effection";
import { printErrors } from "../component-failures.ts";
import { API, parseFilesFailure } from "@executablemd/runtime";
import { ReplayGuard, StaleInputError } from "@executablemd/durable-streams";
import { content, retain } from "../component-api.ts";
import { hasContent } from "../content-context.ts";
import { temporaryDirectory } from "../files.ts";
import { reason } from "./fs-error-phrases.ts";

export const props = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/** A temporary directory that could not be created. */
export class TempDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TempDirError";
  }
}

/**
 * A directory that lives as long as the acquiring scope.
 *
 * The provider owns creation and removal as one acquisition, so nothing can
 * land between them and leave a directory nobody holds. What this adds is the
 * unwrapping: an ordinary acquisition failure is a printed error naming no path
 * — the directory is generated and the document never chose its name — while a
 * provider that refuses the operation has already thrown past here.
 *
 * Exported for the lifetime tests, which drive acquisition directly. Not part
 * of the package's public surface — `mod.ts` does not re-export it.
 */
export function* useTemporaryDirectory(): Operation<string> {
  const acquired = yield* temporaryDirectory();
  if (!acquired.ok) {
    throw new TempDirError(
      `cannot create a temporary directory: ${reason(parseFilesFailure(acquired.error)?.reason)}.`,
    );
  }
  return acquired.value;
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
        // it: the ambient error mode must not be able to downgrade a
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

export default printErrors(function* (): Operation<string> {
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
    return yield* content();
  }
  return yield* retain(useTemporaryDirectory);
});
