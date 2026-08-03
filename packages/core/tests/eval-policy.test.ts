/**
 * Tier O — the error policy a persistent evaluation projects under (spec §4.3).
 *
 * A `persist eval` block runs on the invocation's eval-scope loop task, created
 * before the block's own documentation or `<Output>` policy existed. The policy
 * therefore travels with the block's binding environment rather than through the
 * surrounding context, and these tests read it back through the only surface
 * that can tell the two apart: what happens to an error raised by the content
 * the block projects.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useEchoExec, useStubFs } from "@executablemd/runtime/test";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { DocumentationError } from "../src/errors.ts";

const PROJECTING_BLOCK = [
  "```ts persist eval",
  "const projected = yield* renderChildren();",
  "output(projected);",
  "```",
];

describe("Tier O — Eval scope hierarchy", () => {
  beforeAll(() => useTempFileCompiler());

  // O23: the block sits in documentation, so its projection settles under the
  // throwing policy — the failure aborts the body instead of rendering.
  it("O23: a persistent projection in documentation settles under the throwing policy", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Wrap.md": [...PROJECTING_BLOCK, "", "<Output>", "done", "</Output>"].join("\n"),
      "doc.md": "<Wrap>\n<Missing />\n</Wrap>",
    });
    yield* useEchoExec();

    let failure: unknown;
    try {
      yield* collect(yield* execute({ path: "doc.md", stream }));
    } catch (error) {
      failure = error;
    }

    // Documentation fail-fast: the projected error aborts the body rather than
    // rendering, which a collecting policy would never do.
    expect(failure).toBeInstanceOf(DocumentationError);
    expect(String(failure)).toContain("Missing");
  });

  // O28: a claimed <Content /> in a documentation region settles under the
  // throwing policy — the projected error stops the body instead of being
  // collected and then discarded with the region's rendered output.
  it("O28: Markdown <Content /> in documentation fails fast on a projected error", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Wrap.md": ["<Content />", "", "<Output>", "done", "</Output>"].join("\n"),
      "doc.md": "<Wrap>\n<Missing />\n</Wrap>",
    });
    yield* useEchoExec();

    let failure: unknown;
    try {
      yield* collect(yield* execute({ path: "doc.md", stream }));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DocumentationError);
    expect(String(failure)).toContain("Missing");
  });

  // O29: the same projection inside <Output>, where the region is fail-fast
  // (#309). The policy travels with the projection, so the content task ends the
  // execution rather than rendering a comment, and the region's later text never
  // reaches the document.
  it("O29: a Markdown <Content /> inside <Output> fails on a projected error", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Wrap.md": ["<Output>", "<Content />", "", "done", "</Output>"].join("\n"),
      "doc.md": "<Wrap>\n<Missing />\n</Wrap>",
    });
    yield* useEchoExec();

    let failure: unknown;
    try {
      yield* collect(yield* execute({ path: "doc.md", stream }));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DocumentationError);
    expect(String(failure)).toContain("Missing");
  });

  // O30: value-component documentation carries the same policy, so a claimed
  // <Content /> that projects an error fails fast instead of being discarded
  // along with the documentation's rendered output.
  it("O30: a projected error in value-component documentation fails fast", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Value.md": [
        "---",
        "returns:",
        "  ok: { type: boolean }",
        "---",
        "",
        "<Content />",
        "",
        '<Return value={{ "ok": true }} />',
      ].join("\n"),
      "doc.md": '<Value as="result">\n<Missing />\n</Value>\n\nafter',
    });
    yield* useEchoExec();

    let failure: unknown;
    try {
      yield* collect(yield* execute({ path: "doc.md", stream }));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DocumentationError);
    expect(String(failure)).toContain("Missing");
  });

  // O25: an evaluation sees the bindings that existed when it started, and its
  // declared exports become shared once it completes.
  it("O25: exports are committed to the shared bindings for later blocks", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "doc.md": [
        "```js eval",
        "const port = 4321;",
        // A function is not JSON, so the journal cannot carry it: only the
        // explicit commit makes it reachable from the next block.
        "const describe = (n) => `port-${n}`;",
        "```",
        "",
        "```js eval",
        "output(`port=${port} ${describe(port)}`);",
        "```",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "doc.md", stream }));

    // `describe` is a function — `serializeExports` drops it, so reaching it
    // from the next block proves the commit publishes live values.
    expect(output).toContain("port=4321 port-4321");
  });

  // O26: persistent work keeps the values and the policy-bound capabilities it
  // captured; a later evaluation gets its own snapshot and cannot reach in.
  it("O26: a later evaluation cannot alter an earlier block's captured bindings", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Wrap.md": [
        "```js persist eval",
        "const captured = { seen: null };",
        "const renderer = renderChildren;",
        "yield* spawn(function*() {",
        "  yield* sleep(5);",
        "  captured.seen = typeof renderer;",
        "});",
        "```",
        "",
        "```js eval",
        "const renderer = null;",
        "```",
        "",
        "```js eval",
        "yield* when(function*() {",
        '  if (captured.seen === null) throw new Error("not yet");',
        "});",
        "output(`seen=${captured.seen}`);",
        "```",
      ].join("\n"),
      "doc.md": "<Wrap>\ncontent\n</Wrap>",
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "doc.md", stream }));

    // The middle block rebinding `renderer` did not reach the closure the
    // persistent task captured from its own snapshot.
    expect(output).toContain("seen=function");
  });

  // O27: an explicit import shadows the injected binding without the preamble
  // declaring it twice — the module would not compile otherwise.
  it("O27: an explicitly imported useContent compiles alongside the injected one", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Wrap.md": [
        "```ts eval",
        'import { useContent } from "@executablemd/core";',
        "const kind = typeof useContent;",
        "output(`imported=${kind}`);",
        "```",
      ].join("\n"),
      "doc.md": "<Wrap>\ncontent\n</Wrap>",
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "doc.md", stream }));

    expect(output).toContain("imported=function");
    expect(output).not.toContain("ERROR");
  });

  // O24: the same block inside a captured region of an <Output>, where the
  // projected error renders as a comment and the region still emits.
  it("O24: a captured persistent projection inside <Output> renders the diagnostic", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Wrap.md": [
        "<Output>",
        "<CaptureErrors>",
        ...PROJECTING_BLOCK,
        "</CaptureErrors>",
        "</Output>",
      ].join("\n"),
      "doc.md": "<Wrap>\n<Missing />\n</Wrap>",
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "doc.md", stream }));

    expect(output).toContain("ERROR");
  });

  // O31: the same collecting projection, captured — the string rendered the
  // error away, so the capture is refused (§6.5) and the recorded segment
  // returns to the caller instead of hiding inside the bound string.
  it("O31: a captured markdown projection refuses the binding on a projected error", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Wrap.md": [
        "<Output>",
        "<CaptureErrors>",
        ...PROJECTING_BLOCK,
        "</CaptureErrors>",
        "</Output>",
      ].join("\n"),
      "doc.md": '<Wrap as="cap">\n<Missing />\n</Wrap>\n\nvalue:{cap}:end',
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "doc.md", stream }));

    expect(output).toContain("ERROR");
    // The binding stays unset, so the interpolation stays literal and the
    // sibling text still renders under the collecting policy.
    expect(output).toContain("value:{cap}:end");
    // Reported once on the way out, not again when it crosses back.
    expect(String(output).split("Cannot resolve component: Missing").length - 1).toBe(1);
  });

  // O32: a caught DocumentationError is explicit recovery. The throw-bound
  // projection fails before anything is recorded for the capture refusal, so
  // the recovered component completes and the capture succeeds.
  it("O32: a caught projection error recovers without a later capture refusal", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Wrap.md": [
        "```ts eval",
        "const projected = yield* call(function* () {",
        "  try {",
        "    return yield* renderChildren();",
        "  } catch (error) {",
        '    return "recovered";',
        "  }",
        "});",
        "```",
        "",
        "<Output>",
        "```ts eval",
        "output(projected);",
        "```",
        "</Output>",
      ].join("\n"),
      "doc.md": '<Wrap as="cap">\n<Missing />\n</Wrap>\n\nvalue:{cap}:end',
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "doc.md", stream }));

    // The caught error is not reasserted: the binding holds the recovered
    // output and no error segment reaches the caller.
    expect(output).toContain("recovered");
    expect(output).not.toContain("{cap}");
    expect(output).not.toContain("ERROR");
  });

  // O33: work the projected content started is torn down with its scope, not
  // leaked past the invocation because the projection's error was caught.
  it("O33: projection-owned work does not escape a caught projection error", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Wrap.md": [
        "```ts eval",
        "const projected = yield* call(function* () {",
        "  try {",
        "    return yield* renderChildren();",
        "  } catch (error) {",
        '    return "recovered";',
        "  }",
        "});",
        "```",
        "",
        "<Output>",
        "```ts eval",
        "output(projected);",
        "```",
        "</Output>",
      ].join("\n"),
      "doc.md": [
        "```js eval",
        "const probe = { started: false, halted: false };",
        "```",
        "",
        '<Wrap as="cap">',
        "```js persist eval",
        "yield* spawn(function*() {",
        "  probe.started = true;",
        "  try {",
        "    yield* suspend();",
        "  } finally {",
        "    probe.halted = true;",
        "  }",
        "});",
        "```",
        "",
        "```js eval",
        "yield* when(function*() {",
        '  if (!probe.started) throw new Error("not yet");',
        "});",
        "```",
        "",
        "<Missing />",
        "</Wrap>",
        "",
        "value:{cap}:end",
        "",
        "```js eval",
        "output(`halted=${probe.halted}`);",
        "```",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "doc.md", stream }));

    // The suspended task the children spawned is gone by the time the sibling
    // runs: recovery completed, and catching the error leaked nothing.
    expect(output).toContain("recovered");
    expect(output).toContain("halted=true");
    expect(output).not.toContain("ERROR");
  });
});
