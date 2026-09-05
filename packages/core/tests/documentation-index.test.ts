/**
 * Tier SYN — the documentation index (#678).
 *
 * The index is what `<Syntax names={…}>`, `xmd syntax Elicit` and the release
 * reference all read, so a set that parses wrongly is wrong in three places at
 * once. Everything here is about it refusing rather than producing a partial
 * answer: a documentation set that has drifted from the components it documents
 * is a build problem, and the moment to say so is the build.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import {
  buildDocumentationIndex,
  DocumentationIndexError,
  owningPackage,
  parseDocumentationSource,
} from "../src/documentation-index.ts";
import type { DocumentationSource } from "../src/documentation-index.ts";
import type { ComponentOrigin } from "../src/types.ts";

const OWNER = "@executablemd/test";

/** One documentation file, as a package ships it. */
function source(text: string): DocumentationSource {
  return { owner: OWNER, asset: "packages/test/src/components/components.md", text };
}

/** What that package supplies, as the index validates headings against. */
function supplies(...names: readonly string[]): (owner: string) => ReadonlySet<string> {
  return (asked) => (asked === OWNER ? new Set(names) : new Set<string>());
}

const REGISTERED: ComponentOrigin = { kind: "registered", origin: OWNER, reserved: false };
const PROTECTED: ComponentOrigin = { kind: "protected", origin: OWNER };
const REPOSITORY: ComponentOrigin = { kind: "repository", path: "components/Alpha.md" };

describe("Tier SYN — parsing one documentation file", () => {
  it("SYN32: reads the bundle's own prose, then a section per component", function* () {
    const parsed = parseDocumentationSource(
      source(
        [
          "What this bundle is for.",
          "",
          "## Alpha",
          "",
          "About Alpha.",
          "",
          "### A detail of Alpha",
          "",
          "Still Alpha.",
          "",
          "## Beta",
          "",
          "About Beta.",
          "",
        ].join("\n"),
      ),
    );

    expect(parsed.bundle).toBe("What this bundle is for.");
    // A level-three heading stays in the section it is written in, so a
    // component's own documentation can have structure.
    expect(parsed.sections.get("Alpha")).toContain("### A detail of Alpha");
    expect(parsed.sections.get("Alpha")).toContain("Still Alpha.");
    expect(parsed.sections.get("Beta")).toBe("About Beta.");
    expect([...parsed.sections.keys()]).toEqual(["Alpha", "Beta"]);
  });

  it("SYN33: reads a heading inside a fence as the example it is", function* () {
    const parsed = parseDocumentationSource(
      source(
        ["## Alpha", "", "Write a heading like this:", "", "```md", "## Beta", "```", ""].join(
          "\n",
        ),
      ),
    );

    // One section, not two: the fenced `## Beta` is Markdown being shown, and
    // reading it as a section would move everything after it into the wrong
    // component.
    expect([...parsed.sections.keys()]).toEqual(["Alpha"]);
    expect(parsed.sections.get("Alpha")).toContain("## Beta");
  });

  it("SYN34: refuses a duplicate section and a heading that is not a name", function* () {
    expect(() =>
      parseDocumentationSource(source(["## Alpha", "one", "", "## Alpha", "two", ""].join("\n"))),
    ).toThrow(DocumentationIndexError);

    expect(() =>
      parseDocumentationSource(source(["## Getting started", "prose", ""].join("\n"))),
    ).toThrow(DocumentationIndexError);
  });
});

describe("Tier SYN — building the index", () => {
  it("SYN35: refuses a heading naming something the package does not supply", function* () {
    expect(() =>
      buildDocumentationIndex([source("## Gamma\n\nAbout Gamma.\n")], supplies("Alpha")),
    ).toThrow(DocumentationIndexError);
  });

  it("SYN36: refuses one component documented in two files", function* () {
    const first = source("## Alpha\n\nOne.\n");
    const second = { ...first, asset: "packages/test/src/other/components.md" };
    expect(() => buildDocumentationIndex([first, second], supplies("Alpha"))).toThrow(
      DocumentationIndexError,
    );
  });

  it("SYN37: attaches documentation by name and owning package together", function* () {
    const index = buildDocumentationIndex(
      [source("Bundle prose.\n\n## Alpha\n\nAbout Alpha.\n")],
      supplies("Alpha"),
    );

    // The package's own components, however core puts them into an execution.
    expect(index.documentationFor("Alpha", REGISTERED)).toBe("About Alpha.");
    expect(index.documentationFor("Alpha", PROTECTED)).toBe("About Alpha.");
    expect(index.bundleDocumentation(REGISTERED)).toBe("Bundle prose.");

    // A repository component that happens to share the name is a different
    // component, and gets none of it: its origin names no package at all.
    expect(index.documentationFor("Alpha", REPOSITORY)).toBeUndefined();
    expect(owningPackage(REPOSITORY)).toBeUndefined();

    // Neither does a component this package does not document.
    expect(index.documentationFor("Beta", REGISTERED)).toBeUndefined();
  });

  it("SYN38: builds from a set that documents only some of what it supplies", function* () {
    // A component with no section is legal: it renders the sentence `<Syntax>`
    // states for one, and stays usable while its documentation is written.
    const index = buildDocumentationIndex(
      [source("## Alpha\n\nAbout Alpha.\n")],
      supplies("Alpha", "Beta"),
    );
    expect(index.documentationFor("Alpha", REGISTERED)).toBe("About Alpha.");
    expect(index.documentationFor("Beta", REGISTERED)).toBeUndefined();
  });
});
