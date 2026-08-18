/**
 * The components a workflow root is closed over, established from Git.
 *
 * A workflow root may declare a fixed bundle of authored Markdown components in
 * its own frontmatter:
 *
 * ```yaml
 * workflow:
 *   components:
 *     Discovery: ./Discovery.md
 *     Planning: ./Planning.md
 * ```
 *
 * The declaration is authored beside the root and read from the same pinned
 * commit the root came from, so the whole procedure — root and components — is
 * one immutable object graph. A working tree with uncommitted edits runs the
 * committed components for exactly the reason it runs the committed root: a
 * record that named a commit while executing something else would be a claim
 * about something that never happened.
 *
 * What each declaration produces is two views of one bundle. The **identity**
 * view is what the workflow definition retains: name, canonical
 * repository-relative path, and the blob's own object id. The **execution**
 * view is the same entries plus the exact source read from the commit, which is
 * what canonical core resolves the names against. Because the hash is
 * identity, changing what a component says changes the definition rather than
 * changing what a retained definition executes.
 *
 * Everything here goes through the contextual `Git` capability and the
 * engine's own Markdown parser. Nothing reads the filesystem, resolves a
 * module, or searches a directory.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import {
  CORE_COMPONENT_NAMES,
  isComponentName,
  parseMarkdownDefinition,
  RESERVED_STRUCTURAL,
} from "@executablemd/core";
import type { WorkflowBundleComponent } from "@executablemd/core/host";
import { readGitObject, revParse } from "@executablemd/workflow";
import type { GitObjectFormat, WorkflowComponentEntry } from "@executablemd/workflow";

/** Hexadecimal digits per object id, by the format that names them. */
const OBJECT_ID_LENGTHS: Readonly<Record<GitObjectFormat, number>> = { sha1: 40, sha256: 64 };

/** The one frontmatter member a bundle is declared through. */
const DECLARATION = "workflow";

/** A declaration that cannot be read, or a bundle that cannot be established. */
export class WorkflowBundleUnavailableError extends Error {
  override name = "WorkflowBundleUnavailableError";
}

function unavailable(message: string, cause?: unknown): WorkflowBundleUnavailableError {
  return new WorkflowBundleUnavailableError(message, cause === undefined ? {} : { cause });
}

/**
 * One declared component, normalized against the root's own directory.
 *
 * `path` is already canonical: repository-relative, POSIX, with the single
 * optional leading `./` removed. It is what the definition retains and what
 * Git is asked for; the spelling the document wrote is not kept, because two
 * spellings of one path would be two identities for one bundle.
 */
export interface DeclaredComponent {
  readonly name: string;
  readonly path: string;
}

/**
 * The bundle a root document declares, normalized, or the refusal saying why it
 * declares none this command can run.
 *
 * An absent `workflow` member is a root with no bundle, which is an ordinary
 * definition and not an error. An empty map is refused: a workflow closed over
 * nothing is a workflow with no bundle, and admitting a second spelling of that
 * would make one run two identities.
 *
 * A refusal never quotes the declaration. Frontmatter is authored content, and
 * a name reaches a diagnostic only once it has passed the grammar a document
 * writes its component names in.
 */
export function declaredBundle(
  meta: Record<string, unknown>,
  rootDocumentPath: string,
): Result<readonly DeclaredComponent[]> {
  if (!Object.hasOwn(meta, DECLARATION)) {
    return Ok([]);
  }
  const declaration = meta[DECLARATION];
  if (!isPlainObject(declaration)) {
    return Err(
      unavailable(
        'the document\'s "workflow" frontmatter must be a mapping with one member, "components".',
      ),
    );
  }
  const members = Object.keys(declaration);
  if (members.length !== 1 || members[0] !== "components") {
    return Err(
      unavailable(
        'the document\'s "workflow" frontmatter declares exactly one member, "components".',
      ),
    );
  }
  const components = declaration["components"];
  if (!isPlainObject(components)) {
    return Err(
      unavailable('the document\'s "workflow.components" must be a mapping of name to path.'),
    );
  }
  const names = Object.keys(components);
  if (names.length === 0) {
    return Err(
      unavailable(
        'the document\'s "workflow.components" declares no component. Remove the "workflow" ' +
          "member to run this document without a component bundle.",
      ),
    );
  }

  const directory = parentDirectory(rootDocumentPath);
  const declared: DeclaredComponent[] = [];
  for (const name of names) {
    const usable = usableName(name);
    if (usable !== undefined) {
      return Err(usable);
    }
    const value = components[name];
    if (typeof value !== "string") {
      return Err(
        unavailable(
          `the document declares the component "${name}" without a path. Give each component ` +
            "the relative path of the Markdown file beside it.",
        ),
      );
    }
    const path = canonicalPath(value, directory, name);
    if (!path.ok) {
      return path;
    }
    declared.push({ name, path: path.value });
  }
  // Sorted by name here, once, so the identity view a definition retains and
  // the execution view core resolves against are one order rather than two.
  return Ok(Object.freeze([...declared].sort((left, right) => (left.name < right.name ? -1 : 1))));
}

/**
 * Whether a declared name is one this bundle may claim, or the refusal saying
 * why it is not.
 *
 * Structural syntax and core's own components are fixed and checked here, while
 * the root is still being read. What a *host* reserved is checked by canonical
 * core, which is where the registrations an execution actually starts with are
 * known — and it happens before the root is imported either way.
 */
function usableName(name: string): WorkflowBundleUnavailableError | undefined {
  if (!isComponentName(name)) {
    return unavailable(
      'the document\'s "workflow.components" names something that is not a component name. A ' +
        "component name is capitalized, and each dot-separated part starts with an uppercase " +
        "letter.",
    );
  }
  if (RESERVED_STRUCTURAL.has(name)) {
    return unavailable(
      `the document declares the component "${name}", which is structural syntax the engine ` +
        "owns rather than a component.",
    );
  }
  if (CORE_COMPONENT_NAMES.has(name)) {
    return unavailable(
      `the document declares the component "${name}", which the engine supplies. A workflow ` +
        "bundle adds component names; it does not replace them.",
    );
  }
  return undefined;
}

/**
 * The repository-relative path a declaration names, or the refusal saying why
 * it names none.
 *
 * A declared path locates a Markdown blob beside the root inside one commit, so
 * it is deliberately the narrowest thing that can do that: relative, POSIX,
 * forward only, and Markdown. Everything else — an absolute path, a
 * backslash, a URL, a package specifier, a glob, a directory, a traversal that
 * would land back inside the repository anyway — is refused rather than
 * repaired, because a repaired path runs a file the author did not write down.
 */
function canonicalPath(value: string, directory: string, name: string): Result<string> {
  const refuse = (reason: string): Result<string> =>
    Err(unavailable(`the path declared for the component "${name}" ${reason}.`));

  if (value === "") {
    return refuse("is empty");
  }
  if (value.includes("\u0000")) {
    return refuse("contains a NUL");
  }
  if (value.includes("\\")) {
    return refuse("is not POSIX: it contains a backslash");
  }
  if (value.startsWith("/")) {
    return refuse("is absolute, and a declaration is relative to the document beside it");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return refuse("is a URL, and a declaration names a file in this repository");
  }
  if (/[*?[\]{}]/.test(value)) {
    return refuse("contains glob syntax, and a declaration names exactly one file");
  }
  if (value.endsWith("/")) {
    return refuse("names a directory, and a declaration names one Markdown file");
  }

  // The one repair: `./Name.md` and `Name.md` are the same declaration, so one
  // leading `./` is removed rather than being a second spelling of it.
  const relative = value.startsWith("./") ? value.slice(2) : value;
  const segments = relative.split("/");
  for (const segment of segments) {
    if (segment === "") {
      return refuse("has an empty segment");
    }
    if (segment === "." || segment === "..") {
      return refuse('walks the tree with a "." or ".." segment, and a declaration does not');
    }
  }
  // A scoped package reads as an ordinary relative path and is not one. There
  // is no directory convention this costs: a bundled component lives beside the
  // document that declares it, and nothing beside it is a package.
  if (segments[0]?.startsWith("@") === true) {
    return refuse("is a package specifier, and a declaration names a file in this repository");
  }
  if (!relative.endsWith(".md")) {
    return refuse("is not a Markdown file, and a bundled component is Markdown");
  }
  return Ok(directory === "" ? relative : `${directory}/${relative}`);
}

function parentDirectory(rootDocumentPath: string): string {
  const cut = rootDocumentPath.lastIndexOf("/");
  return cut === -1 ? "" : rootDocumentPath.slice(0, cut);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read every declared component out of one commit, and parse it.
 *
 * Each source is read as a blob, so a declaration that names a directory, a
 * submodule, or a path the commit does not hold fails here rather than
 * executing as whatever Git chose to print. Each blob's own object id becomes
 * the source hash, under the repository's object format, so there is one hash
 * algorithm and it is Git's.
 *
 * Parsing happens here too. A bundled component that is not Markdown the engine
 * can read refuses the start before storage is created and before any component
 * code runs — rather than surfacing the first time a document writes its name.
 */
export function* readBundle(
  pinnedCommit: string,
  declared: readonly DeclaredComponent[],
  objectFormat: GitObjectFormat,
): Operation<Result<readonly WorkflowBundleComponent[]>> {
  const components: WorkflowBundleComponent[] = [];
  for (const component of declared) {
    const loaded = yield* readComponent(pinnedCommit, component, objectFormat);
    if (!loaded.ok) {
      return loaded;
    }
    components.push(loaded.value);
  }
  return Ok(Object.freeze(components));
}

function* readComponent(
  commit: string,
  declared: DeclaredComponent,
  objectFormat: GitObjectFormat,
): Operation<Result<WorkflowBundleComponent>> {
  const { name, path } = declared;
  let content: string;
  let sourceHash: string;
  try {
    // `cat-file blob` first: it refuses a tree, so a declaration that names a
    // directory fails before its object id is taken as a component's identity.
    content = yield* readGitObject(commit, path);
    sourceHash = (yield* revParse(`${commit}:${path}`)).toLowerCase();
  } catch (error) {
    return Err(
      unavailable(
        `the component "${name}" is not a file this workflow's commit holds at ${path}. ` +
          "Commit the component beside the document that declares it.",
        error,
      ),
    );
  }
  if (sourceHash.length !== OBJECT_ID_LENGTHS[objectFormat] || !/^[0-9a-f]+$/.test(sourceHash)) {
    return Err(
      unavailable(
        `the component "${name}" did not resolve to an object this repository's format names.`,
      ),
    );
  }
  const parsed = yield* parseComponent(name, path, content);
  if (!parsed.ok) {
    return parsed;
  }
  return Ok({ name, path, sourceHash, content });
}

function* parseComponent(name: string, path: string, content: string): Operation<Result<void>> {
  try {
    yield* parseMarkdownDefinition(name, path, content);
    return Ok(undefined);
  } catch (error) {
    return Err(
      unavailable(
        `the component "${name}" at ${path} is not a Markdown component this version can read: ` +
          (error instanceof Error ? error.message : String(error)),
        error,
      ),
    );
  }
}

/**
 * Rebuild the execution view of a bundle a run already retained.
 *
 * The retained entries are the authority: each is read from the retained
 * commit, at the retained path, and the blob's object id must be the hash the
 * definition holds. A component whose object changed, went missing, or is no
 * longer a blob refuses the resume — it does not resolve to whatever is there
 * now, which would continue a procedure under code it never executed.
 */
export function* reconstructBundle(
  pinnedCommit: string,
  retained: readonly WorkflowComponentEntry[],
  objectFormat: GitObjectFormat,
): Operation<Result<readonly WorkflowBundleComponent[]>> {
  const loaded = yield* readBundle(
    pinnedCommit,
    retained.map((entry) => ({ name: entry.name, path: entry.path })),
    objectFormat,
  );
  if (!loaded.ok) {
    return loaded;
  }
  for (const [index, component] of loaded.value.entries()) {
    if (component.sourceHash !== retained[index]?.sourceHash) {
      return Err(
        unavailable(
          `the component "${component.name}" is no longer the object this run's definition ` +
            "names. The run is left exactly as it is.",
        ),
      );
    }
  }
  return loaded;
}
