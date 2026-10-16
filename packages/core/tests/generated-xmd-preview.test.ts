/**
 * Tier GP — what an arriving generated root already says.
 *
 * A host streaming a reply shows the person what the reply says while the rest
 * of it is still arriving. `previewGeneratedXmdRoot()` answers that and nothing
 * else, and these cases hold it to four claims.
 *
 * **The transport's chunk boundaries do not matter.** Two identical accumulated
 * prefixes project identically, however the bytes were split — inside a tag,
 * inside an expression, inside a fence. The answer is a complete projection of
 * what has arrived rather than a delta, so a caller replaces what it was
 * showing.
 *
 * **Only text whose meaning is settled is shown.** Literal region text
 * previews. An expression, an interpolation and a nested component wait for
 * evaluation, because a preview that guessed would show a person something the
 * finished root never says. A tag written inside a passive fence is the example
 * it looks like and creates no region at all.
 *
 * **Incomplete and invalid are different answers.** Source still arriving is a
 * success that says so; source the language does not allow where it is written
 * is a refusal. Neither is the other, and `incomplete: false` says only that
 * this prefix is whole.
 *
 * **Nothing runs.** No file is read, no provider reached, no component invoked,
 * no expression evaluated. The function is not even an `Operation`, which is
 * most of the proof; what the cases add is that a prefix naming work does not
 * perform it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { previewGeneratedXmdRoot } from "../host.ts";
import type { GeneratedXmdRootPreview } from "../host.ts";

/** The projection, or a failure naming what was refused instead. */
function preview(source: string): GeneratedXmdRootPreview {
  const result = previewGeneratedXmdRoot(source);
  if (!result.ok) {
    throw new Error(`the prefix was refused: ${result.error.message}`);
  }
  return result.value;
}

/** Why the prefix was refused, or a failure naming what it projected instead. */
function refused(source: string): string {
  const result = previewGeneratedXmdRoot(source);
  if (result.ok) {
    throw new Error(`the prefix projected ${JSON.stringify(result.value)}`);
  }
  return result.error.message;
}

/** Every prefix of `source`, one code unit at a time. */
function prefixes(source: string): string[] {
  const all: string[] = [];
  for (let length = 0; length <= source.length; length += 1) {
    all.push(source.slice(0, length));
  }
  return all;
}

describe("Tier GP — a whole prefix projects what it says", () => {
  it("GP1: a complete region is the projection, and the prefix is whole", function* () {
    expect(preview("<Output>\nHello there.\n</Output>\n")).toEqual({
      output: "\nHello there.\n",
      incomplete: false,
    });
  });

  it("GP2: source outside a region, and the region's own delimiters, are left out", function* () {
    const projected = preview("documentation\n\n<Output>selected</Output>\n\nmore\n");

    expect(projected.output).toBe("selected");
    expect(projected.incomplete).toBe(false);
  });

  it("GP3: several regions project in source order as one text", function* () {
    expect(preview("<Output>one</Output>\nbetween\n<Output>two</Output>").output).toBe("onetwo");
  });

  it("GP4: a prefix with no region at all projects nothing, which is success", function* () {
    expect(preview("Just prose, and a finished <Probe /> beside it.\n")).toEqual({
      output: "",
      incomplete: false,
    });
  });

  it("GP5: an empty prefix projects nothing and is whole", function* () {
    expect(preview("")).toEqual({ output: "", incomplete: false });
  });
});

describe("Tier GP — an unfinished prefix says what it has", () => {
  it("GP6: an Output whose closing tag has not arrived carries its literal text", function* () {
    expect(preview("<Output>Hello")).toEqual({ output: "Hello", incomplete: true });
  });

  it("GP7: the closing tag arriving leaves the same text and makes the prefix whole", function* () {
    const arriving = preview("<Output>Hello");
    const arrived = preview("<Output>Hello</Output>");

    expect(arrived.output).toBe(arriving.output);
    expect(arriving.incomplete).toBe(true);
    expect(arrived.incomplete).toBe(false);
  });

  it("GP8: a tag whose name is still arriving projects nothing and waits", function* () {
    for (const partial of ["<", "<O", "<Out", "<Output", "<Output ", "<Output>"]) {
      const projected = preview(partial);
      expect(projected.output).toBe("");
      // `<` alone is prose until an uppercase letter follows it, which is the
      // scanner's own rule rather than a second one.
      expect(projected.incomplete).toBe(partial.length > 1);
    }
  });

  it("GP9: an unfinished construct after a whole region keeps the earlier text", function* () {
    const projected = preview('<Output>done</Output>\n<Probe url="https://example.test');

    expect(projected.output).toBe("done");
    expect(projected.incomplete).toBe(true);
  });

  it("GP10: an unfinished construct enclosing a region projects neither", function* () {
    // Until the `</If>` arrives this region is not known to be top level, and
    // once it does the source is refused. Showing its text now would show the
    // person something the finished root never says.
    const projected = preview("<If condition={true}>\n<Output>ok</Output>\n");

    expect(projected.output).toBe("");
    expect(projected.incomplete).toBe(true);
  });

  it("GP11: an unfinished expression prop waits", function* () {
    const projected = preview('<Output>done</Output>\n<Probe value={{ "a":');

    expect(projected.output).toBe("done");
    expect(projected.incomplete).toBe(true);
  });

  it("GP12: an unclosed fence waits, and its contents project nothing", function* () {
    const projected = preview("<Output>done</Output>\n\n```md\n<Output>example");

    expect(projected.output).toBe("done");
    expect(projected.incomplete).toBe(true);
  });

  it("GP13: an unclosed inline code span waits", function* () {
    const projected = preview("<Output>done</Output>\n\nand `half a span");

    expect(projected.output).toBe("done");
    expect(projected.incomplete).toBe(true);
  });
});

describe("Tier GP — only settled meaning projects", () => {
  it("GP14: literal text projects and interpolation waits", function* () {
    expect(preview("<Output>Hello, {who}!</Output>").output).toBe("");
    expect(preview("<Output>Hello, world!</Output>").output).toBe("Hello, world!");
  });

  it("GP15: an escaped brace is literal text, exactly as expansion protects it", function* () {
    expect(preview("<Output>a \\{literal} brace</Output>").output).toBe("a \\{literal} brace");
  });

  it("GP16: a brace neither interpolation pass would read is literal", function* () {
    expect(preview("<Output>a { b } rule</Output>").output).toBe("a { b } rule");
  });

  it("GP17: a nested component waits, and the literal text around it does not", function* () {
    expect(preview("<Output>before <Probe /> after</Output>").output).toBe("before  after");
  });

  it("GP18: an executable block inside a region projects nothing of itself", function* () {
    const projected = preview("<Output>text\n\n```bash exec\nprintf ran\n```\n</Output>");

    expect(projected.output).toContain("text");
    expect(projected.output).not.toContain("printf");
    expect(projected.incomplete).toBe(false);
  });

  it("GP19: a tag inside a passive fence creates no region", function* () {
    const source = "Here is an example:\n\n```md\n<Output>not a region</Output>\n```\n";

    expect(preview(source)).toEqual({ output: "", incomplete: false });
  });

  it("GP20: a region holding a passive fence projects the example as the text it is", function* () {
    const source = "<Output>\n```md\n<Output>an example</Output>\n```\n</Output>";
    const projected = preview(source);

    // One region, whose text happens to look like another. The fence is text to
    // the scan, so the inner tag is the example it looks like.
    expect(projected.output).toContain("<Output>an example</Output>");
    expect(projected.incomplete).toBe(false);
  });

  it("GP21: a passive fence that reads a binding waits, because expansion reads it", function* () {
    // A fence is a text segment, and interpolation runs over text segments.
    // Showing this brace would show a person something the finished root
    // replaces.
    const source = '<Output>\n```md\n<Each in={names} let="name">\n</Each>\n```\n</Output>';

    expect(preview(source).output).toBe("");
  });
});

describe("Tier GP — invalid source is refused, and says nothing of the prefix", () => {
  it("GP23: a region written below the top level is refused once it is whole", function* () {
    expect(refused("<If condition={true}>\n<Output>ok</Output>\n</If>\n")).toContain(
      "top-level child",
    );
  });

  it("GP24: a region nested inside another is refused", function* () {
    expect(refused("<Output>outer <Output>inner</Output></Output>")).toContain("top-level child");
  });

  it("GP25: a <Return> is refused, because a root declares no returns", function* () {
    expect(refused('<Output>ok</Output>\n<Return value="x" />\n')).toContain("<Return>");
  });

  it("GP26: a region carrying a prop is refused, whole or still arriving", function* () {
    expect(refused('<Output name="chat">ok</Output>')).toContain("no props");
    expect(refused('<Output name="chat">ok')).toContain("no props");
  });

  it("GP27: an invalid region is refused rather than reported incomplete", function* () {
    // The same text that refuses whole stays a refusal: this is not a prefix
    // waiting for more input.
    const whole = previewGeneratedXmdRoot("<Output>outer <Output>inner</Output></Output>");
    expect(whole.ok).toBe(false);
  });
});

describe("Tier GP — the transport's boundaries do not decide the answer", () => {
  const STREAMED = [
    "<Output>\nHello, world!\n</Output>\n",
    '<Probe value={{ "name": "Ada" }} />\n\n<Output>done</Output>\n',
    "<Output>\n```md\n<Output>example</Output>\n```\n</Output>\n",
    "documentation\n\n<Output>one</Output>\n\n<Output>two</Output>\n",
  ];

  for (const [index, source] of STREAMED.entries()) {
    it(`GP28: every prefix of source ${index + 1} projects the same answer twice`, function* () {
      for (const prefix of prefixes(source)) {
        const once = previewGeneratedXmdRoot(prefix);
        const again = previewGeneratedXmdRoot(prefix);
        expect(once.ok).toBe(again.ok);
        if (once.ok && again.ok) {
          expect(once.value).toEqual(again.value);
        }
      }
    });

    it(`GP29: source ${index + 1} ends whole, and every prefix projects a prefix of it`, function* () {
      const complete = previewGeneratedXmdRoot(source);
      if (!complete.ok) {
        throw new Error(`the whole source was refused: ${complete.error.message}`);
      }
      expect(complete.value.incomplete).toBe(false);
      // What a person is shown only ever grows towards what the source says. A
      // projection that had to be taken away again would be a preview that
      // guessed, which is the thing this projection does not do.
      for (const prefix of prefixes(source)) {
        const projected = previewGeneratedXmdRoot(prefix);
        if (!projected.ok) {
          throw new Error(`prefix ${JSON.stringify(prefix)}: ${projected.error.message}`);
        }
        expect(complete.value.output.startsWith(projected.value.output)).toBe(true);
      }
    });
  }

  it("GP30: the projection replaces rather than appends as a prefix grows", function* () {
    const growing = ["<Output>He", "<Output>Hell", "<Output>Hello"];
    const projected = growing.map((prefix) => preview(prefix).output);

    expect(projected).toEqual(["He", "Hell", "Hello"]);
  });
});

describe("Tier GP — nothing runs", () => {
  it("GP31: a prefix naming file, network and command work projects and performs none of it", function* () {
    // There is no execution around this call: no durable stream, no Files
    // provider, no Agent provider, no transport. A projection that read a file
    // or reached a provider could not answer here at all, and one that invoked
    // a component would need a resolution nothing has installed.
    const source =
      '<File path="notes.md">written</File>\n\n' +
      '<Fetch url="https://api.example.test/one" as="answer" />\n\n' +
      "```bash exec\nprintf ran\n```\n\n" +
      "<Output>\nthe reply\n</Output>\n";

    expect(preview(source)).toEqual({ output: "\nthe reply\n", incomplete: false });
  });

  it("GP32: the same prefix projects the same answer with nothing installed, twice over", function* () {
    // Synchronous and total: the answer is a value rather than an operation, so
    // there is no suspension point at which anything could have happened.
    const source = '<Output>steady</Output>\n<File path="notes.md">written</File>\n';

    expect(previewGeneratedXmdRoot(source)).toEqual(previewGeneratedXmdRoot(source));
  });
});
