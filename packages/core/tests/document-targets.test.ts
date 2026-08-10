/**
 * Tier DT — document targets (spec §5.4).
 *
 * A target is an addressable static heading, and selecting one runs the
 * preamble, each ancestor's own content, and that heading's subtree. These
 * assert the three properties the feature stands on.
 *
 * **Discovery cannot see inside a component.** The masked parse is not a
 * refinement of a Remark parse — a component child holding a blank line and a
 * `#` line surfaces as a root heading without it, so DT13 fails outright
 * against raw Remark discovery.
 *
 * **A selector resolves exactly once, before anything runs.** Zero matches and
 * several matches are both failures, and duplicate canonical paths stay
 * duplicates so the ambiguity is visible rather than silently resolved.
 *
 * **Projection retains original ranges.** The assertions read the projected
 * source and the scanned positions rather than a rendering, because the
 * position is what an expansion identifier is derived from.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";

import {
  asDocumentTargetError,
  DocumentTargetError,
  encodeTargetLabel,
  isCanonicalTarget,
  isDocumentTargetError,
  normalizeLabel,
  parseDocumentTargetFailure,
  outlineDocument,
  retainedRanges,
  selectTarget,
} from "../src/document-targets.ts";
import { scanComponentSpans } from "../src/scanner.ts";
import { parseRootMarkdownDefinition } from "../src/definition.ts";
import { fileSource, formatDocumentReference, inlineSource } from "../src/root-source.ts";
import { inspectDocument } from "../src/inspect.ts";

function outline(body: string) {
  return outlineDocument(body, scanComponentSpans(body));
}

function catalog(body: string): readonly string[] {
  return outline(body).targets;
}

function project(body: string, selector: string): string {
  const found = outline(body);
  const entry = selectTarget(found, selector);
  return retainedRanges(found, entry)
    .map((range) => body.slice(range.start, range.end))
    .join("");
}

/** The failure a selector produced, refusing to pass a success off as one. */
function refusal(body: string, selector: string): DocumentTargetError {
  try {
    selectTarget(outline(body), selector);
  } catch (error) {
    if (error instanceof DocumentTargetError) {
      return error;
    }
    throw error;
  }
  throw new Error(`${selector} resolved instead of failing`);
}

const SECTIONS = [
  "preamble",
  "",
  "# Title",
  "",
  "intro",
  "",
  "## Test",
  "",
  "test intro",
  "",
  "### Node",
  "",
  "node body",
  "",
  "### Bun",
  "",
  "bun body",
  "",
  "## Other",
  "",
  "other body",
  "",
].join("\n");

describe("Tier DT — document target catalog", () => {
  it("DT1: catalogs ATX headings in source order under a sole title", function* () {
    expect(catalog(SECTIONS)).toEqual(["Test", "Test/Node", "Test/Bun", "Other"]);
  });

  it("DT2: a Setext heading is an ordinary outline heading", function* () {
    const body = ["Title", "=====", "", "Section", "-------", "", "body", ""].join("\n");
    expect(catalog(body)).toEqual(["Section"]);
  });

  it("DT3: a skipped depth still nests, and the depth itself is not the path", function* () {
    const body = ["# Title", "", "#### Deep", "", "body", ""].join("\n");
    expect(catalog(body)).toEqual(["Deep"]);
  });

  it("DT4: the outermost depth is the smallest present, not h1", function* () {
    const body = ["## A", "", "### A1", "", "## B", ""].join("\n");
    expect(catalog(body)).toEqual(["A", "A/A1", "B"]);
  });

  it("DT5: several outermost headings all take a path level", function* () {
    const body = ["# A", "", "## A1", "", "# B", "", "## B1", ""].join("\n");
    expect(catalog(body)).toEqual(["A", "A/A1", "B", "B/B1"]);
  });

  it("DT6: matching is case sensitive", function* () {
    const body = ["# Title", "", "## Test", ""].join("\n");
    expect(refusal(body, "test").data.kind).toBe("no-match");
    expect(selectTarget(outline(body), "Test").target).toBe("Test");
  });

  it("DT7: a label is the statically rendered text, formatting removed", function* () {
    const body = [
      "# Title",
      "",
      "## **Bold** and _italic_",
      "",
      "## A [link](https://example.test/x) here",
      "",
      "## Inline `code` text",
      "",
      "## Alt ![a picture](img.png) text",
      "",
      "## <b>Tagged</b> text",
      "",
    ].join("\n");
    expect(catalog(body)).toEqual([
      "Bold%20and%20italic",
      "A%20link%20here",
      "Inline%20code%20text",
      "Alt%20a%20picture%20text",
      "Tagged%20text",
    ]);
  });

  it("DT8: NFC-equivalent spellings are one label, and Unicode space collapses", function* () {
    const decomposed = ["# Title", "", "## Café    name", ""].join("\n");
    expect(catalog(decomposed)).toEqual([encodeTargetLabel("Café name")]);
    expect(normalizeLabel("Café    name")).toBe("Café name");
    // The precomposed spelling addresses the decomposed heading.
    expect(selectTarget(outline(decomposed), encodeTargetLabel("Café name")).labels).toEqual([
      "Café name",
    ]);
  });

  it("DT9: a heading that renders no text is not addressable", function* () {
    const body = ["# Title", "", "##", "", "body", "", "## Real", ""].join("\n");
    expect(catalog(body)).toEqual(["Real"]);
  });

  it("DT10: reserved characters are percent-encoded, never left as syntax", function* () {
    const body = [
      "# Title",
      "",
      "## a/b",
      "",
      "## 100% done",
      "",
      "## C\\# sharp",
      "",
      "## star \\* here",
      "",
    ].join("\n");
    expect(catalog(body)).toEqual(["a%2Fb", "100%25%20done", "C%23%20sharp", "star%20%2A%20here"]);
    // `%2F` addresses one label containing a slash; a raw `/` would be hierarchy.
    expect(selectTarget(outline(body), "a%2Fb").labels).toEqual(["a/b"]);
    expect(refusal(body, "a/b").data.kind).toBe("no-match");
    // `%2A` is a literal asterisk; a raw `*` is the operator.
    expect(selectTarget(outline(body), "star%20%2A%20here").labels).toEqual(["star * here"]);
  });

  it("DT11: duplicate canonical paths stay duplicate entries", function* () {
    const body = ["# Title", "", "## Same", "", "one", "", "## Same", "", "two", ""].join("\n");
    expect(catalog(body)).toEqual(["Same", "Same"]);
    const ambiguous = refusal(body, "Same");
    expect(ambiguous.data.kind).toBe("multiple-matches");
    expect(ambiguous.data.matches).toEqual(["Same", "Same"]);
  });

  it("DT12: only root-flow headings count", function* () {
    const body = [
      "# Title",
      "",
      "> # Quoted",
      "",
      "- # Listed",
      "",
      "```md",
      "# Fenced",
      "```",
      "",
      "```sh exec",
      "# Executed",
      "```",
      "",
      "<div>",
      "# Raw html child",
      "</div>",
      "",
      "## Real",
      "",
    ].join("\n");
    expect(catalog(body)).toEqual(["Real"]);
  });

  /**
   * The regression that decides the parser boundary.
   *
   * Remark ends an HTML block at a blank line, so a component child holding one
   * puts every following `#` line at the root of the tree. Discovery therefore
   * parses a masked copy in which the component's whole span is blanked. Remove
   * the mask and `Inner` appears here.
   */
  it("DT13: a component child's apparent headings are never targets", function* () {
    const body = [
      "# Title",
      "",
      "<Wrapper>",
      "",
      "# Inner",
      "",
      "some text",
      "",
      "## Inner two",
      "",
      "</Wrapper>",
      "",
      "## Real",
      "",
      "real body",
      "",
    ].join("\n");
    expect(catalog(body)).toEqual(["Real"]);
  });

  it("DT14: a heading overlapping component syntax is not addressable", function* () {
    const body = ["# Title", "", "## Head <Probe /> tail", "", "## Real", ""].join("\n");
    expect(catalog(body)).toEqual(["Real"]);
  });

  it("DT15: an interpolated heading is not addressable, and blocks its subtree", function* () {
    const body = [
      "# Title",
      "",
      "## {meta.name}",
      "",
      "### Under computed",
      "",
      "## {binding}",
      "",
      "## {props.a.b}",
      "",
      "## Real",
      "",
    ].join("\n");
    expect(catalog(body)).toEqual(["Real"]);
  });

  it("DT16: escaped interpolation is static text and stays addressable", function* () {
    const body = ["# Title", "", "## \\{meta.name\\}", "", "body", ""].join("\n");
    expect(catalog(body)).toEqual(["%7Bmeta.name%7D"]);
    expect(selectTarget(outline(body), "%7Bmeta.name%7D").labels).toEqual(["{meta.name}"]);
  });

  /**
   * The title is not a path level, so it is not a level that has to be
   * addressable either — which is the whole reason the exception exists.
   */
  it("DT17: a computed sole title still leaves its sections addressable", function* () {
    const body = ["# {meta.title}", "", "## Real", "", "### Deeper", ""].join("\n");
    expect(catalog(body)).toEqual(["Real", "Real/Deeper"]);
  });

  it("DT18: a document with no heading has an empty catalog", function* () {
    expect(catalog("just prose\n")).toEqual([]);
    expect(refusal("just prose\n", "Anything").data.available).toEqual([]);
  });

  it("DT19: a sole title is itself no target", function* () {
    expect(catalog("# Only\n\nbody\n")).toEqual([]);
  });
});

describe("Tier DT — target selectors", () => {
  it("DT20: a literal selector matches one whole label", function* () {
    expect(selectTarget(outline(SECTIONS), "Test/Node").labels).toEqual(["Test", "Node"]);
    expect(refusal(SECTIONS, "Nod").data.kind).toBe("no-match");
  });

  it("DT21: `*` matches within one level, in any position, more than once", function* () {
    expect(selectTarget(outline(SECTIONS), "Test/N*").target).toBe("Test/Node");
    expect(selectTarget(outline(SECTIONS), "Test/*ode").target).toBe("Test/Node");
    expect(selectTarget(outline(SECTIONS), "Test/N*d*").target).toBe("Test/Node");
    expect(selectTarget(outline(SECTIONS), "*ther").target).toBe("Other");
    // One `*` never crosses a level boundary.
    expect(refusal(SECTIONS, "*Node").data.kind).toBe("no-match");
  });

  it("DT22: `**` matches zero or more complete levels", function* () {
    expect(selectTarget(outline(SECTIONS), "**/Node").target).toBe("Test/Node");
    expect(selectTarget(outline(SECTIONS), "**/Other").target).toBe("Other");
    expect(selectTarget(outline(SECTIONS), "Other/**").target).toBe("Other");
    expect(selectTarget(outline(SECTIONS), "**/Bun/**").target).toBe("Test/Bun");
  });

  it("DT23: a selector must name exactly one entry", function* () {
    expect(refusal(SECTIONS, "**").data.kind).toBe("multiple-matches");
    expect(refusal(SECTIONS, "**").data.matches).toEqual([
      "Test",
      "Test/Node",
      "Test/Bun",
      "Other",
    ]);
    expect(refusal(SECTIONS, "Missing").data.kind).toBe("no-match");
    expect(refusal(SECTIONS, "Missing").data.matches).toEqual([]);
    expect(refusal(SECTIONS, "Missing").data.available).toEqual([
      "Test",
      "Test/Node",
      "Test/Bun",
      "Other",
    ]);
  });

  it("DT24: malformed selector syntax is refused as syntax", function* () {
    for (const selector of ["", "/Test", "Test/", "Test//Node", "%zz", "Test/%2"]) {
      expect(refusal(SECTIONS, selector).data.kind).toBe("invalid-selector");
    }
  });

  it("DT25: percent decoding is URI path decoding — `+` is a plus", function* () {
    const body = ["# Title", "", "## a+b", "", "## a b", ""].join("\n");
    expect(catalog(body)).toEqual(["a%2Bb", "a%20b"]);
    expect(selectTarget(outline(body), "a+b").labels).toEqual(["a+b"]);
    expect(selectTarget(outline(body), "a%2Bb").labels).toEqual(["a+b"]);
    expect(selectTarget(outline(body), "a%20b").labels).toEqual(["a b"]);
  });

  it("DT26: a malformed or NUL-bearing escape never decodes", function* () {
    expect(refusal(SECTIONS, "%00").data.kind).toBe("invalid-selector");
    // A lone continuation byte is not UTF-8.
    expect(refusal(SECTIONS, "%80").data.kind).toBe("invalid-selector");
  });

  /**
   * A backtracking matcher answers this in exponential time; the reachability
   * sweep answers it in the product of the two lengths. A regression to
   * backtracking does not fail this assertion — it never reaches it.
   */
  it("DT27: a wildcard-dense selector against a long label terminates", function* () {
    const label = "a".repeat(120);
    const body = ["# Title", "", `## ${label}`, ""].join("\n");
    const selector = `${"*a".repeat(30)}*b`;
    expect(refusal(body, selector).data.kind).toBe("no-match");
    expect(selectTarget(outline(body), `${"*a".repeat(30)}*`).labels).toEqual([label]);
  });

  it("DT28: whitespace beside a wildcard is matched; only the outer edges trim", function* () {
    const spaced = ["# Title", "", "## alpha beta gamma", ""].join("\n");
    const joined = ["# Title", "", "## alphabetagamma", ""].join("\n");
    expect(selectTarget(outline(spaced), "alpha%20*%20gamma").labels).toEqual(["alpha beta gamma"]);
    // The spaces around the wildcard are part of what was asked for.
    expect(refusal(joined, "alpha%20*%20gamma").data.kind).toBe("no-match");
    // The level's own outer whitespace is not, so a padded selector still lands.
    expect(selectTarget(outline(spaced), "%20alpha*gamma%20").labels).toEqual(["alpha beta gamma"]);
  });
});

describe("Tier DT — canonical references", () => {
  it("DT29: a reference splits at the first raw `#`", function* () {
    expect(fileSource("README.md")).toEqual({ path: "README.md" });
    expect(fileSource("README.md#Test/Node")).toEqual({
      path: "README.md",
      target: "Test/Node",
    });
    // A `#` inside the filename is written `%23`; the fragment keeps its own.
    expect(fileSource("odd%23name.md#A%23B")).toEqual({
      path: "odd#name.md",
      target: "A%23B",
    });
  });

  it("DT30: a path keeps its separators and decodes its escapes", function* () {
    expect(fileSource("docs/sub%20dir/a.md").path).toBe("docs/sub dir/a.md");
    // A literal `%HH` in a filename is spelled `%25HH`.
    expect(fileSource("lit%2520.md").path).toBe("lit%20.md");
  });

  it("DT31: an unreadable reference says only that", function* () {
    for (const reference of ["", "#Test", "a%zz.md", "a%00b.md"]) {
      let caught: unknown;
      try {
        fileSource(reference);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TypeError);
      expect((caught as Error).message).toBe("Invalid document reference");
      expect(Object.hasOwn(caught as Error, "cause")).toBe(false);
    }
  });

  it("DT32: formatting encodes the path and validates an exact target", function* () {
    expect(formatDocumentReference("README.md")).toBe("README.md");
    expect(formatDocumentReference("docs/a b.md")).toBe("docs/a%20b.md");
    expect(formatDocumentReference("odd#name.md", "A%23B")).toBe("odd%23name.md#A%23B");
    // Already canonical: encoded once, never twice.
    expect(formatDocumentReference("a.md", "a%2Fb")).toBe("a.md#a%2Fb");
  });

  it("DT33: formatting refuses anything that is not an exact canonical target", function* () {
    for (const target of ["", "Test/", "/Test", "Test/*", "**", "a/b*c", "a b", "a%2fb"]) {
      let caught: unknown;
      try {
        formatDocumentReference("a.md", target);
      } catch (error) {
        caught = error;
      }
      expect((caught as Error | undefined)?.message).toBe("Invalid document reference");
    }
    expect(isCanonicalTarget("Test/Node")).toBe(true);
    expect(isCanonicalTarget("Test/%2A")).toBe(true);
    expect(isCanonicalTarget("Test/*")).toBe(false);
  });

  /**
   * Canonical means "exactly what the encoder would have written". Anything
   * that decodes to a label needing normalization is a spelling of a target,
   * not the target — accepting one would let two spellings of one section
   * become two workflow-definition identities.
   */
  it("DT48: a level is canonical only through the whole round trip", function* () {
    for (const canonical of ["Caf%C3%A9", "a%20b", "A%2FB", "%2A", "%23", "a%2Bb", "Test/Node"]) {
      expect(isCanonicalTarget(canonical)).toBe(true);
      expect(formatDocumentReference("a.md", canonical)).toBe(`a.md#${canonical}`);
    }
    const rejected = [
      "Cafe%CC%81", // NFD — normalization would change it
      "a%09b", // a tab is not an ASCII space
      "a%20%20b", // uncollapsed whitespace
      "%20a", // leading whitespace
      "a%20", // trailing whitespace
      "a%2fb", // lowercase escape
      "A#B", // a raw `#` is the reference delimiter
      "a//b", // an empty level
      "a*b", // a raw wildcard operator
      "%00", // NUL
    ];
    for (const target of rejected) {
      expect(isCanonicalTarget(target)).toBe(false);
    }
  });

  it("DT49: a raw `#` is never a literal selector character, but `%23` is", function* () {
    const body = ["# Title", "", "## A#B", "", "## Real", ""].join("\n");
    expect(catalog(body)).toEqual(["A%23B", "Real"]);
    expect(selectTarget(outline(body), "A%23B").labels).toEqual(["A#B"]);
    expect(refusal(body, "A#B").data.kind).toBe("invalid-selector");
  });

  /**
   * The formatter may only produce references the parser reads back. Sampling
   * the rule would miss the two ways encoding loses information, so the
   * implementation checks the round trip itself and these pin both losses.
   */
  it("DT50: formatting refuses a path it could not encode losslessly", function* () {
    // NUL, which the decoder refuses outright, and both halves of a broken
    // surrogate pair, which encode lossily to the replacement character.
    for (const path of ["a\u0000b.md", "lone\uD800.md", "trail\uDC00.md"]) {
      let caught: unknown;
      try {
        formatDocumentReference(path);
      } catch (error) {
        caught = error;
      }
      expect((caught as Error | undefined)?.message).toBe("Invalid document reference");
    }
  });

  it("DT51: every formatted reference parses back to what it named", function* () {
    const paths = [
      "README.md",
      "docs/sub dir/a.md",
      "odd#name.md",
      "lit%20.md",
      "café/ü.md",
      "star*.md",
      "a+b.md",
    ];
    for (const path of paths) {
      expect(fileSource(formatDocumentReference(path))).toEqual({ path });
      expect(fileSource(formatDocumentReference(path, "A%2FB"))).toEqual({
        path,
        target: "A%2FB",
      });
    }
  });
});

describe("Tier DT — projection", () => {
  it("DT34: preamble, ancestor content, and the whole selected subtree", function* () {
    expect(project(SECTIONS, "Test/Node")).toBe(
      [
        "preamble",
        "",
        "# Title",
        "",
        "intro",
        "",
        "## Test",
        "",
        "test intro",
        "",
        "### Node",
        "",
        "node body",
        "",
        "",
      ].join("\n"),
    );
  });

  it("DT35: selecting a non-leaf keeps every descendant", function* () {
    const projected = project(SECTIONS, "Test");
    expect(projected).toContain("### Node");
    expect(projected).toContain("### Bun");
    expect(projected).not.toContain("## Other");
    expect(projected).not.toContain("other body");
  });

  it("DT36: sibling subtrees are absent, earlier and later alike", function* () {
    const projected = project(SECTIONS, "Test/Bun");
    expect(projected).toContain("bun body");
    expect(projected).not.toContain("node body");
    expect(projected).not.toContain("### Node");
    expect(projected).not.toContain("other body");
  });

  it("DT37: retained headings and the sole title stay in the projection", function* () {
    const projected = project(SECTIONS, "Test/Node");
    expect(projected).toContain("# Title");
    expect(projected).toContain("intro");
    expect(projected).toContain("## Test");
    expect(projected).toContain("test intro");
  });

  it("DT38: with several outermost headings none is retained by default", function* () {
    const body = ["pre", "", "# A", "", "a body", "", "# B", "", "b body", ""].join("\n");
    expect(project(body, "B")).toBe(["pre", "", "# B", "", "b body", ""].join("\n"));
  });

  it("DT39: an ancestor keeps only its own content, not an earlier sibling's", function* () {
    const body = [
      "# Title",
      "",
      "title content",
      "",
      "## First",
      "",
      "first content",
      "",
      "## Second",
      "",
      "second content",
      "",
    ].join("\n");
    expect(project(body, "Second")).toBe(
      ["# Title", "", "title content", "", "## Second", "", "second content", ""].join("\n"),
    );
  });
});

/**
 * The preamble is what precedes the outline, not what precedes the title.
 *
 * A document may open at a deeper level than the one supplying its title. The
 * shallowest heading is then not the first, and anchoring the preamble to it
 * puts an earlier addressable section inside the preamble — where it is
 * retained, rendered, and executed by every other target, while still being a
 * target in its own right.
 */
describe("Tier DT — preamble boundary", () => {
  const OPENS_DEEP = [
    "## Before",
    "",
    "before body",
    "",
    "# Title",
    "",
    "## After",
    "",
    "after body",
    "",
  ].join("\n");

  it("DT63: a section before the title is addressable and is not preamble", function* () {
    expect(catalog(OPENS_DEEP)).toEqual(["Before", "After"]);
    expect(outline(OPENS_DEEP).preambleEnd).toBe(0);
  });

  it("DT64: selecting the later section retains neither the earlier one nor its body", function* () {
    const projected = project(OPENS_DEEP, "After");
    expect(projected).toBe(["# Title", "", "## After", "", "after body", ""].join("\n"));
    expect(projected).not.toContain("## Before");
    expect(projected).not.toContain("before body");
  });

  it("DT65: the earlier section remains independently addressable", function* () {
    // Its subtree runs to the next heading, so the blank line separating them
    // is retained exactly as authored.
    expect(project(OPENS_DEEP, "Before")).toBe(["## Before", "", "before body", "", ""].join("\n"));
  });

  it("DT66: real preamble text before the first heading is still retained", function* () {
    const withPreamble = `preamble text\n\n${OPENS_DEEP}`;
    expect(project(withPreamble, "After")).toBe(
      ["preamble text", "", "# Title", "", "## After", "", "after body", ""].join("\n"),
    );
  });
});

describe("Tier DT — projected parsing", () => {
  function* parsed(body: string, selector?: string) {
    return yield* parseRootMarkdownDefinition("__root__", "doc.md", body, selector);
  }

  it("DT40: a retained element keeps the offset and line it was authored at", function* () {
    const body = [
      "# Title",
      "",
      "## Skipped",
      "",
      "x".repeat(400),
      "",
      "## Kept",
      "",
      "<Probe />",
      "",
    ].join("\n");

    const whole = yield* parsed(body);
    const targeted = yield* parsed(body, "Kept");
    const positionOf = (definition: { bodySegments: readonly unknown[] }) =>
      definition.bodySegments
        .flatMap((segment) =>
          typeof segment === "object" &&
          segment !== null &&
          "type" in segment &&
          segment.type === "component"
            ? [segment]
            : [],
        )
        .map((segment) => (segment as { position?: unknown }).position);

    expect(positionOf(whole.definition)).toEqual(positionOf(targeted.definition));
    expect(targeted.target).toBe("Kept");
  });

  it("DT41: CRLF source keeps its original offsets and lines too", function* () {
    const body = [
      "# Title",
      "",
      "## Skipped",
      "",
      "skipped body",
      "",
      "## Kept",
      "",
      "<Probe />",
      "",
    ].join("\r\n");
    const whole = yield* parsed(body);
    const targeted = yield* parsed(body, "Kept");
    const componentsOf = (segments: readonly unknown[]) =>
      segments.flatMap((segment) =>
        typeof segment === "object" &&
        segment !== null &&
        "type" in segment &&
        segment.type === "component"
          ? [segment as { position?: { offset: number; line: number } }]
          : [],
      );
    expect(componentsOf(targeted.definition.bodySegments)[0]?.position).toEqual(
      componentsOf(whole.definition.bodySegments)[0]?.position,
    );
  });

  it("DT42: frontmatter, props, and the return mode survive projection", function* () {
    const body = [
      "---",
      "title: Doc",
      "props:",
      "  name:",
      "    type: string",
      "returns:",
      "  type: object",
      "---",
      "",
      "# Title",
      "",
      "## Kept",
      "",
      "kept",
      "",
    ].join("\n");
    const targeted = yield* parsed(body, "Kept");
    expect(targeted.definition.meta).toEqual({ title: "Doc" });
    expect(targeted.definition.props).toMatchObject({ properties: { name: { type: "string" } } });
    expect(targeted.definition.returns).toMatchObject({ type: "object" });
    expect(targeted.targets).toEqual(["Kept"]);
  });

  it("DT43: the untargeted parse still scans the whole body", function* () {
    const whole = yield* parsed(SECTIONS);
    expect(whole.target).toBe(undefined);
    expect(whole.targets).toEqual(["Test", "Test/Node", "Test/Bun", "Other"]);
    const text = whole.definition.bodySegments
      .map((segment) => (segment.type === "text" ? segment.content : ""))
      .join("");
    expect(text).toBe(SECTIONS);
  });
});

describe("Tier DT — inspection", () => {
  it("DT44: inspection reports the catalog without selecting anything", function* (): Operation<void> {
    const info = yield* inspectDocument(inlineSource(SECTIONS));
    expect(info.targets).toEqual(["Test", "Test/Node", "Test/Bun", "Other"]);
    expect(info.target).toBe(undefined);
  });

  it("DT45: inspection resolves a glob to the exact canonical target", function* (): Operation<void> {
    const info = yield* inspectDocument(inlineSource(SECTIONS, { target: "**/N*" }));
    expect(info.target).toBe("Test/Node");
    expect(info.targets).toEqual(["Test", "Test/Node", "Test/Bun", "Other"]);
  });

  it("DT46: an unresolvable target fails inspection", function* (): Operation<void> {
    let caught: unknown;
    try {
      yield* inspectDocument(inlineSource(SECTIONS, { target: "Nope" }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocumentTargetError);
    expect((caught as DocumentTargetError).data.kind).toBe("no-match");
    expect((caught as DocumentTargetError).data.selector).toBe("Nope");
  });

  it("DT47: the error's data is frozen and rebuilt, not the parser's arrays", function* () {
    const error = refusal(SECTIONS, "**");
    expect(Object.isFrozen(error.data.matches)).toBe(true);
    expect(Object.isFrozen(error.data.available)).toBe(true);
    expect(error.data.matches).not.toBe(outline(SECTIONS).targets);
    // Encoded throughout, so a control character in a heading cannot reach a
    // diagnostic literally.
    expect(error.message).toContain('"**"');
    for (const line of error.message.split("\n").slice(1)) {
      expect(line).not.toMatch(/[\u0000-\u001F]/);
    }
  });
});

/**
 * Recognition is the whole contract, so it is tested as one.
 *
 * The boundary is closed and it reconstructs: a candidate is validated field by
 * field and a *fresh local* error is built from the result. Nothing the
 * candidate owns is handed on, which is why these mutate and revoke the
 * originals afterwards and assert the answer is unchanged.
 *
 * A separately loaded copy of this package is a different class producing the
 * same name and the same tagged data, and must be read on exactly the same
 * terms. Everything else — payload, a list that is not a catalog, fields that no
 * selection could have produced — must be refused.
 */
describe("Tier DT — structural recognition", () => {
  const CATALOG = ["# T", "", "## Alpha", "", "## Beta", ""].join("\n");

  /** Genuine failure data, so the fixtures cannot drift from the real thing. */
  const GENUINE = refusal(CATALOG, "Missing").data;
  const MESSAGE = refusal(CATALOG, "Missing").message;

  function data(change: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: "executablemd.document-target-failure",
      kind: GENUINE.kind,
      selector: GENUINE.selector,
      matches: [...GENUINE.matches],
      available: [...GENUINE.available],
      ...change,
    };
  }

  function shell(payload: unknown, message = MESSAGE): Error {
    const error = new Error(message);
    error.name = "DocumentTargetError";
    Object.assign(error, { data: payload });
    return error;
  }

  /** What a separately loaded copy produces: same shape, its own class. */
  function foreignError(): Error {
    class DocumentTargetError extends Error {
      readonly data = Object.freeze(data());
      constructor() {
        super(MESSAGE);
        this.name = "DocumentTargetError";
      }
    }
    return new DocumentTargetError();
  }

  it("DT52: a failure from another loaded copy is read on the same terms", function* () {
    const foreign = foreignError();
    expect(foreign instanceof DocumentTargetError).toBe(false);
    expect(isDocumentTargetError(foreign)).toBe(true);
    expect(asDocumentTargetError(foreign)?.data.kind).toBe("no-match");
  });

  it("DT53: this module's own failure is recognized", function* () {
    const own = refusal(CATALOG, "Missing");
    expect(isDocumentTargetError(own)).toBe(true);
    expect(asDocumentTargetError(own)?.data).toEqual(own.data);
  });

  /**
   * The reconstruction claim, made where it can fail. A boundary that returned
   * the candidate would pass every field assertion above and still hand a
   * caller arrays somebody else can rewrite.
   */
  it("DT54: recognition returns a fresh local error, never the candidate", function* () {
    const foreign = foreignError();
    const safe = asDocumentTargetError(foreign);

    expect(safe).not.toBe(foreign);
    expect(safe).toBeInstanceOf(DocumentTargetError);
    const original = foreign as unknown as { data: { available: unknown } };
    expect(safe?.data).not.toBe(original.data);
    expect(safe?.data.available).not.toBe(original.data.available);
    expect(Object.isFrozen(safe?.data)).toBe(true);
    expect(Object.isFrozen(safe?.data.available)).toBe(true);
  });

  it("DT55: a mutable nested list is copied, and later mutation changes nothing", function* () {
    const available = ["Alpha", "Beta"];
    // Frozen outer data around a list its owner can still rewrite.
    const candidate = shell(Object.freeze(data({ available })));
    const safe = asDocumentTargetError(candidate);
    expect(safe?.data.available).toEqual(["Alpha", "Beta"]);

    available.push("Injected");
    available[0] = "Rewritten";
    expect(safe?.data.available).toEqual(["Alpha", "Beta"]);
    expect(safe?.message).toBe(MESSAGE);
  });

  it("DT56: a revoked Proxy cannot reach through a result already built", function* () {
    const revocable = Proxy.revocable(["Alpha", "Beta"], {});
    const candidate = shell(Object.freeze(data({ available: revocable.proxy })));
    const safe = asDocumentTargetError(candidate);
    expect(safe?.data.available).toEqual(["Alpha", "Beta"]);

    revocable.revoke();
    // Reading the result must not touch the revoked original.
    expect(safe?.data.available).toEqual(["Alpha", "Beta"]);
    expect(safe?.message).toBe(MESSAGE);
    expect(String(safe)).toContain("Alpha");
    // A candidate whose Proxy is already revoked is simply refused.
    expect(isDocumentTargetError(candidate)).toBe(false);
    expect(asDocumentTargetError(candidate)).toBe(undefined);
  });

  it("DT57: data-level extras are refused, enumerable, hidden, or symbol-keyed", function* () {
    const enumerable = shell(Object.freeze(data({ extra: "payload" })));
    expect(isDocumentTargetError(enumerable)).toBe(false);

    const hidden = Object.freeze(
      Object.defineProperty(data(), "extra", { value: "/etc/passwd", enumerable: false }),
    );
    expect(isDocumentTargetError(shell(hidden))).toBe(false);

    const symbolic = Object.freeze(
      Object.defineProperty(data(), Symbol.for("payload"), {
        value: "/etc/passwd",
        enumerable: true,
      }),
    );
    expect(isDocumentTargetError(shell(symbolic))).toBe(false);
  });

  /**
   * Tested through the data parser, not through an Error shell.
   *
   * A shell carries a message derived from its data, so changing the data
   * without rebuilding the message makes recognition fail on the message —
   * which would make every case here green whether or not list validation
   * exists. Going straight at `parseDocumentTargetFailure` keeps each case
   * load-bearing.
   */
  it("DT58: a list entry that is not an encoded canonical target is refused", function* () {
    const rejected: unknown[][] = [
      // A raw space, tab or no-break space is not how a label is encoded.
      ["Alpha Beta"],
      ["Alpha\u0009Beta"],
      ["Alpha\u00A0Beta"],
      // Edge whitespace survives no round trip.
      ["Alpha "],
      // A lowercase escape is not what the encoder writes.
      ["a%2fb"],
      // NUL never decodes.
      ["%00"],
      // Not strings at all.
      [1],
      [null],
      // A sparse list is not a dense one.
      Object.assign(Array.from({ length: 2 }) as unknown[], { 0: "Alpha" }),
    ];
    for (const available of rejected) {
      expect(parseDocumentTargetFailure(Object.freeze(data({ available })))).toBe(undefined);
    }
    // The control: the same shape with a valid catalog parses.
    expect(parseDocumentTargetFailure(Object.freeze(data()))).toBeDefined();
  });

  /**
   * `.` and `..` are ordinary heading labels — a document may really have a
   * section called `..` — so `../../etc/passwd` is a well-formed four-level
   * canonical *heading path*, never filesystem authority, and nothing here
   * resolves it against a filesystem.
   *
   * Structural parsing therefore accepts it when the rest of the failure is
   * consistent. What refuses it is the journal protocol, which compares the
   * record against the catalog the recorded document derives — see TX31.
   */
  it("DT59: a dotted heading path is canonical, and parses when consistent", function* () {
    for (const path of ["../../etc/passwd", "Alpha/../Beta", "..", "."]) {
      expect(isCanonicalTarget(path)).toBe(true);
    }
    const parsed = parseDocumentTargetFailure(
      Object.freeze(data({ available: ["../../etc/passwd", "Alpha/../Beta"] })),
    );
    expect(parsed?.available).toEqual(["../../etc/passwd", "Alpha/../Beta"]);
  });

  it("DT60: fields no selection could have produced are refused", function* () {
    const inconsistent: Record<string, unknown>[] = [
      // `no-match` whose selector really does match the catalog.
      data({ kind: "no-match", selector: "Alpha", matches: [] }),
      // `no-match` carrying matches.
      data({ kind: "no-match", matches: ["Alpha"] }),
      // `multiple-matches` with one match.
      data({ kind: "multiple-matches", selector: "Alpha", matches: ["Alpha"] }),
      // `multiple-matches` claiming a match outside the catalog.
      data({ kind: "multiple-matches", selector: "**", matches: ["Alpha", "Gamma"] }),
      // `invalid-selector` whose selector parses perfectly well.
      data({ kind: "invalid-selector", selector: "Alpha" }),
      // A kind outside the closed set.
      data({ kind: "made-up" }),
      // A missing member.
      (() => {
        const partial = data();
        delete partial["available"];
        return partial;
      })(),
      // A member of the wrong type.
      data({ available: "Alpha" }),
      data({ selector: 7 }),
    ];
    for (const candidate of inconsistent) {
      expect(parseDocumentTargetFailure(Object.freeze(candidate))).toBe(undefined);
    }
  });

  it("DT61: the Error shell is closed too", function* () {
    const withCause = shell(Object.freeze(data()));
    Object.assign(withCause, { cause: new Error("foreign") });
    expect(isDocumentTargetError(withCause)).toBe(false);

    const withPayload = shell(Object.freeze(data()));
    Object.assign(withPayload, { path: "/etc/passwd" });
    expect(isDocumentTargetError(withPayload)).toBe(false);

    // A diagnostic that does not derive from the data it claims.
    expect(isDocumentTargetError(shell(Object.freeze(data()), "something else"))).toBe(false);

    for (const candidate of [undefined, null, "a string", new Error(MESSAGE), {}]) {
      expect(isDocumentTargetError(candidate)).toBe(false);
      expect(asDocumentTargetError(candidate)).toBe(undefined);
    }
  });

  /**
   * The payload question asked the way a consumer would ask it: after the
   * boundary, is any of it still reachable by the ordinary means of passing an
   * error on?
   */
  it("DT62: no planted payload survives the boundary", function* () {
    const planted = Object.freeze(
      Object.defineProperty(data(), Symbol.for("secret"), {
        value: "s3cret",
        enumerable: true,
      }),
    );
    // Refused outright, so nothing to survive.
    expect(asDocumentTargetError(shell(planted))).toBe(undefined);

    // And for a candidate that is accepted, the result carries only the
    // contract: no extra own member, string or symbol, on the data or the error.
    const safe = asDocumentTargetError(foreignError());
    expect(safe).toBeDefined();
    expect(Object.getOwnPropertyNames(safe?.data ?? {}).sort()).toEqual([
      "available",
      "kind",
      "matches",
      "selector",
      "type",
    ]);
    expect(Object.getOwnPropertySymbols(safe?.data ?? {})).toEqual([]);
    expect(Object.keys(safe ?? {}).sort()).toEqual(["data", "name"]);
    expect(Object.getOwnPropertySymbols(safe ?? {})).toEqual([]);
    expect(JSON.stringify({ ...safe })).not.toContain("s3cret");
    expect(String(safe)).toBe(`DocumentTargetError: ${MESSAGE}`);
    // A journal round trip rebuilds the same data from the same fields.
    expect(parseDocumentTargetFailure(JSON.parse(JSON.stringify(safe?.data)))).toEqual(safe?.data);
  });
});
