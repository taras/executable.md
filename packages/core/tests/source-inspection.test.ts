/**
 * Tier SI — static source boundaries (spec §5.8).
 *
 * Where the executable elements of a text are written, read without running
 * any of it. Every case below checks the ranges against the exact input — the
 * assertion is `text.slice(...)`, so an offset that drifted cannot pass by
 * agreeing with another offset — and the last two check that reading a
 * document interprets neither its header nor its body.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { inspectSource } from "../src/source-inspection.ts";
import type { SourceElement } from "../src/source-inspection.ts";
import { scanSegments } from "../src/scanner.ts";

/** The top-level element names the engine's own scan recognized in `text`. */
function componentNames(text: string): string[] {
  return scanSegments(text)
    .filter((segment) => segment.type === "component")
    .map((segment) => segment.name);
}

/** Whether `outer`'s opening..closing contains `inner`'s opening. */
function encloses(outer: SourceElement, inner: SourceElement): boolean {
  const end = outer.closing?.end ?? outer.opening.end;
  return outer.opening.start <= inner.opening.start && inner.opening.end <= end;
}

/** The elements of `text`, or a failure naming what refused it. */
function inspect(
  text: string,
  kind: "document" | "fragment" = "fragment",
): readonly SourceElement[] {
  const result = inspectSource(text, kind);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** Each element as the exact characters its ranges name. */
function cut(text: string, elements: readonly SourceElement[]): string[] {
  return elements.map((one) => {
    const opening = text.slice(one.opening.start, one.opening.end);
    if (one.closing === undefined) {
      return `${one.name} ${opening}`;
    }
    return `${one.name} ${opening} … ${text.slice(one.closing.start, one.closing.end)}`;
  });
}

describe("Tier SI — what a source text says it is made of", () => {
  it("SI1: nested, same-name, dotted, empty and self-closing elements, in opening order", function* () {
    const text =
      '<Plan as="p">\n' +
      "  <Json value={1} />\n" +
      "  <Plan>inner</Plan>\n" +
      "  <Ui.Panel></Ui.Panel>\n" +
      "</Plan>\n";
    const elements = inspect(text);

    expect(cut(text, elements)).toEqual([
      'Plan <Plan as="p"> … </Plan>',
      "Json <Json value={1} />",
      "Plan <Plan> … </Plan>",
      "Ui.Panel <Ui.Panel> … </Ui.Panel>",
    ]);
    // Exactly self-closing syntax lacks a closing range; paired empty content
    // still has one.
    expect(elements[1].closing).toBe(undefined);
    expect(elements[3].closing).not.toBe(undefined);
  });

  it("SI1: a quoted delimiter and a tag-like expression are not elements", function* () {
    const text = '<Json value={"a > b"} label="x > y" />\n';
    const elements = inspect(text);
    expect(cut(text, elements)).toEqual(['Json <Json value={"a > b"} label="x > y" />']);
  });

  it("SI1: fenced and inline code hold no elements", function* () {
    const text =
      "```md\n<Json value={1} />\n```\n\n" + "`<Plan>not this</Plan>`\n\n" + "<Json value={2} />\n";
    const elements = inspect(text);
    expect(cut(text, elements)).toEqual(["Json <Json value={2} />"]);
  });

  it("SI1: an incomplete passive tag is not an element, and leaves no guessed children", function* () {
    const text = "<Plan>\n  <Json value={1} />\n";
    // `<Plan>` has no closing delimiter, so it is prose. The nested element the
    // scanner looked at while trying is not committed as its child — and the
    // same walk then recognizes that `<Json />` where it really is, at the top
    // level, which is what the engine's own segments say too.
    const elements = inspect(text);
    expect(elements.map((one) => one.name)).toEqual(["Json"]);
    expect(elements[0].opening.start).toBe(text.indexOf("<Json"));
    expect(componentNames(text)).toEqual(["Json"]);
  });

  it("SI1: what inspection reports is what the engine's own scan recognized", function* () {
    const texts = [
      '<Plan as="p">\n  <Json value={1} />\n</Plan>\n',
      "<Plan>\n  <Json value={1} />\n",
      "```md\n<Json value={1} />\n```\n<Plan>x</Plan>\n",
      '<Json value={"a > b"} />\n',
      "`<Plan>x</Plan>` and <Json value={2} />\n",
    ];
    for (const text of texts) {
      // Inspection reports every element, nested ones included; the engine's
      // top-level segments report the outermost. The outermost must agree.
      const elements = inspect(text);
      const outermost = elements
        .filter((one) => !elements.some((other) => other !== one && encloses(other, one)))
        .map((one) => one.name);
      expect([text, outermost]).toEqual([text, componentNames(text)]);
    }
  });

  it("SI1: ranges index the exact text, BOM, CRLF and non-ASCII included", function* () {
    const text = "﻿# 界é🙂\r\n\r\n<Json value={1} />\r\n";
    const elements = inspect(text);
    expect(elements.length).toBe(1);
    expect(text.slice(elements[0].opening.start, elements[0].opening.end)).toBe(
      "<Json value={1} />",
    );
  });

  it("SI2: a document's offsets count from the start of the whole text", function* () {
    const header = "---\ntitle: a document\n---\n";
    const text = `${header}<Json value={1} />\n`;
    const elements = inspect(text, "document");

    expect(elements.length).toBe(1);
    // Counted from the file, not from the body: the header prefix is included.
    expect(elements[0].opening.start).toBe(header.length);
    expect(text.slice(elements[0].opening.start, elements[0].opening.end)).toBe(
      "<Json value={1} />",
    );
    // The same text read as a fragment has its header as ordinary prose, so the
    // element sits at the same place either way.
    expect(inspect(text, "fragment")[0].opening.start).toBe(header.length);
  });

  it("SI2: a header that looks executable is read as a header and never run", function* () {
    // The sentinel is in the header. If anything evaluated it the expression
    // would throw, and if anything scanned it as body it would be an element.
    const text =
      "---\n" +
      'title: <Json value={(() => { throw new Error("the header ran") })()} />\n' +
      "---\n" +
      "<Json value={1} />\n";
    const elements = inspect(text, "document");

    expect(cut(text, elements)).toEqual(["Json <Json value={1} />"]);
  });

  it("SI2: a fragment reads all of its text, header-looking prefix included", function* () {
    const text = "---\n<Json value={1} />\n---\n<Plan>x</Plan>\n";
    // As a fragment nothing is a header, so both elements are there.
    expect(inspect(text, "fragment").map((one) => one.name)).toEqual(["Json", "Plan"]);
    // As a document the first is inside the envelope and is not body at all.
    expect(inspect(text, "document").map((one) => one.name)).toEqual(["Plan"]);
  });

  it("SI2: an unterminated header is not a header", function* () {
    const text = "---\ntitle: x\n<Json value={1} />\n";
    // gray-matter's value parser refuses this text; inspection never calls it,
    // and reads the whole thing as body.
    expect(inspect(text, "document").map((one) => one.name)).toEqual(["Json"]);
  });

  it("SI1: text with no elements is success, not a refusal", function* () {
    expect(inspect("")).toEqual([]);
    expect(inspect("# just prose\n\nand more.\n")).toEqual([]);
  });

  it("SI1: every element and range it answers with is frozen", function* () {
    const [element] = inspect("<Plan>x</Plan>\n");
    expect(Object.isFrozen(element)).toBe(true);
    expect(Object.isFrozen(element.opening)).toBe(true);
    expect(Object.isFrozen(element.closing)).toBe(true);
  });
});
