/**
 * The generated module's contract, under every runtime that loads it.
 *
 * `packages/web/generated/client-bundle.ts` is produced on a Deno machine and
 * read wherever `@executablemd/web` runs, so its shape has to hold under Deno,
 * Node, and Bun. Bundling needs `deno bundle` and stays in
 * `build-web-client.test.ts`; serializing assets into module text needs no host
 * at all, so this suite feeds the serializer assets that reach its escaping
 * boundaries, loads what it produced, and compares the loaded values against the
 * assets that went in.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import {
  byteLength,
  chooseQuote,
  constAssignment,
  generatedModule,
  quoteString,
} from "../lib/web-client-module.ts";
import { loadGeneratedModule } from "./generated-module.ts";

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * Every class of character the serializer treats specially, next to the ones it
 * must leave alone: both quote characters, a backslash, an escape sequence that
 * has to survive as literal text, C0 controls with and without a short form,
 * the line and paragraph separators — legal inside a JavaScript string literal
 * only when escaped — a template-literal opener, and astral-plane characters,
 * whose code points span two UTF-16 code units.
 */
const TRICKY_JS = [
  `const quotes = "double" + 'single';`,
  "const backslash = `a\\b` + `\\u0041 stays literal`;",
  "const controls = \b\t\f\v\r;",
  `const separators = ${LINE_SEPARATOR} and ${PARAGRAPH_SEPARATOR};`,
  "const template = ${not interpolated};",
  "const astral = 🎉 𝕏 日本語 Ünïcodé ЖЖ;",
].join("\n");

/** More double quotes than single, so `chooseQuote` takes its single-quote branch. */
const TRICKY_CSS = `.a::after { content: "\\201C" } .b::before { content: "it's \\201D" }`;

/** Long enough that `constAssignment` must break the line, with non-ASCII across the break. */
const LONG_CSS = `${TRICKY_CSS}\n${".é { color: red }\n".repeat(20)}`;

describe("generated module", () => {
  it("round-trips assets that reach every escaping boundary", function* () {
    const source = generatedModule(TRICKY_JS, TRICKY_CSS);

    const module = yield* loadGeneratedModule(source, ".mjs");

    expect(module.clientJs).toBe(TRICKY_JS);
    expect(module.themeCss).toBe(TRICKY_CSS);
  });

  it("round-trips an asset long enough to break across lines", function* () {
    const source = generatedModule(TRICKY_JS, LONG_CSS);
    expect(source).toContain("export const themeCss =\n  ");

    const module = yield* loadGeneratedModule(source, ".mjs");

    expect(module.themeCss).toBe(LONG_CSS);
  });

  it("records UTF-8 byte counts, which non-ASCII assets put above their length", function* () {
    const source = generatedModule(TRICKY_JS, TRICKY_CSS);

    const module = yield* loadGeneratedModule(source, ".mjs");

    expect(module.clientJsBytes).toBe(new TextEncoder().encode(TRICKY_JS).length);
    expect(module.themeCssBytes).toBe(new TextEncoder().encode(TRICKY_CSS).length);
    expect(module.clientJsBytes).toBeGreaterThan(TRICKY_JS.length);
  });
});

describe("quoteString", () => {
  it("prefers double quotes on a tie or when content has no quotes", function* () {
    expect(chooseQuote("no quotes here")).toBe('"');
    expect(chooseQuote(`one ' and one "`)).toBe('"');
  });

  it("switches to single quotes when they need strictly fewer escapes", function* () {
    expect(chooseQuote(`she said "hi" and "bye"`)).toBe("'");
  });

  it("escapes backslash and the chosen quote character", function* () {
    expect(quoteString("a\\b")).toBe('"a\\\\b"');
    expect(quoteString(`it's`)).toBe(`"it's"`);
    expect(quoteString(`"quoted"`)).toBe(`'"quoted"'`);
  });

  it("escapes C0 control characters, using short forms where they exist", function* () {
    expect(quoteString("a\nb\tc\r")).toBe('"a\\nb\\tc\\r"');
    expect(quoteString("\x01")).toBe('"\\u0001"');
  });

  it("escapes the line and paragraph separators", function* () {
    expect(quoteString(`a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`)).toBe('"a\\u2028b\\u2029c"');
  });
});

describe("constAssignment", () => {
  it("stays flat when the assignment fits oxfmt's print width", function* () {
    expect(constAssignment("x", '"short"')).toBe('export const x = "short";');
  });

  it("breaks after `=` when the flat assignment would exceed the print width", function* () {
    const quoted = `"${"x".repeat(90)}"`;
    expect(constAssignment("clientJs", quoted)).toBe(`export const clientJs =\n  ${quoted};`);
  });
});

describe("byteLength", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", function* () {
    expect(byteLength("é")).toBe(2);
    expect(byteLength("🎉")).toBe(4);
    expect("🎉".length).toBe(2);
  });
});
