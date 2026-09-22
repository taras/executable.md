/**
 * What a workflow run is a run of, established from the bytes the caller named.
 *
 * `xmd workflow start notes.md` names a file, and that file's current bytes are
 * what the run is of. They are read once, hashed, and retained with the run
 * before it becomes durable — so a file outside a repository, an untracked
 * file, and a file edited since its last commit all start, and all start from
 * what they actually say.
 *
 * **Where the file is has nothing to do with what the run is.** The containing
 * directory, the absolute path and the invocation working directory are all
 * retrieval facts; what the descriptor holds is a portable logical path — the
 * file's own final segment for the root, and each declared component's
 * canonical path relative to it. Two machines holding the same bytes under the
 * same logical entrypoint hold the same definition.
 *
 * Git is optional provenance and never identity. A run records where it was
 * started from when that is cheaply available, as replaceable metadata; failing
 * to learn it does not fail a start, and nothing ever reads it back to find the
 * source. The source is in the run.
 *
 * ## The legacy path
 *
 * Version-1 runs still exist, and their Markdown still lives in a repository.
 * `loadRetainedDefinition()` is what reaches it, and it is used from exactly one
 * place: the adapter this host hands the Workflow lifecycle as its legacy
 * source reader. Nothing establishes a version-1 definition any more.
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Err, Ok, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import {
  asDocumentTargetError,
  fileSource,
  inspectDocument,
  parseMarkdownDefinition,
  retainedSource,
} from "@executablemd/core";
import type { DocumentInfo, FileRootDocument } from "@executablemd/core";
import type { WorkflowBundleComponent } from "@executablemd/core/host";
import {
  decodeSourceText,
  definitionComponents,
  parseSourceBundleDefinition,
  sourceBundleHash,
  sourceContentHash,
} from "@executablemd/workflow";
import { gitObjectFormat, gitRoot, readGitObject, resolveGitRevision } from "@executablemd/git/api";
import type {
  GitWorkflowDefinitionV1,
  SourceBundleEntryV2,
  SourceBundleSnapshotEntryV2,
  SourceBundleWorkflowDefinitionV2,
} from "@executablemd/workflow";
import { declaredBundle, readBundle, reconstructBundle } from "./workflow-bundle.ts";

/** How this host recorded where a run was started from. Never read back. */
export const RETRIEVAL_KIND = "local-checkout";

/** Everything one `start` establishes before a run can exist. */
export interface EstablishedDefinition {
  readonly definition: SourceBundleWorkflowDefinitionV2;
  /**
   * The exact bytes behind every logical path, in the descriptor's own order.
   *
   * Owned copies from the one read of each file. They travel to the lifecycle
   * transition, which copies them again before it validates — so nothing
   * between here and storage can change what the run is of.
   */
  readonly sourceSnapshot: readonly SourceBundleSnapshotEntryV2[];
  /** Credential-free provenance, when it was cheaply available. */
  readonly retrieval?: Json;
  /** The entrypoint as text, for the caller that is about to import it. */
  readonly source: string;
  /** The execution view of the declared bundle, empty when none is declared. */
  readonly components: readonly WorkflowBundleComponent[];
}

/** The sources one execution runs: the root, and the bundle it is closed over. */
export interface RetainedSources {
  readonly source: string;
  readonly components: readonly WorkflowBundleComponent[];
}

/** A definition that cannot be established, or a retained one that cannot be loaded. */
export class WorkflowDefinitionUnavailableError extends Error {
  override name = "WorkflowDefinitionUnavailableError";
}

function unavailable(message: string, cause?: unknown): WorkflowDefinitionUnavailableError {
  return new WorkflowDefinitionUnavailableError(message, cause === undefined ? {} : { cause });
}

/**
 * One file's exact bytes.
 *
 * `@effectionx/fs` reads text and this needs bytes, so the runtime's own
 * asynchronous primitive is adapted as an operation. Never synchronous: a read
 * that blocked the host would stall every other operation in the scope.
 */
function* readBytes(path: string): Operation<Uint8Array> {
  return new Uint8Array(yield* until(readFile(path)));
}

/**
 * Run `body` with a directory as the contextual working directory.
 *
 * Git answers about the directory it is asked in, so every question about one
 * repository is asked from the same place rather than from wherever the process
 * started.
 */
function inDirectory<T>(directory: string, body: () => Operation<T>): Operation<T> {
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
 * Establish the immutable definition of a run that is starting.
 *
 * The argument is a document reference, not a path: `notes.md#Release/Publish`
 * names one section of one file, and a filename that really holds a `#` writes
 * it `%23`. The reference is taken apart first, because resolving the whole
 * argument as a path would address a file nobody has.
 *
 * Every phase happens before storage exists: the reference is parsed, the file
 * read once, its logical entrypoint derived from its own final segment, its
 * bytes decoded strictly and parsed, any selector resolved against those exact
 * bytes to the one canonical target core produces, the declared bundle resolved
 * against the file's own directory and read, and the descriptor built and
 * verified. A file this command cannot read, cannot decode, cannot parse, whose
 * selector resolves to nothing, or that declares a component it cannot read, is
 * refused here — with no run, no id and nothing on disk.
 */
export function* establishDefinition(reference: string): Operation<Result<EstablishedDefinition>> {
  let requested: FileRootDocument;
  try {
    requested = fileSource(reference);
  } catch (error) {
    return Err(
      unavailable(
        "the workflow definition reference could not be read. A reference is a document path, " +
          "optionally followed by # and one target selector; write a literal # in a filename " +
          "as %23.",
        error,
      ),
    );
  }

  const documentPath = requested.path;
  const absolute = resolve(documentPath);
  const directory = dirname(absolute);

  // The logical entrypoint is the file's own name, normalized. Where it sits is
  // this machine's arrangement; what it is called is the run's.
  const entrypoint = basename(absolute).normalize("NFC");

  let bytes: Uint8Array;
  try {
    bytes = yield* readBytes(absolute);
  } catch (error) {
    return Err(
      unavailable(
        `the workflow definition could not be read from ${documentPath}: ` + describeCause(error),
        error,
      ),
    );
  }

  const text = decodeSourceText(bytes);
  if (!text.ok) {
    return Err(
      unavailable(
        `the workflow definition at ${documentPath} is not well-formed UTF-8, so it is not a ` +
          "Markdown document this command can run.",
      ),
    );
  }

  let meta: Record<string, unknown>;
  try {
    meta = (yield* parseMarkdownDefinition("__root__", entrypoint, text.value)).meta;
  } catch (error) {
    return Err(
      unavailable(
        `the workflow definition at ${documentPath} is not a Markdown document this version ` +
          "can read: " +
          describeCause(error),
        error,
      ),
    );
  }

  // Resolved against the bytes that are about to be retained, by core, once.
  // What the descriptor keeps is the exact canonical target core produced —
  // never the selector the caller wrote, which a later resolution against
  // other bytes could answer differently.
  const targetPath = yield* resolveTarget(entrypoint, text.value, requested.target);
  if (!targetPath.ok) {
    return targetPath;
  }

  // The bundle is resolved against the root's own directory and read before the
  // run exists: a declaration this command cannot read, or a component that is
  // not there, refuses the start rather than being discovered the first time a
  // document writes the name.
  const declared = declaredBundle(meta, entrypoint);
  if (!declared.ok) {
    return declared;
  }
  const bundle = yield* readBundle(directory, declared.value);
  if (!bundle.ok) {
    return bundle;
  }

  const built = yield* buildSourceBundle(entrypoint, bytes, bundle.value, targetPath.value);
  if (!built.ok) {
    return built;
  }

  return Ok({
    definition: built.value.definition,
    sourceSnapshot: built.value.sourceSnapshot,
    ...withProvenance(yield* provenance(directory)),
    source: text.value,
    components: bundle.value.map((component) => ({
      name: component.name,
      path: component.path,
      sourceHash: component.sourceHash,
      content: component.content,
    })),
  });
}

/** Written only when there is some: an absent locator is an absent member. */
function withProvenance(retrieval: Json | undefined): { retrieval?: Json } {
  return retrieval === undefined ? {} : { retrieval };
}

/** What one established candidate is, descriptor and bytes together. */
interface BuiltBundle {
  readonly definition: SourceBundleWorkflowDefinitionV2;
  readonly sourceSnapshot: readonly SourceBundleSnapshotEntryV2[];
}

/**
 * The one exact target a selector names in these bytes, or none.
 *
 * Core resolves it, because what counts as a target is core's decision and a
 * rule restated here could disagree with the one the document layer applies.
 * The answer is the canonical target, never the glob or alias that asked for
 * it: two spellings of one request are one run, and a glob re-resolved against
 * different bytes would name a different section.
 */
function* resolveTarget(
  entrypoint: string,
  source: string,
  selector: string | undefined,
): Operation<Result<string | undefined>> {
  if (selector === undefined) {
    return Ok(undefined);
  }
  let described: DocumentInfo;
  try {
    described = yield* inspectDocument(retainedSource(entrypoint, source, { target: selector }));
  } catch (error) {
    const failure = asDocumentTargetError(error);
    return Err(
      unavailable(
        failure === undefined
          ? "the workflow definition's target could not be resolved: " + describeCause(error)
          : failure.message,
        error,
      ),
    );
  }
  if (described.target === undefined) {
    return Err(
      unavailable(
        "the workflow definition's target selector resolved to no section of the document.",
      ),
    );
  }
  return Ok(described.target);
}

/**
 * The canonical descriptor these bytes produce, and the snapshot beside it.
 *
 * The manifest is sorted by the UTF-8 bytes of each logical path, because that
 * is the order the descriptor is canonical in — and the snapshot is built in
 * the same order, because the transition requires exactly the descriptor's
 * paths in exactly its order.
 *
 * The target is outside the bundle hash and inside the descriptor: selecting a
 * section does not change the bytes, and a run of one section is still not a
 * run of the whole document.
 */
function* buildSourceBundle(
  entrypoint: string,
  root: Uint8Array,
  components: readonly EstablishedComponent[],
  targetPath: string | undefined,
): Operation<Result<BuiltBundle>> {
  const byPath = new Map<string, Uint8Array>([[entrypoint, root]]);
  for (const component of components) {
    const existing = byPath.get(component.path);
    if (existing === undefined) {
      byPath.set(component.path, component.bytes);
      continue;
    }
    // One logical path, one source. A component declared at the entrypoint's
    // own path is the root, and two declarations of one path are one entry.
    if (!sameBytes(existing, component.bytes)) {
      return Err(
        unavailable(
          `the component "${component.name}" and another source both claim the logical path ` +
            `${component.path} with different content.`,
        ),
      );
    }
  }

  const ordered = [...byPath.keys()].sort(compareUtf8);
  const sources: SourceBundleEntryV2[] = [];
  const sourceSnapshot: SourceBundleSnapshotEntryV2[] = [];
  for (const path of ordered) {
    const bytes = byPath.get(path);
    if (bytes === undefined) {
      return Err(unavailable("a source this command read is no longer in hand"));
    }
    sources.push({
      path,
      sourceHash: yield* sourceContentHash(bytes),
      byteLength: bytes.byteLength,
    });
    sourceSnapshot.push({ path, bytes: Uint8Array.from(bytes) });
  }

  const mapping = [...components]
    .map((component) => ({ name: component.name, path: component.path }))
    .sort((left, right) => compareUtf8(left.name, right.name));

  const bundleHash = yield* sourceBundleHash({
    entrypoint,
    sources,
    ...(mapping.length === 0 ? {} : { components: mapping }),
  });

  // Parsed rather than assembled: the descriptor this command hands to storage
  // goes through the same closed parser storage reads one back through, so a
  // candidate that is not canonical is refused here rather than retained.
  const definition = parseSourceBundleDefinition({
    version: 2,
    kind: "source-bundle",
    hashAlgorithm: "sha256",
    bundleHash,
    entrypoint,
    sources,
    ...(targetPath === undefined ? {} : { targetPath }),
    ...(mapping.length === 0 ? {} : { components: mapping }),
  });
  if (!definition.ok) {
    return definition;
  }
  return Ok({ definition: definition.value, sourceSnapshot: Object.freeze(sourceSnapshot) });
}

/** One declared component, read and parsed, with the bytes behind it. */
export interface EstablishedComponent {
  readonly name: string;
  readonly path: string;
  readonly sourceHash: string;
  readonly content: string;
  readonly bytes: Uint8Array;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, at) => byte === right[at]);
}

const encoder = new TextEncoder();

/** Two strings in the UTF-8 byte order a source bundle is canonical in. */
function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index++) {
    const one = a[index];
    const other = b[index];
    if (one !== other && one !== undefined && other !== undefined) {
      return one < other ? -1 : 1;
    }
  }
  if (a.length === b.length) {
    return 0;
  }
  return a.length < b.length ? -1 : 1;
}

/**
 * Where this run was started from, when that is cheap to learn.
 *
 * Provenance and nothing more: it is credential-free, excluded from identity
 * and from compatible reuse, and never read back to find the source. A
 * directory that is not a working tree simply has none, and a start there is an
 * ordinary start — which is the whole point of the version.
 */
function* provenance(directory: string): Operation<Json | undefined> {
  try {
    return yield* inDirectory(directory, function* (): Operation<Json | undefined> {
      const checkout = yield* gitRoot();
      const objectFormat = yield* gitObjectFormat();
      const commit = yield* resolveGitRevision("HEAD^{commit}");
      return {
        version: 1,
        kind: RETRIEVAL_KIND,
        checkout,
        objectFormat,
        commit: commit.toLowerCase(),
      };
    });
  } catch {
    // Not a repository, no commits yet, or Git is not installed. None of those
    // is a reason a run cannot start: the bytes are already in hand.
    return undefined;
  }
}

function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The checkout a retained version-1 locator names, reauthorized before use.
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
 * Load the exact object a retained version-1 definition names.
 *
 * It never substitutes the current `HEAD` or a same-named file in the working
 * tree. A resume that could do either would silently continue a different
 * document under the same run id.
 *
 * Reached from one place only: the legacy source reader this host supplies to
 * the Workflow lifecycle. Nothing else in the CLI loads a definition — a
 * version-2 run's source comes out of the run.
 */
export function* loadRetainedDefinition(
  definition: GitWorkflowDefinitionV1,
  metadata: Json | undefined,
): Operation<Result<RetainedSources>> {
  const checkout = parseRetrieval(metadata);
  if (!checkout.ok) {
    return checkout;
  }

  try {
    return yield* inDirectory(checkout.value, function* (): Operation<Result<RetainedSources>> {
      const root = yield* gitRoot();
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
      const source = yield* readGitObject(definition.objectId, definition.rootDocumentPath);
      // Every retained component, from the retained commit, verified against
      // the hash the definition holds. The working tree is never consulted, so
      // a checkout edited since the run started continues the run it started.
      const retained = definitionComponents(definition);
      const components =
        retained.length === 0
          ? Ok([])
          : yield* reconstructBundle(definition.objectId, retained, format);
      if (!components.ok) {
        return components;
      }
      return Ok({ source, components: components.value });
    });
  } catch (error) {
    return Err(
      unavailable(
        "this run's retained definition could not be loaded: " + describeCause(error),
        error,
      ),
    );
  }
}
