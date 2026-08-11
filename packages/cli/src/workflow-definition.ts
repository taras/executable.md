/**
 * What a workflow run is a run of, established from Git.
 *
 * `xmd workflow start notes.md` names a file in a working tree. A working tree
 * changes, so it cannot be a run's identity — a resume months later has to mean
 * the same document. What becomes identity is the object: the repository's
 * object format, the full commit id `HEAD` resolved to once, and the document's
 * repository-relative path inside it.
 *
 * The consequence is the part worth stating plainly. **The bytes that execute
 * come from that commit, not from the file the caller pointed at.** A working
 * tree with uncommitted edits runs the committed document, because running the
 * edited one while recording the commit as identity would make the record a
 * claim about something that never ran.
 *
 * Where the repository is *checked out* is not identity. It is retrieval
 * metadata: replaceable, credential-free, excluded from the comparison that
 * decides whether a reused run id addresses the same run, and reauthorized
 * before it is used again. A run that moves between machines is the same run.
 *
 * Everything here goes through the contextual `Git` capability, so nothing
 * below runs a command of its own or names a host.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { Err, Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import {
  gitObjectFormat,
  parseWorkflowDefinition,
  readGitObject,
  repositoryRoot,
  revParse,
} from "@executablemd/workflow";
import type { GitWorkflowDefinitionV1, WorkflowDefinition } from "@executablemd/workflow";

/** The base a `start` records. The command has no base option, so it is this. */
export const DEFINITION_BASE = "HEAD";

/** How this host will find the definition again. Replaceable, never a credential. */
export const RETRIEVAL_KIND = "local-checkout";

/** Everything one `start` establishes before a run can exist. */
export interface EstablishedDefinition {
  readonly definition: WorkflowDefinition;
  readonly base: string;
  readonly pinnedCommit: string;
  readonly retrieval: Json;
  /** The document as the pinned commit holds it. */
  readonly source: string;
}

/** A definition that cannot be established, or a retained one that cannot be loaded. */
export class WorkflowDefinitionUnavailableError extends Error {
  override name = "WorkflowDefinitionUnavailableError";
}

function unavailable(message: string, cause?: unknown): WorkflowDefinitionUnavailableError {
  return new WorkflowDefinitionUnavailableError(message, cause === undefined ? {} : { cause });
}

/**
 * Run `body` with the repository as the contextual working directory.
 *
 * Git answers about the directory it is asked in, so every question about one
 * repository is asked from the same place rather than from wherever the process
 * started. Keeping Git's own output out of the caller's is the capability's
 * own business and is done there.
 */
function inRepository<T>(directory: string, body: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd(): Operation<string> {
          return directory;
        },
      },
      { at: "min" },
    );
    return yield* body();
  });
}

/**
 * The document's path inside its repository, as a definition may hold it.
 *
 * Repository-relative, POSIX-separated, and refused rather than repaired when
 * it leaves the working tree: a path outside the repository names no object in
 * the commit, and normalizing one would silently run a different document.
 */
function repositoryRelativePath(root: string, documentPath: string): Result<string> {
  const absolute = resolve(documentPath);
  const within = relative(resolve(root), absolute);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) {
    return Err(
      unavailable(
        "the document is not inside the repository this command resolved, so no commit in it " +
          "holds the document. Run the command from the repository the document belongs to.",
      ),
    );
  }
  return Ok(within.split(sep).join("/"));
}

/**
 * Establish the immutable definition of a run that is starting.
 *
 * The order matters: the repository is located from the document's own
 * directory, `HEAD` is resolved once, and the object format is read from the
 * same repository — so a definition never mixes one repository's commit with
 * another's format.
 */
export function* establishDefinition(
  documentPath: string,
): Operation<Result<EstablishedDefinition>> {
  const absolute = resolve(documentPath);
  try {
    const root = yield* inRepository(absolute.slice(0, absolute.lastIndexOf(sep)) || sep, () =>
      repositoryRoot(),
    );

    return yield* inRepository(root, function* (): Operation<Result<EstablishedDefinition>> {
      const rootDocumentPath = repositoryRelativePath(root, absolute);
      if (!rootDocumentPath.ok) {
        return rootDocumentPath;
      }

      const pinnedCommit = yield* revParse(`${DEFINITION_BASE}^{commit}`);
      const objectFormat = yield* gitObjectFormat();

      const definition = parseWorkflowDefinition({
        version: 1,
        kind: "git",
        objectFormat,
        objectId: pinnedCommit.toLowerCase(),
        rootDocumentPath: rootDocumentPath.value,
      });
      if (!definition.ok) {
        return definition;
      }

      const source = yield* readGitObject(pinnedCommit, rootDocumentPath.value);
      return Ok({
        definition: definition.value,
        base: DEFINITION_BASE,
        pinnedCommit,
        retrieval: { version: 1, kind: RETRIEVAL_KIND, checkout: root },
        source,
      });
    });
  } catch (error) {
    return Err(
      unavailable(
        `the workflow definition could not be established from ${documentPath}: ` +
          (error instanceof Error ? error.message : String(error)),
        error,
      ),
    );
  }
}

/**
 * The checkout a retained locator names, reauthorized before it is used.
 *
 * A retained path is replaceable metadata rather than permission a host already
 * has, so it is checked against the repository it claims to be: a directory
 * that is no longer a working tree, or is now a different one, fails rather
 * than quietly resolving the definition somewhere else.
 */
function parseRetrieval(metadata: Json | undefined): Result<string> {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return Err(
      unavailable(
        "this run retains no usable retrieval metadata, so its definition cannot be located. " +
          "The run is left exactly as it is.",
      ),
    );
  }
  const record = Object.fromEntries(Object.entries(metadata));
  if (record.kind !== RETRIEVAL_KIND || typeof record.checkout !== "string") {
    return Err(
      unavailable(
        "this run's retrieval metadata does not describe a local checkout this host can " +
          "reach. The run is left exactly as it is.",
      ),
    );
  }
  return Ok(record.checkout);
}

/**
 * Load the exact object a retained run's definition names.
 *
 * It never substitutes the current `HEAD` or a same-named file in the working
 * tree. A resume that could do either would silently continue a different
 * document under the same run id.
 */
export function* loadRetainedDefinition(
  definition: WorkflowDefinition,
  metadata: Json | undefined,
): Operation<Result<string>> {
  const checkout = parseRetrieval(metadata);
  if (!checkout.ok) {
    return checkout;
  }

  try {
    return yield* inRepository(checkout.value, function* (): Operation<Result<string>> {
      const root = yield* repositoryRoot();
      if (resolve(root) !== resolve(checkout.value)) {
        return Err(
          unavailable(
            "the checkout this run retains is no longer the root of the repository it names. " +
              "The run is left exactly as it is.",
          ),
        );
      }
      const format = yield* gitObjectFormat();
      if (format !== definition.objectFormat) {
        return Err(
          unavailable(
            "the retained checkout names its objects with a different format than this run's " +
              "definition. The run is left exactly as it is.",
          ),
        );
      }
      return Ok(yield* readGitObject(definition.objectId, definition.rootDocumentPath));
    });
  } catch (error) {
    return Err(
      unavailable(
        "this run's retained definition could not be loaded: " +
          (error instanceof Error ? error.message : String(error)),
        error,
      ),
    );
  }
}

/** Whether this definition names a document this slice can execute. */
export function supportedRootDocument(definition: GitWorkflowDefinitionV1): Result<void> {
  if (definition.rootDocumentPath.endsWith(".md")) {
    return Ok(undefined);
  }
  return Err(
    unavailable(
      "xmd workflow runs Markdown definitions. A function-component root is not supported yet.",
    ),
  );
}
