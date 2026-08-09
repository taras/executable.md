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
  DocumentTargetError,
  encodeTargetLabel,
  isCanonicalTarget,
  normalizeLabel,
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
    expect(refusal(body, "test").kind).toBe("no-match");
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
    expect(refusal(body, "a/b").kind).toBe("no-match");
    // `%2A` is a literal asterisk; a raw `*` is the operator.
    expect(selectTarget(outline(body), "star%20%2A%20here").labels).toEqual(["star * here"]);
  });

  it("DT11: duplicate canonical paths stay duplicate entries", function* () {
    const body = ["# Title", "", "## Same", "", "one", "", "## Same", "", "two", ""].join("\n");
    expect(catalog(body)).toEqual(["Same", "Same"]);
    const ambiguous = refusal(body, "Same");
    expect(ambiguous.kind).toBe("multiple-matches");
    expect(ambiguous.matches).toEqual(["Same", "Same"]);
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
    expect(refusal("just prose\n", "Anything").available).toEqual([]);
  });

  it("DT19: a sole title is itself no target", function* () {
    expect(catalog("# Only\n\nbody\n")).toEqual([]);
  });
});

describe("Tier DT — target selectors", () => {
  it("DT20: a literal selector matches one whole label", function* () {
    expect(selectTarget(outline(SECTIONS), "Test/Node").labels).toEqual(["Test", "Node"]);
    expect(refusal(SECTIONS, "Nod").kind).toBe("no-match");
  });

  it("DT21: `*` matches within one level, in any position, more than once", function* () {
    expect(selectTarget(outline(SECTIONS), "Test/N*").target).toBe("Test/Node");
    expect(selectTarget(outline(SECTIONS), "Test/*ode").target).toBe("Test/Node");
    expect(selectTarget(outline(SECTIONS), "Test/N*d*").target).toBe("Test/Node");
    expect(selectTarget(outline(SECTIONS), "*ther").target).toBe("Other");
    // One `*` never crosses a level boundary.
    expect(refusal(SECTIONS, "*Node").kind).toBe("no-match");
  });

  it("DT22: `**` matches zero or more complete levels", function* () {
    expect(selectTarget(outline(SECTIONS), "**/Node").target).toBe("Test/Node");
    expect(selectTarget(outline(SECTIONS), "**/Other").target).toBe("Other");
    expect(selectTarget(outline(SECTIONS), "Other/**").target).toBe("Other");
    expect(selectTarget(outline(SECTIONS), "**/Bun/**").target).toBe("Test/Bun");
  });

  it("DT23: a selector must name exactly one entry", function* () {
    expect(refusal(SECTIONS, "**").kind).toBe("multiple-matches");
    expect(refusal(SECTIONS, "**").matches).toEqual(["Test", "Test/Node", "Test/Bun", "Other"]);
    expect(refusal(SECTIONS, "Missing").kind).toBe("no-match");
    expect(refusal(SECTIONS, "Missing").matches).toEqual([]);
    expect(refusal(SECTIONS, "Missing").available).toEqual([
      "Test",
      "Test/Node",
      "Test/Bun",
      "Other",
    ]);
  });

  it("DT24: malformed selector syntax is refused as syntax", function* () {
    for (const selector of ["", "/Test", "Test/", "Test//Node", "%zz", "Test/%2"]) {
      expect(refusal(SECTIONS, selector).kind).toBe("invalid-selector");
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
    expect(refusal(SECTIONS, "%00").kind).toBe("invalid-selector");
    // A lone continuation byte is not UTF-8.
    expect(refusal(SECTIONS, "%80").kind).toBe("invalid-selector");
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
    expect(refusal(body, selector).kind).toBe("no-match");
    expect(selectTarget(outline(body), `${"*a".repeat(30)}*`).labels).toEqual([label]);
  });

  it("DT28: whitespace beside a wildcard is matched; only the outer edges trim", function* () {
    const spaced = ["# Title", "", "## alpha beta gamma", ""].join("\n");
    const joined = ["# Title", "", "## alphabetagamma", ""].join("\n");
    expect(selectTarget(outline(spaced), "alpha%20*%20gamma").labels).toEqual(["alpha beta gamma"]);
    // The spaces around the wildcard are part of what was asked for.
    expect(refusal(joined, "alpha%20*%20gamma").kind).toBe("no-match");
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
    expect((caught as DocumentTargetError).kind).toBe("no-match");
    expect((caught as DocumentTargetError).selector).toBe("Nope");
  });

  it("DT47: the error's data is frozen and rebuilt, not the parser's arrays", function* () {
    const error = refusal(SECTIONS, "**");
    expect(Object.isFrozen(error.matches)).toBe(true);
    expect(Object.isFrozen(error.available)).toBe(true);
    expect(error.matches).not.toBe(outline(SECTIONS).targets);
    // Encoded throughout, so a control character in a heading cannot reach a
    // diagnostic literally.
    expect(error.message).toContain('"**"');
    for (const line of error.message.split("\n").slice(1)) {
      expect(line).not.toMatch(/[\u0000-\u001F]/);
    }
  });
});
