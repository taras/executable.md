/**
 * The operations an admitted fragment actually performs, and nothing else it
 * could reach.
 *
 * An admitted `<File />` used to be core's ordinary `<File>` component, which
 * resolves its provider through `API.Files` at the moment it runs. That made
 * the authority a generated fragment exercises a property of whatever the
 * document, a repository component or middleware had installed by then — so a
 * fragment admitted for "read a file" reached whichever Files provider was
 * nearest, and a handler composed around one could observe, rewrite or answer
 * the call.
 *
 * The operations here are the alternative. A trusted host hands its private
 * provider to `captureEvaluationProfile()`, which reads each method off it
 * exactly once and closes a fragment-facing component over the bound result.
 * What runs inside a fragment therefore reaches:
 *
 * - only the methods this file names — read, search, path check, write, delete
 *   and directory creation, plus one Fetch — and not the rest of the host's
 *   provider, not `API.Files`, not `API.Fetch`, and not `API.Env`;
 * - only the working directory the host stated when it built the profile; and
 * - only for as long as the execution that captured them is alive.
 *
 * ## Why the components are core's own
 *
 * A host cannot supply the body, because a body is where a provider lookup
 * would go. These are written once, here, against the bound operations, and a
 * host chooses only *which* of them a fragment may name and under what
 * identity. That is also why the schemas match the ordinary components': a
 * fragment written against `<File path="…">` is the same text an author would
 * write, and only the authority behind it differs.
 *
 * ## What is deliberately absent
 *
 * No temporary directory, no environment, no process, no elicitation and no
 * agent. Those are operations the ordinary components have and an admitted
 * fragment does not, and leaving them out here is what makes that true rather
 * than a claim about what a host will remember not to admit.
 */

import type { Operation, Result } from "effection";

import type { FunctionComponentDefinition, Json, PropsSchema, ReturnsSchema } from "./types.ts";
import { content } from "./component-api.ts";
import { ContentError, ProjectedContentError } from "./errors.ts";
import { getExpansion } from "./expansion.ts";
import { persistFetch } from "./fetch-journal.ts";
import { parseResponseRecord } from "./fetch-response.ts";
import type { FetchResponseRecord } from "./fetch-response.ts";
import { GLOB_PROPS, GLOB_RETURNS, globFailure, globPatterns } from "./glob-source.ts";
import { formDispatcher } from "./invocation-identity.ts";
import { parseFilesFailure } from "@executablemd/runtime";

/** A refusal an admitted fragment's own operation produced. */
export class FragmentCapabilityError extends Error {
  override name = "FragmentCapabilityError";
}

/** What a fragment operation reached after its execution had ended. */
export const REVOKED_CAPABILITY =
  "an admitted fragment reached an operation belonging to an execution that has ended.";

/** One path an operation is about to act on, resolved against the stated root. */
export interface FragmentPath {
  readonly cwd: string;
  readonly path: string;
}

/** One write an operation is about to perform. */
export interface FragmentWrite extends FragmentPath {
  readonly content: string;
}

/**
 * One search an operation is about to perform, under the stated root.
 *
 * The patterns rather than a resolved list, because the provider owns matching:
 * what an admitted fragment states is the same two prop values an author writes,
 * already held to the shared source rules, and the search that answers them is
 * the host's.
 */
export interface FragmentSearch {
  readonly cwd: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/**
 * The exact filesystem operations a fragment may perform.
 *
 * A strict subset of what a host's own provider offers, listed rather than
 * derived: a fragment provider built by widening `FilesHandler` would gain
 * every operation a later release adds to it, which is the opposite of what a
 * ceiling is for.
 *
 * `Result` rather than a throw, matching the provider contract the host already
 * implements, so a host passes its own methods without adapting them.
 */
export interface FragmentFileAccess {
  /** Whether this path is admissible at all. No filesystem access. */
  checkFilePath(input: FragmentPath): Operation<Result<void>>;
  readTextFile(input: FragmentPath): Operation<Result<string>>;
  /** Sorted, deduplicated, POSIX-separated paths of the regular files that match. */
  globFiles(input: FragmentSearch): Operation<Result<string[]>>;
  writeTextFile(input: FragmentWrite): Operation<Result<unknown>>;
  deleteFile(input: FragmentPath): Operation<Result<void>>;
  ensureDirectory(input: FragmentPath): Operation<Result<void>>;
  /**
   * The directory every path above resolves against.
   *
   * An operation rather than a value, because a workflow run's authoritative
   * root advances as the run commits, and a fragment admitted later addresses
   * the root the run is on rather than the one it started from.
   */
  workingDirectory(): Operation<string>;
}

/**
 * The exact HTTP read a fragment may perform.
 *
 * It answers with the same record the ordinary `<Fetch>` retains — status,
 * headers and body — because that is what a document binds and what a
 * continuation restores. A transport that answered with the body alone would
 * make a fragment's observation a different shape from an authored one, and a
 * document that branches on a 404 could not.
 */
export interface FragmentFetchAccess {
  fetch(request: {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly timeout?: number;
  }): Operation<FetchResponseRecord>;
}

/**
 * Where a fragment's relative paths resolve, while it is running.
 *
 * A directory component scopes its content — `<Dir path="nested">` makes the
 * `out.md` inside it mean `nested/out.md` — and the ordinary component does that
 * by installing a working directory on the contextual environment. A fragment
 * cannot: the contextual environment is exactly what a document, a repository
 * component or middleware can answer, and a fragment whose destination could be
 * moved from outside would be a fragment admitted for one path and performing
 * another.
 *
 * So the cursor is the evaluation's own. It is created per capture, reset at the
 * start of each fragment, and saved and restored around a directory's content by
 * the body that scoped it. Nothing outside this module holds a reference.
 */
interface DirectoryCursor {
  current: string;
}

/** Every live operation one captured profile holds, read once and revocable. */
export interface CapturedCapabilities {
  readonly files?: FragmentFileAccess;
  readonly fetch?: FragmentFetchAccess;
  /** Where this evaluation's relative paths currently resolve. Module-private. */
  readonly cursor: DirectoryCursor;
  /**
   * Begin one fragment, and answer with how to end it.
   *
   * Reads the host's working directory once, here, rather than once per
   * element: every path in one fragment resolves against the directory the run
   * was in when that fragment was admitted. The returned operation restores
   * whatever was current before, so a fragment produced inside another
   * fragment's producer leaves the outer one where it was.
   */
  enterFragment(): Operation<() => void>;
  /** Whether the execution that captured these is still running. */
  live(): boolean;
  /** Called at execution teardown. Every bound operation refuses afterwards. */
  revoke(): void;
}

/**
 * Read each method off the host's objects once, and hand back bound copies.
 *
 * Bound, so replacing a method on the object the host passed after installation
 * reaches nothing. Behind a revocation this execution owns, so an operation
 * retained past teardown refuses rather than acting on a filesystem the run no
 * longer has a transaction for.
 */
export function captureCapabilities(input: {
  readonly files?: FragmentFileAccess;
  readonly fetch?: FragmentFetchAccess;
}): CapturedCapabilities {
  let alive = true;
  const live = () => alive;
  const guard = <A, R>(operation: (argument: A) => Operation<R>) =>
    function* (argument: A): Operation<R> {
      if (!alive) {
        throw new FragmentCapabilityError(REVOKED_CAPABILITY);
      }
      return yield* operation(argument);
    };

  const files = input.files;
  const fetching = input.fetch;
  const directory = files?.workingDirectory.bind(files);
  const cursor: DirectoryCursor = { current: "" };
  return Object.freeze({
    cursor,
    *enterFragment(): Operation<() => void> {
      if (!alive) {
        throw new FragmentCapabilityError(REVOKED_CAPABILITY);
      }
      const enclosing = cursor.current;
      cursor.current = directory === undefined ? "" : yield* directory();
      return () => {
        cursor.current = enclosing;
      };
    },
    ...(files === undefined
      ? {}
      : {
          files: Object.freeze({
            checkFilePath: guard(files.checkFilePath.bind(files)),
            readTextFile: guard(files.readTextFile.bind(files)),
            globFiles: guard(files.globFiles.bind(files)),
            writeTextFile: guard(files.writeTextFile.bind(files)),
            deleteFile: guard(files.deleteFile.bind(files)),
            ensureDirectory: guard(files.ensureDirectory.bind(files)),
            *workingDirectory(): Operation<string> {
              if (!alive || directory === undefined) {
                throw new FragmentCapabilityError(REVOKED_CAPABILITY);
              }
              return yield* directory();
            },
          }),
        }),
    ...(fetching === undefined
      ? {}
      : { fetch: Object.freeze({ fetch: guard(fetching.fetch.bind(fetching)) }) }),
    live,
    revoke: () => {
      alive = false;
    },
  });
}

/** The one path prop the file components take, matching the ordinary schema. */
const PATH_PROPS: PropsSchema = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};

/** The props the fetch component takes, matching the ordinary schema. */
const FETCH_PROPS: PropsSchema = {
  type: "object",
  properties: {
    url: { type: "string" },
    method: { type: "string" },
    headers: { type: "object" },
    timeout: { type: "string" },
  },
  required: ["url"],
  additionalProperties: false,
};

/** The schema each capability's component declares. */
export function capabilityProps(capability: FragmentCapability): PropsSchema {
  if (capability === "fetch") {
    return FETCH_PROPS;
  }
  // The ordinary component's own schema, not a copy of it: a fragment writes
  // the same element an author does.
  return capability === "files:glob" ? GLOB_PROPS : PATH_PROPS;
}

/**
 * What a capability binds, for the ones that bind a value rather than render.
 *
 * Declaring it is what makes the admitted component a value component, exactly
 * as it does for the ordinary one: the engine requires `as`, renders nothing,
 * and validates what comes back. So a generated `<Glob />` written without a
 * capture is refused for the ordinary reason, before the host's provider is
 * asked to traverse anything.
 */
export function capabilityReturns(capability: FragmentCapability): ReturnsSchema | undefined {
  return capability === "files:glob" ? GLOB_RETURNS : undefined;
}

/** Which captured operation one admitted entry runs. */
export type FragmentCapability =
  | "file:read"
  | "files:glob"
  | "file:write"
  | "file:delete"
  | "directory:ensure"
  | "fetch";

/** The authored forms each capability is written in. */
export const CAPABILITY_FORMS: Readonly<
  Record<FragmentCapability, readonly ("self-closing" | "paired")[]>
> = Object.freeze({
  "file:read": ["self-closing"],
  "files:glob": ["self-closing"],
  "file:write": ["paired"],
  "file:delete": ["self-closing"],
  "directory:ensure": ["paired"],
  fetch: ["self-closing"],
});

/**
 * The component one capability runs, closed over the bound operations.
 *
 * Built once per capture rather than per invocation, so every element in every
 * fragment of one execution runs the same definition — which is also what lets
 * two entries under one name reach one definition, as `<File />` and
 * `<File>…</File>` do.
 */
export function capabilityDefinition(
  name: string,
  admitted: {
    readonly "self-closing"?: FragmentCapability;
    readonly paired?: FragmentCapability;
  },
  capabilities: CapturedCapabilities,
  requests: readonly {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly timeout?: number;
  }[] = [],
): FunctionComponentDefinition {
  const selfClosing = admitted["self-closing"];
  const paired = admitted.paired;
  // The schema is the union of what each spelling takes, which for every pair
  // core supplies is one schema anyway: `<File />` and `<File>…</File>` both
  // take one `path`.
  const props = capabilityProps(selfClosing ?? paired ?? "file:read");
  // One name binds one way. Two spellings that returned different shapes would
  // be one component whose `as` meant two things, decided by how the element
  // happened to be written, so the disagreement is refused here rather than
  // resolved by whichever spelling was consulted first.
  const returning = boundResult(name, selfClosing, paired);

  const read =
    selfClosing === undefined ? undefined : body(name, selfClosing, capabilities, requests);
  const write = paired === undefined ? undefined : body(name, paired, capabilities, requests);

  // One name, one definition — even when it holds two identities in two
  // classes. `<File />` observes and `<File>…</File>` writes, and the evaluator
  // resolves an import by name, so the two must arrive as one definition whose
  // *dispatch* separates them. Two definitions would be one name with two
  // answers, which it refuses; one undispatched body would let a read reach the
  // write path.
  if (read !== undefined && write !== undefined) {
    return {
      kind: "function",
      name,
      props,
      forms: ["self-closing", "paired"],
      ...(returning === undefined ? {} : { returns: returning }),
      fn: formDispatcher({ forms: "both", "self-closing": read, paired: write }),
    };
  }
  if (read !== undefined) {
    return {
      kind: "function",
      name,
      props,
      forms: ["self-closing"],
      ...(returning === undefined ? {} : { returns: returning }),
      fn: formDispatcher({
        forms: "self-closing",
        fn: read,
        refuse: () =>
          new FragmentCapabilityError(
            `<${name} /> reads and renders no content of its own, so it is written self-closing.`,
          ),
      }),
    };
  }
  if (write !== undefined) {
    return {
      kind: "function",
      name,
      props,
      forms: ["paired"],
      ...(returning === undefined ? {} : { returns: returning }),
      fn: formDispatcher({
        forms: "paired",
        fn: write,
        refuse: () =>
          new FragmentCapabilityError(
            `<${name} /> writes what it renders, so it is written with content rather than ` +
              "self-closing.",
          ),
      }),
    };
  }
  throw new FragmentCapabilityError(`an evaluation profile admitted "${name}" for no form.`);
}

/** What one name binds, when every capability it holds binds the same thing. */
function boundResult(
  name: string,
  selfClosing: FragmentCapability | undefined,
  paired: FragmentCapability | undefined,
): ReturnsSchema | undefined {
  const stated = [selfClosing, paired]
    .filter((capability): capability is FragmentCapability => capability !== undefined)
    .map(capabilityReturns);
  const distinct = new Set(stated.map((schema) => JSON.stringify(schema ?? null)));
  if (distinct.size > 1) {
    throw new FragmentCapabilityError(
      `an evaluation profile admitted "${name}" for two spellings that bind different results. ` +
        "One name binds one way, so which of them `as` meant would depend on how the element " +
        "was written.",
    );
  }
  return stated[0];
}

/** The body one capability runs, closed over the operations this capture bound. */
function body(
  name: string,
  capability: FragmentCapability,
  capabilities: CapturedCapabilities,
  requests: readonly {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly timeout?: number;
  }[],
) {
  if (capability === "fetch") {
    return fetchBody(capabilities, requests);
  }
  const files = capabilities.files;
  if (files === undefined) {
    throw new FragmentCapabilityError(
      `an evaluation profile admitted "${name}" without stating the filesystem operations it runs.`,
    );
  }
  const cursor = capabilities.cursor;
  if (capability === "file:read") {
    return readBody(files, cursor);
  }
  if (capability === "files:glob") {
    return globBody(files, cursor);
  }
  if (capability === "file:delete") {
    return deleteBody(files, cursor);
  }
  return capability === "file:write" ? writeBody(files, cursor) : ensureBody(files, cursor);
}

function readBody(files: FragmentFileAccess, cursor: DirectoryCursor) {
  return function* read(props: Record<string, Json>): Operation<string> {
    const requested = String(props.path);
    const text = yield* files.readTextFile({ cwd: cursor.current, path: requested });
    if (!text.ok) {
      throw new FragmentCapabilityError(refusal(requested, "read"));
    }
    return text.value;
  };
}

/**
 * The search body, held to the same source rules the ordinary `<Glob>` is.
 *
 * The patterns are checked before the provider is asked, so a pattern that
 * cannot match anything is a refusal rather than an empty result, and a fragment
 * whose text is wrong performs no traversal at all. The sentences come from
 * `glob-source.ts`, so an author and a generated fragment are told the same
 * thing about the same pattern — and a provider's own diagnostic never reaches
 * either, because the failure is normalized from the parsed failure data rather
 * than from its message.
 */
function globBody(files: FragmentFileAccess, cursor: DirectoryCursor) {
  return function* search(props: Record<string, Json>): Operation<string[]> {
    const include = globPatterns("include", props.include);
    if (!include.ok) {
      throw new FragmentCapabilityError(include.error.message);
    }
    const exclude = globPatterns("exclude", props.exclude);
    if (!exclude.ok) {
      throw new FragmentCapabilityError(exclude.error.message);
    }
    const found = yield* files.globFiles({
      cwd: cursor.current,
      include: include.value,
      exclude: exclude.value,
    });
    if (!found.ok) {
      throw new FragmentCapabilityError(
        globFailure(parseFilesFailure(found.error), [...include.value, ...exclude.value]),
      );
    }
    return found.value;
  };
}

function deleteBody(files: FragmentFileAccess, cursor: DirectoryCursor) {
  return function* remove(props: Record<string, Json>): Operation<string> {
    const requested = String(props.path);
    const removed = yield* files.deleteFile({ cwd: cursor.current, path: requested });
    if (!removed.ok) {
      throw new FragmentCapabilityError(refusal(requested, "delete"));
    }
    return "";
  };
}

function writeBody(files: FragmentFileAccess, cursor: DirectoryCursor) {
  return function* write(props: Record<string, Json>): Operation<string> {
    const requested = String(props.path);
    const cwd = cursor.current;
    // The path is admitted before the content is produced, so a fragment whose
    // destination is refused renders nothing at all.
    const admitted = yield* files.checkFilePath({ cwd, path: requested });
    if (!admitted.ok) {
      throw new FragmentCapabilityError(refusal(requested, "write"));
    }
    const text = yield* rendered(requested);
    // Resolved against the directory this element was written in, captured
    // before its content ran: a directory the content itself scoped must not
    // move where this write lands.
    const written = yield* files.writeTextFile({ cwd, path: requested, content: text });
    if (!written.ok) {
      throw new FragmentCapabilityError(refusal(requested, "write"));
    }
    return "";
  };
}

function ensureBody(files: FragmentFileAccess, cursor: DirectoryCursor) {
  return function* ensure(props: Record<string, Json>): Operation<string> {
    const requested = String(props.path);
    const enclosing = cursor.current;
    // The directory exists before its content runs: content that ran in a
    // directory the ensure was going to refuse would be content run somewhere
    // nobody chose.
    const made = yield* files.ensureDirectory({ cwd: enclosing, path: requested });
    if (!made.ok) {
      throw new FragmentCapabilityError(refusal(requested, "create"));
    }
    // And it scopes what it renders, which is what makes `<File path="out.md">`
    // inside it mean this directory's `out.md`. Scoped through the evaluation's
    // own cursor rather than the contextual environment, so nothing outside the
    // fragment can move where its content writes.
    cursor.current = resolve(enclosing, requested);
    try {
      return yield* rendered(requested);
    } finally {
      cursor.current = enclosing;
    }
  };
}

/**
 * One authored path against the directory it was written in.
 *
 * An absolute path is used as written — a workflow run's logical root is one —
 * and anything else is joined, which is what nesting means.
 */
function resolve(enclosing: string, path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  const base = enclosing.endsWith("/") ? enclosing.slice(0, -1) : enclosing;
  return `${base}/${path}`;
}

function fetchBody(
  capabilities: CapturedCapabilities,
  requests: readonly {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly timeout?: number;
  }[],
) {
  return function* perform(props: Record<string, Json>): Operation<Json> {
    const fetching = capabilities.fetch;
    if (fetching === undefined) {
      throw new FragmentCapabilityError(
        "an admitted fragment asked for a request, and this host stated no transport for one.",
      );
    }
    // Preflight already compared this element against the ceiling, from the
    // scan, before the fragment's first effect. This finds the admitted request
    // it matched and performs *that* — never the props, which would let a
    // header the ceiling normalized away travel anyway.
    const url = String(props.url);
    const admitted = requests.find((request) => request.url === url);
    if (admitted === undefined) {
      throw new FragmentCapabilityError(
        "an admitted fragment asked for a request this host did not admit.",
      );
    }
    // Journaled on exactly the terms an authored `<Fetch>` is, through the same
    // module: one element is one durable request, and a continuation restores
    // what came back rather than asking again.
    const expansion = yield* getExpansion();
    const retained = yield* persistFetch(
      {
        id: expansion.id,
        ...(expansion.position === undefined ? {} : { position: expansion.position }),
      },
      admitted,
      () => fetching.fetch(admitted),
    );
    // The status rule is the authored one: a fragment binds nothing, so a
    // response it cannot branch on must not be handed back as though it were
    // an answer.
    const response = parseResponseRecord(retained);
    if (response.status < 200 || response.status > 299) {
      throw new FragmentCapabilityError(
        `an admitted fragment's request answered with status ${response.status}.`,
      );
    }
    return retained;
  };
}

/**
 * A refusal that names the path and the direction, and nothing else.
 *
 * The provider's own reason is deliberately dropped. A generated fragment's
 * failure is serialized into the journal with its message, and a host provider's
 * diagnostic can carry an absolute path, a root identifier or a transaction
 * detail that the run has no business publishing on behalf of text nobody
 * audited.
 */
function refusal(path: string, verb: string): string {
  return `an admitted fragment could not ${verb} ${JSON.stringify(path)}.`;
}

/**
 * The rendered children, or a failure instead of a partial write.
 *
 * `content()` is a failure boundary, and for a component that *writes* what it
 * rendered, embedding a printed error in the destination would be worse than
 * useless. So this recovers from the boundary and fails the invocation: nothing
 * reaches the provider, and the target keeps whatever it already held.
 */
function* rendered(path: string): Operation<string> {
  try {
    return yield* content();
  } catch (error) {
    if (error instanceof ContentError || error instanceof ProjectedContentError) {
      throw new FragmentCapabilityError(
        `an admitted fragment's content for ${JSON.stringify(path)} failed to render, so nothing ` +
          "was written.",
        { cause: error },
      );
    }
    throw error;
  }
}
