/**
 * Tier ES — a declared return the engine expands where it was written.
 *
 * A trusted host may say that the string one of its declared Markdown
 * components returns is not an ordinary value but Executable Markdown. Written
 * without `as`, canonical core expands those exact bytes at the authored site
 * as an **embedded text root**; written with `as`, it binds the same bytes and
 * expands none of them.
 *
 * What this tier measures is that the projection is genuinely embedded rather
 * than a second run: the effects it performs are the enclosing document's, they
 * receive durable identities beneath the authored element, and a replay resumes
 * inside them without repeating one. And that nothing else acquires the
 * behavior — an ordinary value component still requires `as`, a repository file
 * cannot ask for the disposition in frontmatter, and a journal recorded under a
 * different disposition refuses rather than continuing under this one.
 *
 * Every effect here is in process and deterministic: the program's one durable
 * effect is an identity component that records what it was asked, so a case
 * about something *not* running is proven by that recorder staying empty rather
 * than by absent output.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, until } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import type { Operation } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDurableOperation, InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { collect } from "../src/collect.ts";
import { executeInstalled, sourceDigest } from "../host.ts";
import type {
  DeclaredMarkdownComponent,
  ExecutionInstallation,
  IdentityClaimant,
  IdentityComponent,
} from "../host.ts";
import { inspectComponent, inspectSyntax } from "../src/inspect.ts";
import { validateDocument } from "../src/document-validation.ts";
import { retainedSource } from "../src/root-source.ts";
import type { ComponentInvocation } from "../src/invocation-identity.ts";

const ROOT_PATH = "documents/root.md";
const PROGRAM_ORIGIN = "@executablemd/test/Program.md";
const SOURCE_IDENTITY = "<program>";

/**
 * The declared component this tier runs against.
 *
 * It stands where `<Plan>` stands and does the same one thing an authorship
 * workflow does at the end: hand back exact program source. Authorship itself
 * is the CLI's tier — here the return is the caller's own text, so every case
 * is about what the engine does with approved bytes rather than about how they
 * were approved.
 */
const PROGRAM_SOURCE = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    source: { type: string }",
  "  required: [source]",
  "  additionalProperties: false",
  "returns:",
  "  type: string",
  "---",
  "",
  "<Return value={props.source} />",
  "",
].join("\n");

/** The same component with no disposition: an ordinary string-valued one. */
function program(overrides: Partial<DeclaredMarkdownComponent> = {}): DeclaredMarkdownComponent {
  const source = overrides.source ?? PROGRAM_SOURCE;
  return {
    name: "Program",
    origin: PROGRAM_ORIGIN,
    source,
    digest: sourceDigest(source),
    forms: ["self-closing"],
    ...overrides,
  };
}

/** The same component as the host that expands what it returns declares it. */
function expanding(overrides: Partial<DeclaredMarkdownComponent> = {}): DeclaredMarkdownComponent {
  return program({
    returnDisposition: { kind: "executable-source", sourceIdentity: SOURCE_IDENTITY },
    ...overrides,
  });
}

/**
 * The program's one durable effect, recorded where it happens.
 *
 * An identity component rather than an ordinary registration, because durable
 * work is the point: what it names is journaled, so a replay restores it and
 * this recorder stays empty. A case about something not running is proven by
 * that, never by absent output.
 */
function effect(performed: string[]): IdentityComponent {
  return {
    name: "Effect",
    origin: `${PROGRAM_ORIGIN}#Effect`,
    forms: ["self-closing"],
    props: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    factory: (claim: IdentityClaimant) =>
      function* Effect(
        props: Record<string, Json>,
        invocation: ComponentInvocation,
      ): Operation<string> {
        const id = yield* claim(invocation);
        const label = String(props.name);
        return yield* (function* (): Operation<string> {
          return (yield createDurableOperation<string>(
            { type: "call", name: `effect:${id}` },
            // deno-lint-ignore require-yield
            function* () {
              performed.push(label);
              return label;
            },
          )) as string;
        })();
      },
  };
}

/** One document, run against one set of declarations. */
function* runDocument(options: {
  source: string;
  declarations: readonly DeclaredMarkdownComponent[];
  performed: string[];
  stream?: InMemoryStream;
  includes?: readonly string[];
  props?: Record<string, Json>;
}): Operation<{ output: string; failure: string | undefined; stream: InMemoryStream }> {
  const stream = options.stream ?? new InMemoryStream();
  const chunks: string[] = [];
  let failure: string | undefined;
  yield* scoped(function* () {
    try {
      const installation: ExecutionInstallation = {
        declarations: [...options.declarations],
        components: [effect(options.performed)],
      };
      const execution = yield* executeInstalled(
        {
          ...retainedSource(ROOT_PATH, options.source),
          stream,
          includes: [...(options.includes ?? [])],
          ...(options.props === undefined ? {} : { props: options.props }),
        },
        [installation],
      );
      // Drained the way a consumer drains it, so a run that failed still shows
      // what it printed. A refusal proven by absent output would otherwise be
      // indistinguishable from output nobody read.
      yield* forEach(function* (chunk: string) {
        chunks.push(chunk);
      }, execution.output);
      yield* collect(execution);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  });
  return { output: chunks.join(""), failure, stream };
}

/** A document that names its program as a binding and then writes the element. */
function invoking(source: string, attributes = ""): string {
  return [
    "before",
    "",
    `<Let as="src" value={${JSON.stringify(source)}} />`,
    `<Program source={src}${attributes} />`,
    "",
    "after",
    "",
  ].join("\n");
}

/** A partial continuation of one run: everything it recorded but the terminals. */
function* continuing(stream: InMemoryStream): Operation<InMemoryStream> {
  const partial = new InMemoryStream();
  for (const event of yield* stream.readAll()) {
    if (event.type === "close") {
      continue;
    }
    yield* partial.append(event);
  }
  return partial;
}

/** Whether one retained event is a component import. */
function isImport(event: DurableEvent): boolean {
  return event.type === "yield" && event.description.type === "import_component";
}

/** A temporary directory this scope owns and removes. */
function* useTempDir(): Operation<string> {
  const dir = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "xmd-es-")))));
  yield* ensure(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("Tier ES — executable source returns", () => {
  it("ES1: the approved source expands once, where the element is written", function* () {
    const performed: string[] = [];
    const run = yield* runDocument({
      source: invoking(
        ["# The program", "", "the program ran.", "", '<Effect name="one" />', ""].join("\n"),
      ),
      declarations: [expanding()],
      performed,
    });

    expect(run.failure).toBe(undefined);
    // The effect happened exactly once, and it happened between the markers the
    // caller wrote around the element.
    expect(performed).toEqual(["one"]);
    const before = run.output.indexOf("before");
    const ran = run.output.indexOf("the program ran.");
    const after = run.output.indexOf("after");
    expect(before).toBeGreaterThanOrEqual(0);
    expect(ran).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(ran);
    // What the reader sees is the program's output, not its source: the element
    // that performed the effect is not printed in its place.
    expect(run.output).not.toContain('<Effect name="one" />');
    expect(run.output).not.toContain("returns:");
  });

  it("ES2: the source runs in the document's own environment", function* () {
    const dir = yield* useTempDir();
    // A component the current selection resolves, sitting on the caller's own
    // include path. The embedded source reaches it because import authority,
    // includes and the registry are the enclosing execution's.
    yield* writeTextFile(join(dir, "Greeting.md"), "a greeting\n");

    const performed: string[] = [];
    const source = [
      "---",
      "props:",
      "  type: object",
      "  properties:",
      "    who: { type: string }",
      "  required: [who]",
      "  additionalProperties: false",
      "release: 1.2.3",
      "---",
      "",
      "# The program",
      "",
      "<Output>",
      "for {props.who} at {meta.release}, greeting {greeting} via <Greeting />",
      "",
      '<Effect name="two" />',
      "</Output>",
      "",
      "this line is documentation and is not selected.",
      "",
    ].join("\n");

    const run = yield* runDocument({
      source: [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    who: { type: string }",
        "  required: [who]",
        "  additionalProperties: false",
        "---",
        "",
        "before",
        "",
        '<Let as="greeting" value="hello" />',
        `<Let as="src" value={${JSON.stringify(source)}} />`,
        "<Program source={src} />",
        "",
        "after",
        "",
      ].join("\n"),
      declarations: [expanding()],
      performed,
      includes: [dir],
      props: { who: "ada" },
    });

    expect(run.failure).toBe(undefined);
    expect(performed).toEqual(["two"]);
    // Ambient props reach the root schema, the root's own frontmatter reaches
    // `meta`, the caller's binding is still bound, and the imported component
    // rendered.
    expect(run.output).toContain("for ada at 1.2.3, greeting hello via a greeting");
    // Top-level `<Output>` selected, exactly as it does for a root document.
    expect(run.output).not.toContain("this line is documentation");
  });

  it("ES3: the same source under `as` binds byte for byte and runs none of it", function* () {
    const performed: string[] = [];
    const source = [
      "# The program",
      "",
      "the program ran.",
      "",
      '<Effect name="three" />',
      "",
    ].join("\n");
    const run = yield* runDocument({
      source: [
        `<Let as="src" value={${JSON.stringify(source)}} />`,
        '<Program source={src} as="captured" />',
        "",
        "got:{captured}",
        "",
      ].join("\n"),
      declarations: [expanding()],
      performed,
    });

    expect(run.failure).toBe(undefined);
    // The negative control: the source was bound, so nothing in it happened.
    expect(performed).toEqual([]);
    expect(run.output).toContain(`got:${source}`);
  });

  it("ES4: a return that never arrives expands nothing and binds nothing", function* () {
    const performed: string[] = [];
    // The declaration fails before its `<Return>`, which is what every
    // unsuccessful authorship ending is from the engine's side.
    const refusing = [
      "---",
      "props:",
      "  type: object",
      "  properties:",
      "    source: { type: string }",
      "  required: [source]",
      "  additionalProperties: false",
      "returns:",
      "  type: string",
      "---",
      "",
      '<Fail message="nothing was approved" />',
      "",
      "<Return value={props.source} />",
      "",
    ].join("\n");

    const source = ["# The program", "", '<Effect name="four" />', ""].join("\n");
    const run = yield* runDocument({
      source: invoking(source),
      declarations: [expanding({ source: refusing, digest: sourceDigest(refusing) })],
      performed,
    });

    expect(run.failure).toContain("nothing was approved");
    expect(performed).toEqual([]);
    expect(run.output).not.toContain("# The program");
  });

  it("ES5: a root `returns` and a root-props mismatch each refuse before an effect", function* () {
    const valued = [
      "---",
      "returns:",
      "  type: string",
      "---",
      "",
      '<Effect name="never" />',
      "",
      '<Return value="x" />',
      "",
    ].join("\n");

    const valuedPerformed: string[] = [];
    const valuedRun = yield* runDocument({
      source: invoking(valued),
      declarations: [expanding()],
      performed: valuedPerformed,
    });

    expect(valuedRun.failure).toContain("declares `returns`");
    expect(valuedPerformed).toEqual([]);

    const demanding = [
      "---",
      "props:",
      "  type: object",
      "  properties:",
      "    who: { type: string }",
      "  required: [who]",
      "  additionalProperties: false",
      "---",
      "",
      '<Effect name="never" />',
      "",
    ].join("\n");

    const demandingPerformed: string[] = [];
    const demandingRun = yield* runDocument({
      source: invoking(demanding),
      declarations: [expanding()],
      performed: demandingPerformed,
    });

    expect(demandingRun.failure).toContain("who");
    expect(demandingPerformed).toEqual([]);
  });

  it("ES6: a partial journal resumes inside the source without repeating an effect", function* () {
    const source = ["# The program", "", "the program ran.", "", '<Effect name="six" />', ""].join(
      "\n",
    );
    const first: string[] = [];
    const one = yield* runDocument({
      source: invoking(source),
      declarations: [expanding()],
      performed: first,
    });

    expect(one.failure).toBe(undefined);
    expect(first).toEqual(["six"]);

    const second: string[] = [];
    const two = yield* runDocument({
      source: invoking(source),
      declarations: [expanding()],
      performed: second,
      stream: yield* continuing(one.stream),
    });

    expect(two.failure).toBe(undefined);
    // The completed effect was restored rather than performed again, and the
    // document produced the same text.
    expect(second).toEqual([]);
    expect(two.output).toBe(one.output);
  });

  it("ES6b: the source is its own flow, not the flow that wrote the element", function* () {
    const performed: string[] = [];
    // A stray `<Break />` in the program. It belongs to a `<Loop>` written in
    // the program, and there is none — so it is reported there rather than
    // silently ending the caller's loop.
    const source = ["# The program", "", "<Break />", "", '<Effect name="stray" />', ""].join("\n");
    const run = yield* runDocument({
      source: [
        "before",
        "",
        "<Loop max={3}>",
        `<Let as="src" value={${JSON.stringify(source)}} />`,
        "<Program source={src} />",
        '<Effect name="iteration" />',
        "</Loop>",
        "",
      ].join("\n"),
      declarations: [expanding()],
      performed,
    });

    // Reported where it was written rather than ending the caller's loop, which
    // is what a `<Break />` reaching the enclosing frame would have done
    // silently — one iteration, no diagnostic, and a document that looked fine.
    expect(run.failure).toContain("<Break> must be written inside a <Loop>");
    expect(performed).toEqual([]);
  });

  it("ES7: the expansion imports no second root", function* () {
    const performed: string[] = [];
    const run = yield* runDocument({
      source: invoking(["# The program", "", '<Effect name="seven" />', ""].join("\n")),
      declarations: [expanding()],
      performed,
    });

    expect(run.failure).toBe(undefined);
    const roots = (yield* run.stream.readAll())
      .filter(isImport)
      .filter((event) => event.type === "yield" && event.description.name === "__root__");
    // One root import, the enclosing document's. An embedded projection that
    // started another execution would record a second.
    expect(roots).toHaveLength(1);
  });

  it("ES8: an ordinary string-valued declaration still requires `as`", function* () {
    const performed: string[] = [];
    const run = yield* runDocument({
      source: invoking(["# The program", "", '<Effect name="eight" />', ""].join("\n")),
      declarations: [program()],
      performed,
    });

    expect(run.failure).toContain("must be invoked with `as`");
    expect(performed).toEqual([]);
  });

  it("ES9: a repository component cannot ask for the disposition in frontmatter", function* () {
    const dir = yield* useTempDir();
    // The frontmatter key a document author might reach for. It is not syntax:
    // it lands in ordinary metadata and decides nothing.
    yield* writeTextFile(
      join(dir, "Opt.md"),
      [
        "---",
        "returns:",
        "  type: string",
        "returnDisposition:",
        "  kind: executable-source",
        "  sourceIdentity: <opt>",
        "---",
        "",
        '<Return value={"<Effect name=\\"nine\\" />"} />',
        "",
      ].join("\n"),
    );

    const performed: string[] = [];
    const run = yield* runDocument({
      source: ["<Opt />", ""].join("\n"),
      declarations: [expanding()],
      performed,
      includes: [dir],
    });

    expect(run.failure).toContain("must be invoked with `as`");
    expect(performed).toEqual([]);
  });

  it("ES10: a replay whose recorded disposition differs refuses", function* () {
    // The same bytes, the same origin and the same digest — and a host that no
    // longer says the return is executable source. The record pins what the run
    // was treating that return as, so this is a different contract rather than
    // the same one described more briefly.
    const quiet = ["# The program", "", "the program ran.", ""].join("\n");
    const first: string[] = [];
    const one = yield* runDocument({
      source: invoking(quiet),
      declarations: [expanding()],
      performed: first,
    });
    expect(one.failure).toBe(undefined);

    const dropped: string[] = [];
    const two = yield* runDocument({
      source: invoking(quiet),
      declarations: [program()],
      performed: dropped,
      stream: yield* continuing(one.stream),
    });

    expect(two.failure).toContain("recorded as the declared Markdown");
    expect(two.output).not.toContain("the program ran.");
    expect(dropped).toEqual([]);

    // And the other direction: a run that captured an ordinary value is not
    // continued as executable source. The effect in that source is the control
    // — a promoted replay would perform it.
    const source = ["# The program", "", '<Effect name="ten" />', ""].join("\n");
    const captured: string[] = [];
    const three = yield* runDocument({
      source: invoking(source, ' as="captured"'),
      declarations: [program()],
      performed: captured,
    });
    expect(three.failure).toBe(undefined);
    expect(captured).toEqual([]);

    const promoted: string[] = [];
    const four = yield* runDocument({
      source: invoking(source, ' as="captured"'),
      declarations: [expanding()],
      performed: promoted,
      stream: yield* continuing(three.stream),
    });

    expect(four.failure).toContain("recorded as the declared Markdown");
    expect(promoted).toEqual([]);
  });

  it("ES11: a declaration whose source returns no string cannot carry the disposition", function* () {
    const text = ["# Not a value component", ""].join("\n");
    const performed: string[] = [];
    const run = yield* runDocument({
      source: "<Program />\n",
      declarations: [expanding({ source: text, digest: sourceDigest(text), forms: ["paired"] })],
      performed,
    });

    expect(run.failure).toContain("executable-source return");
    expect(performed).toEqual([]);
  });

  it("ES12: inspection and validation describe the same contract", function* () {
    const declarations = [expanding()];

    const described = yield* inspectComponent({ name: "Program", declarations });
    expect(described.kind).toBe("markdown");
    expect(Reflect.get(Object(described), "returnDisposition")).toEqual({
      kind: "executable-source",
      sourceIdentity: SOURCE_IDENTITY,
    });

    const catalog = yield* inspectSyntax({ declarations });
    const entry = catalog.categories[1].entries.find((candidate) => candidate.name === "Program");
    expect(entry?.returnMode).toBe("value");
    expect(entry?.returnDisposition).toEqual({
      kind: "executable-source",
      sourceIdentity: SOURCE_IDENTITY,
    });

    // Validation asks the same question expansion does, so a site that needs no
    // capture here needs none there.
    const valid = yield* validateDocument({
      ...retainedSource(ROOT_PATH, '<Program source="x" />\n'),
      declarations,
    });
    expect(valid.outcome).toBe("valid");

    const ordinary = yield* validateDocument({
      ...retainedSource(ROOT_PATH, '<Program source="x" />\n'),
      declarations: [program()],
    });
    expect(ordinary.outcome).toBe("invalid");
    expect(ordinary.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "return-usage-invalid",
    );
  });
});
