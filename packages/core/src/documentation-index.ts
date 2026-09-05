/**
 * The long-form documentation a package ships beside the components it owns.
 *
 * `xmd syntax` and bare `<Syntax />` answer *what may I write here* — a compact
 * catalog of names, forms and one-line descriptions. Neither answers *how do I
 * use this one*, and an agent handed the compact catalog has to guess. So a
 * package that registers components also ships their documentation, and this
 * module turns those files into one validated index that `<Syntax names={…}>`,
 * `xmd syntax Elicit` and the release reference all read (#678).
 *
 * ## Beside the components, not beside the website
 *
 * A registration bundle keeps `components.md` beside its own registration
 * boundary, and the bytes are located from the owning module's URL — never from
 * the working directory and never through `--include`. A documentation set that
 * moved with the caller's directory would describe a different product depending
 * on where somebody stood, and a repository file could answer for it.
 *
 * ## The shape, and why it validates
 *
 * A level-two heading is an exact public component name. Everything before the
 * first one documents the bundle. Level-three and deeper headings belong to the
 * component whose section they are in, so a component's own documentation can
 * have structure without ending its section.
 *
 * Three things refuse the whole index rather than producing a partial one:
 *
 * - a **duplicate** heading, in one file or across two, because then a component
 *   has two documentations and nothing says which is current;
 * - an **unknown** heading, because it is documentation for something this
 *   boundary does not register — a rename that updated one side, usually;
 * - a heading that is **not a component name at all**, which is a file that has
 *   drifted from this format into ordinary prose.
 *
 * A component with *no* section is not a failure. It renders the sentence
 * `<Syntax>` states for one, and stays usable while its documentation is still
 * being written.
 *
 * ## The join is name *and* origin
 *
 * Documentation is attached by both together. A repository `Elicit.md` is a
 * different component from the built-in `Elicit` however it is spelled, and
 * handing it the built-in's prose would describe behaviour the author's own file
 * does not have.
 */

import { isComponentName } from "./components/registration.ts";
import { parseSource } from "./definition.ts";
import type { ComponentOrigin } from "./types.ts";

/** One package's documentation for the components it registers. */
export interface DocumentationSource {
  /**
   * The package this file documents, as its components report it —
   * `@executablemd/core`, for the components canonical core owns.
   *
   * Half of the join, and a package rather than one origin *value* because a
   * single registration boundary supplies components of more than one origin
   * kind: canonical core owns `Syntax` in the protected tier and registers
   * `Elicit` and `File` beside it, and all three are documented in one file.
   *
   * What this deliberately cannot match is an origin that names no package: a
   * repository path, a workflow blob, a host's declared Markdown. A repository
   * `Elicit.md` is a different component that happens to share a name, and
   * handing it the built-in's prose would describe behaviour the author's own
   * file does not have.
   */
  readonly owner: string;
  /** Where the bytes came from, so a refusal names a file somebody can open. */
  readonly asset: string;
  readonly text: string;
}

/**
 * The package an origin names, or nothing when it names none.
 *
 * Only a registration and a protected component come from a package. A
 * repository file, a bundled blob and declared Markdown are all *this run's*,
 * however they are spelled, so no package-owned documentation is theirs.
 */
export function owningPackage(origin: ComponentOrigin): string | undefined {
  if (origin.kind === "registered" || origin.kind === "protected") {
    return origin.origin;
  }
  return undefined;
}

/** A documentation set this version will not build an index from. */
export class DocumentationIndexError extends Error {
  override name = "DocumentationIndexError";
}

/**
 * A name selected for documentation that this site has no component for.
 *
 * Its own error because it is the author's mistake rather than the build's: a
 * misspelling, or a component that is not on this profile. It refuses the whole
 * lookup, so nothing is rendered and nothing is retained.
 */
export class UnknownComponentError extends Error {
  override name = "UnknownComponentError";
}

/** The long-form documentation one component has, if it has any. */
export interface DocumentationIndex {
  /** The documentation for exactly this component, or nothing when it has none. */
  documentationFor(name: string, origin: ComponentOrigin): string | undefined;
  /** What the bundle at this origin says about itself, if anything. */
  bundleDocumentation(origin: ComponentOrigin): string | undefined;
}

/**
 * A Markdown component's own documentation, taken from its own document.
 *
 * A repository component, a bundled one and a host's declared Markdown are all
 * *this run's* rather than a package's, so no `components.md` documents them.
 * Their long-form documentation, when they have any, is the prose in their own
 * file — which is where an author writing one would put it, and the only place
 * that stays correct when the file changes.
 *
 * Read from the source the selection already holds, so this loads nothing: a
 * repository component's bytes were read to describe it, and a bundled or
 * declared one's were admitted before the run began.
 */
export function markdownDocumentation(path: string, source: string): string | undefined {
  // The canonical splitter, not a delimiter search of this module's own: a
  // document whose body repeats `---` is ordinary, and a second implementation
  // of the rule is one release from disagreeing with the one that decides what
  // actually runs.
  const body = parseSource(path, source).content.trim();
  return body.length === 0 ? undefined : body;
}

/** What a component with no authored documentation renders instead of prose. */
export const NO_DOCUMENTATION = "No long-form documentation is available for this component.";

/** A level-two heading, captured without its marker. */
const HEADING = /^##\s+(.+?)\s*$/;
/** Any ATX heading, so a deeper one can be told from a section boundary. */
const ANY_HEADING = /^(#{1,6})\s+/;
/**
 * A fence line: its delimiter run, and whatever follows on the line.
 *
 * Three rules decide whether a line ends the block it is in, and getting any of
 * them wrong reads an example as documentation. The closing run must be the same
 * character, at *least* as long as the opener — so a four-backtick example may
 * contain a three-backtick block — and it must carry nothing after it but
 * whitespace. An *opening* fence may carry an info string (` ```mdx `); a
 * closing one may not, so a same-length delimiter followed by text is still
 * inside the example.
 */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** One source, parsed into the bundle's own prose and a section per component. */
interface ParsedSource {
  readonly bundle: string;
  readonly sections: ReadonlyMap<string, string>;
}

/**
 * Parse one `components.md`.
 *
 * Fences are tracked because a documentation file is mostly examples, and an
 * example that writes `## Heading` inside a fenced block is showing Markdown
 * rather than starting a section. Reading it as a section would silently move
 * every following component's prose into the wrong entry.
 */
export function parseDocumentationSource(source: DocumentationSource): ParsedSource {
  const lines = source.text.split(/\r?\n/);
  const sections = new Map<string, string[]>();
  const bundle: string[] = [];
  let current: string[] = bundle;
  /** The fence currently open, as the exact marker that opened it. */
  let fence: string | undefined;

  for (const line of lines) {
    const fenced = FENCE.exec(line);
    if (fenced !== null) {
      const marker = fenced[1] ?? "";
      const trailing = fenced[2] ?? "";
      if (fence === undefined) {
        // Opening: the info string is allowed and ignored.
        fence = marker;
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        trailing.trim().length === 0
      ) {
        fence = undefined;
      }
      current.push(line);
      continue;
    }
    if (fence !== undefined) {
      current.push(line);
      continue;
    }
    const heading = HEADING.exec(line);
    // A level-two heading opens a section; `###` and deeper stay in the one
    // they are written in, which is what lets a component's documentation have
    // headings of its own.
    const depth = ANY_HEADING.exec(line)?.[1]?.length;
    if (heading === null || depth !== 2) {
      current.push(line);
      continue;
    }
    const name = heading[1] ?? "";
    // The canonical grammar rather than a second copy of it, so a dotted name
    // like `File.Delete` or `PullRequest.Reviews` can be documented and looked
    // up. A private regex here would have quietly excluded every namespaced
    // component in the product.
    if (!isComponentName(name)) {
      throw new DocumentationIndexError(
        `${source.asset} has the level-two heading "${name}", which is not a component name. ` +
          "Every level-two heading in a component documentation file names one component.",
      );
    }
    if (sections.has(name)) {
      throw new DocumentationIndexError(
        `${source.asset} documents ${name} twice, so nothing says which section is current.`,
      );
    }
    current = [];
    sections.set(name, current);
  }

  return {
    bundle: joined(bundle),
    sections: new Map([...sections].map(([name, body]) => [name, joined(body)])),
  };
}

/** A section's lines as one string, with the blank edges trimmed off. */
function joined(lines: readonly string[]): string {
  return lines.join("\n").trim();
}

/**
 * Build the index every documentation reader shares.
 *
 * `known` is what each origin actually registers, so a heading naming something
 * else is caught here rather than becoming an entry nothing can ever select. It
 * is the catalog's own answer, which is what keeps the index and the catalog
 * from disagreeing about which components exist.
 */
export function buildDocumentationIndex(
  sources: readonly DocumentationSource[],
  known: (owner: string) => ReadonlySet<string>,
): DocumentationIndex {
  const documentation = new Map<string, Map<string, string>>();
  const bundles = new Map<string, string>();

  for (const source of sources) {
    const parsed = parseDocumentationSource(source);
    const registered = known(source.owner);
    const held = documentation.get(source.owner) ?? new Map<string, string>();
    for (const [name, body] of parsed.sections) {
      if (!registered.has(name)) {
        throw new DocumentationIndexError(
          `${source.asset} documents ${name}, which ${source.owner} does not supply. ` +
            "Documentation for a component nothing there declares can never be selected.",
        );
      }
      // Across sources as well as within one: two files documenting one
      // component of one package is the same ambiguity as one file doing it.
      if (held.has(name)) {
        throw new DocumentationIndexError(
          `${name} is documented twice for ${source.owner}, so nothing says which is current.`,
        );
      }
      held.set(name, body);
    }
    documentation.set(source.owner, held);
    if (parsed.bundle.length > 0) {
      bundles.set(source.owner, parsed.bundle);
    }
  }

  // Exact coverage, not merely no surprises. A first-party package documents
  // every public component it supplies: a member with no section is a component
  // shipped without documentation, and letting it fall back to the sentence
  // would make the product's own reference silently incomplete — the reader
  // cannot tell "nobody has written this yet" from "this component has nothing
  // to say". The fallback is for custom components, which no package governs.
  for (const [owner, held] of documentation) {
    const missing = [...known(owner)].filter((name) => !held.has(name)).sort();
    if (missing.length > 0) {
      throw new DocumentationIndexError(
        `${owner} supplies ${missing.length === 1 ? "a component" : "components"} with no ` +
          `documentation: ${missing.join(", ")}. Every public component a first-party ` +
          "package supplies has exactly one documentation section.",
      );
    }
  }

  return {
    documentationFor(name: string, origin: ComponentOrigin): string | undefined {
      const owner = owningPackage(origin);
      return owner === undefined ? undefined : documentation.get(owner)?.get(name);
    },
    bundleDocumentation(origin: ComponentOrigin): string | undefined {
      const owner = owningPackage(origin);
      return owner === undefined ? undefined : bundles.get(owner);
    },
  };
}
