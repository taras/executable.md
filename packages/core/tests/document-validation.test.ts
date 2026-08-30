/**
 * Tier DV — validating a supplied document without executing it.
 *
 * The boundary answers one question: is this authored program structure, as far
 * as anything decidable without running it can say? These rows drive
 * `validateDocument()` against a stubbed contextual filesystem, so what a row
 * asserts is the versioned data the operation returned and the exact reads it
 * made to produce it.
 *
 * The filesystem is stubbed at `API.Fs` rather than with a shared helper
 * because every read is evidence here: a source is read once by identity, a
 * repository `.ts` component is never read at all, and nothing the document
 * authored is ever written. Every effectful boundary a document could reach is
 * installed as a refusal, so an execution that started anywhere would fail the
 * run rather than pass unnoticed.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import type { DirectoryEntry, LinkStatResult, StatResult } from "@executablemd/runtime";

import {
  bodyStructureFacts,
  renderBodyStructure,
  validateBodyStructure,
} from "../src/body-structure.ts";
import { parseMarkdownDefinition } from "../src/definition.ts";
import { asText, completion, failureMessage } from "./helpers.ts";
import {
  documentValidationCodeRank,
  inlineSource,
  registerComponents,
  retainedSource,
  validateDocument,
} from "../mod.ts";
import type {
  DocumentValidation,
  DocumentValidationCode,
  DocumentValidationDiagnostic,
  InvocationOpacityReason,
  InvocationSite,
  InvocationValidation,
  ValidateDocumentOptions,
  ValidateDocumentSettings,
} from "../mod.ts";
import type { IdentityComponent } from "../host.ts";

/** A stubbed tree: working-directory-relative path to file content. */
type Tree = Record<string, string>;

const MISSING: StatResult = { exists: false, isFile: false, isDirectory: false };

/**
 * What the run was allowed to do, and what it actually did.
 *
 * `reads` is appended in read order, so "once per path" and "never imported"
 * are both read off the same list. `effects` records any refused
 * boundary that fired at all — it stays empty, and a row that finds anything in
 * it has found an execution.
 */
interface Probe {
  readonly reads: string[];
  readonly effects: string[];
}

function probe(): Probe {
  return { reads: [], effects: [] };
}

function resolve(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  return segments.length === 0 ? "." : segments.join("/");
}

/** Paths whose read fails, so an unreadable source is a real trap. */
const UNREADABLE = "Unreadable.md";

/**
 * The contextual filesystem, and every other boundary a document could reach.
 *
 * Reading is the only thing validation may do, so reading is the only thing
 * answered: every write, removal, enumeration, subprocess, fetch and eval
 * compilation records itself and then throws.
 */
function* useEnvironment(tree: Tree, seen: Probe): Operation<void> {
  const refuse = (what: string) => {
    seen.effects.push(what);
    throw new Error(`validation reached ${what}`);
  };
  yield* API.Fs.around({
    // deno-lint-ignore require-yield
    *readTextFile([path]: [string]) {
      seen.reads.push(resolve(path));
      if (resolve(path) === UNREADABLE) {
        throw new Error(`EACCES: permission denied, open '${path}'`);
      }
      const content = tree[resolve(path)];
      if (content === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return content;
    },
    // deno-lint-ignore require-yield
    *stat([path]: [string]): Operation<StatResult> {
      const key = resolve(path);
      if (key === UNREADABLE || tree[key] !== undefined) {
        return { exists: true, isFile: true, isDirectory: false };
      }
      return MISSING;
    },
    // deno-lint-ignore require-yield
    *lstat([path]: [string]): Operation<LinkStatResult> {
      const found = tree[resolve(path)] !== undefined;
      return { exists: found, isFile: found, isDirectory: false, isSymbolicLink: false };
    },
    // deno-lint-ignore require-yield
    *readDirectory([path]: [string]): Operation<DirectoryEntry[]> {
      return refuse(`readDirectory(${path})`);
    },
    // deno-lint-ignore require-yield
    *glob(): Operation<never> {
      return refuse("glob");
    },
    // deno-lint-ignore require-yield
    *writeTextFile([path]: [string, string]): Operation<never> {
      return refuse(`writeTextFile(${path})`);
    },
    // deno-lint-ignore require-yield
    *ensureDir([path]: [string]): Operation<never> {
      return refuse(`ensureDir(${path})`);
    },
    // deno-lint-ignore require-yield
    *rename([from]: [string, string]): Operation<never> {
      return refuse(`rename(${from})`);
    },
    // deno-lint-ignore require-yield
    *remove([path]: [string, unknown?]): Operation<never> {
      return refuse(`remove(${path})`);
    },
  });
  yield* API.Process.around({
    // deno-lint-ignore require-yield
    *exec(): Operation<never> {
      return refuse("exec");
    },
  });
  yield* API.Fetch.around({
    // deno-lint-ignore require-yield
    *fetch(): Operation<never> {
      return refuse("fetch");
    },
  });
  yield* API.Env.around({
    // deno-lint-ignore require-yield
    *compile(): Operation<never> {
      return refuse("compile");
    },
  });
}

interface Scenario extends ValidateDocumentSettings {
  /** Files the contextual working directory holds. */
  readonly tree?: Tree;
  /** Registrations installed in the calling scope, as a host would install. */
  readonly registrations?: readonly Parameters<typeof registerComponents>[0][number][];
}

/** Validate one supplied root against a scenario, and report what was reached. */
function validating(
  options: ValidateDocumentOptions,
  scenario: Scenario = {},
): Operation<{ result: DocumentValidation; seen: Probe }> {
  return scoped(function* () {
    const seen = probe();
    yield* useEnvironment(scenario.tree ?? {}, seen);
    if (scenario.registrations !== undefined) {
      yield* registerComponents(scenario.registrations);
    }
    const result = yield* validateDocument(options);
    return { result, seen };
  });
}

/** Validate supplied text, which is the shape most rows use. */
function validateText(
  source: string,
  scenario: Scenario = {},
  settings: ValidateDocumentSettings = {},
): Operation<{ result: DocumentValidation; seen: Probe }> {
  const { tree: _tree, registrations: _registrations, ...carried } = scenario;
  return validating({ ...inlineSource(source), ...carried, ...settings }, scenario);
}

function codes(result: DocumentValidation): DocumentValidationCode[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function names(result: DocumentValidation): string[] {
  return result.invocations.map((invocation) => invocation.name);
}

function outcomes(result: DocumentValidation): string[] {
  return result.invocations.map((invocation) => invocation.outcome);
}

function only(result: DocumentValidation): InvocationValidation {
  expect(result.invocations).toHaveLength(1);
  return result.invocations[0]!;
}

function named(result: DocumentValidation, name: string): InvocationValidation {
  const found = result.invocations.find((invocation) => invocation.name === name);
  if (found === undefined) {
    throw new Error(`no invocation named ${name} in [${names(result).join(", ")}]`);
  }
  return found;
}

function diagnosticsOf(
  result: DocumentValidation,
  invocation: InvocationValidation,
): DocumentValidationDiagnostic[] {
  if (invocation.outcome !== "invalid") {
    throw new Error(`<${invocation.name} /> is ${invocation.outcome}, not invalid`);
  }
  return invocation.diagnosticIndexes.map((index) => result.diagnostics[index]!);
}

/** An identity component whose factory ends the run if anything calls it. */
function refusingIdentity(name: string, extra: Partial<IdentityComponent> = {}): IdentityComponent {
  return {
    name,
    origin: `test:${name}`,
    props: {
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
      additionalProperties: false,
    },
    description: `Declares ${name}.`,
    factory() {
      throw new Error(`identity factory for ${name} was called`);
    },
    ...extra,
  } as IdentityComponent;
}

const WIDGET = [
  "---",
  "props:",
  "  title:",
  "    type: string",
  "required: [title]",
  "---",
  "",
  "Widget {props.title}",
  "",
].join("\n");

describe("Tier DV: resolution and schemas", () => {
  it("DV1: an unresolved name is invalid, has no origin, and starts nothing", function* () {
    const { result, seen } = yield* validateText("<DefinitelyMissing />\n");

    expect(result.version).toBe(1);
    expect(result.outcome).toBe("invalid");
    expect(codes(result)).toEqual(["component-unresolved"]);
    expect(result.diagnostics[0]!.component).toBe("DefinitelyMissing");
    expect(result.diagnostics[0]!.message).toContain("Cannot resolve component: DefinitelyMissing");

    const invocation = only(result);
    expect(invocation.outcome).toBe("invalid");
    expect(invocation.outcome === "invalid" ? invocation.origin : "unreached").toBeUndefined();
    expect(invocation.outcome === "invalid" && invocation.diagnosticIndexes).toEqual([0]);
    expect(seen.effects).toEqual([]);
  });

  it("DV2: a missing required prop on a registered component is a schema failure", function* () {
    const { result, seen } = yield* validateText("<File />\n");

    expect(codes(result)).toEqual(["props-invalid"]);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic!.component).toBe("File");
    expect(diagnostic!.issues).toEqual([
      {
        instancePath: "",
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "path" },
        message: "must have required property 'path'",
      },
    ]);
    expect(diagnostic!.position?.line).toBe(1);

    const invocation = only(result);
    expect(invocation.outcome).toBe("invalid");
    expect(invocation.origin).toEqual({
      kind: "registered",
      origin: "@executablemd/core",
      reserved: false,
    });
    expect(seen.effects).toEqual([]);
  });

  it("DV3: structural, registered, declared and included components all pass", function* () {
    const source = [
      "<If condition={true}>",
      "<TempDir>held</TempDir>",
      "</If>",
      "",
      '<Declared label="ready" />',
      "",
      '<Widget title="hello" />',
      "",
    ].join("\n");

    const { result, seen } = yield* validateText(source, {
      tree: { "components/Widget.md": WIDGET },
      components: [refusingIdentity("Declared")],
      includes: ["components", "."],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.outcome).toBe("valid");
    expect(names(result)).toEqual(["If", "TempDir", "Declared", "Widget"]);
    expect(outcomes(result)).toEqual(["valid", "valid", "valid", "valid"]);
    expect(named(result, "If").origin).toEqual({ kind: "structural", construct: "If" });
    expect(named(result, "Declared").origin).toEqual({
      kind: "registered",
      origin: "test:Declared",
      reserved: false,
    });
    expect(named(result, "Widget").origin).toEqual({
      kind: "repository",
      path: "components/Widget.md",
    });
    expect(seen.effects).toEqual([]);
  });
});

describe("Tier DV: recursive Markdown sources", () => {
  const WRAPPER = ["<If condition={ready}>", "<DefinitelyMissing />", "</If>", ""].join("\n");

  it("DV4: a defect beneath control flow in a definition reports that source", function* () {
    const { result, seen } = yield* validateText("<Wrapper />\n", {
      tree: { "components/Wrapper.md": WRAPPER },
    });

    expect(codes(result)).toEqual(["component-unresolved"]);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic!.position?.path).toBe("components/Wrapper.md");
    expect(diagnostic!.position?.line).toBe(2);
    expect(names(result)).toEqual(["Wrapper", "If", "DefinitelyMissing"]);
    expect(named(result, "Wrapper").outcome).toBe("valid");
    expect(named(result, "If").outcome).toBe("valid");
    expect(named(result, "DefinitelyMissing").outcome).toBe("invalid");
    // The branch is authored structure, not a decision: nothing evaluated
    // `ready`, so no eval block was ever compiled.
    expect(seen.effects).toEqual([]);
  });

  it("DV5: views are root-first, then FIFO, each path read once, and a cycle terminates", function* () {
    const tree = {
      "components/Alpha.md": "<Shared />\n\n<Alpha />\n",
      "components/Beta.md": "<Shared />\n",
      "components/Shared.md": "shared\n",
    };

    const forward = yield* validateText("<Alpha />\n\n<Beta />\n", { tree });
    expect(names(forward.result)).toEqual(["Alpha", "Beta", "Shared", "Alpha", "Shared"]);
    expect(forward.result.outcome).toBe("valid");
    expect(forward.seen.reads.filter((path) => path.endsWith(".md")).sort()).toEqual([
      "components/Alpha.md",
      "components/Beta.md",
      "components/Shared.md",
    ]);

    const reversed = yield* validateText("<Beta />\n\n<Alpha />\n", { tree });
    expect(names(reversed.result)).toEqual(["Beta", "Alpha", "Shared", "Shared", "Alpha"]);
  });

  it("DV5: a targeted root and a component selecting its path are two views of one read", function* () {
    const shared = [
      "# Chosen",
      "",
      "<Foo />",
      "",
      "# Other",
      "",
      "<If condition={true}>",
      "<Output>bad</Output>",
      "</If>",
      "",
    ].join("\n");

    const { result, seen } = yield* validating(
      retainedSource("components/Foo.md", shared, { target: "Chosen" }),
      { tree: { "components/Foo.md": shared }, includes: ["components"] },
    );

    // The root was asked about one section, and its projection is clean. The
    // `<Foo />` written there selects the *whole* definition, whose body puts
    // an `<Output>` where the contract does not allow one.
    expect(codes(result)).toEqual(["body-shape-invalid"]);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic!.component).toBe("Output");
    expect(diagnostic!.position?.path).toBe("components/Foo.md");
    expect(result.outcome).toBe("invalid");

    // Both `<Foo />` sites — the one in the projection and the one in the full
    // definition — are invalid against that one diagnostic.
    for (const invocation of result.invocations.filter((found) => found.name === "Foo")) {
      expect(diagnosticsOf(result, invocation)).toEqual([diagnostic]);
    }
    // The projection is source zero and the full definition follows it in FIFO
    // order; selecting the path a second time reuses that view rather than
    // scanning it again.
    expect(names(result)).toEqual(["Foo", "Foo", "If", "Output"]);

    // One read, two views: the retained bytes answered both parses, and nothing
    // the document wrote was executed to find any of this out.
    expect(seen.reads).toEqual([]);
    expect(seen.effects).toEqual([]);
  });

  it("DV5: an untargeted root is the full-definition view of its own path", function* () {
    const body = "<Foo />\n";

    // The root is untargeted, so its body is the whole file and it *is* this
    // path's full-definition view. A second scan of that view would show up as
    // a second `Foo` record.
    const retained = yield* validating(retainedSource("components/Foo.md", body), {
      tree: { "components/Foo.md": body },
      includes: ["components"],
    });

    expect(names(retained.result)).toEqual(["Foo"]);
    expect(retained.result.outcome).toBe("valid");
    expect(named(retained.result, "Foo").origin).toEqual({
      kind: "repository",
      path: "components/Foo.md",
    });
    expect(retained.seen.reads).toEqual([]);

    // Read from a path, the same identity is read exactly once: the invocation
    // finds the root already in the source cache.
    const fromFile = yield* validating(
      { path: "components/Foo.md" },
      { tree: { "components/Foo.md": body }, includes: ["components"] },
    );

    expect(names(fromFile.result)).toEqual(["Foo"]);
    expect(fromFile.seen.reads).toEqual(["components/Foo.md"]);
  });
});

describe("Tier DV: structural facts and the records that own them", () => {
  it("DV4: a fact a parent discovered reaches the invocation it names", function* () {
    const { result } = yield* validateText(
      '<If condition={true}><Let as="x"><Else>no</Else></Let></If>\n',
    );

    expect(codes(result)).toEqual(["structural-usage-invalid"]);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic!.component).toBe("Else");
    expect(diagnostic!.message).toContain("<Else> must be a direct child of <If>");
    // Positioned at the `<Else>`, not at the `<If>` that read the body.
    expect(diagnostic!.position?.offset).toBe(named(result, "Else").position?.offset);

    // The element that is wrong points at it, and so does the construct whose
    // structure is malformed. The `<Let>` in between owns neither.
    expect(named(result, "Else").outcome === "invalid" && named(result, "Else").outcome).toBe(
      "invalid",
    );
    expect(diagnosticsOf(result, named(result, "Else"))).toEqual([diagnostic]);
    expect(diagnosticsOf(result, named(result, "If"))).toEqual([diagnostic]);
    expect(named(result, "Let").outcome).toBe("valid");
  });

  it("DV8: every independent static structural failure is reported", function* () {
    const { result } = yield* validateText('<If bogus="x"><Else /></If>\n');

    expect(codes(result)).toEqual([
      "structural-usage-invalid",
      "structural-usage-invalid",
      "structural-usage-invalid",
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.component)).toEqual([
      "If",
      "If",
      "Else",
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      '<If> only accepts a "condition" prop. Got: "bogus".',
      '<If> requires a "condition" prop.',
      "<Else> must have content. Use <Else>...</Else>.",
    ]);

    // The unknown prop does not hide the two failures beside it, and the
    // `<Else>` failure belongs to the `<Else>` as well as to its `<If>`.
    expect(diagnosticsOf(result, named(result, "If"))).toHaveLength(3);
    expect(diagnosticsOf(result, named(result, "Else")).map((found) => found.component)).toEqual([
      "Else",
    ]);
  });
});

describe("Tier DV: source, target and declaration failures", () => {
  const ROWS: {
    readonly id: string;
    readonly source: string;
    readonly target?: string;
    readonly code: DocumentValidationCode;
  }[] = [
    { id: "malformed source", source: "---\n: :\n---\n\nbody\n", code: "source-invalid" },
    {
      id: "no matching target",
      source: "# One\n\ntext\n",
      target: "nothing-here",
      code: "target-invalid",
    },
    {
      id: "ambiguous target",
      source: "# Same\n\na\n\n# Same\n\nb\n",
      target: "same",
      code: "target-invalid",
    },
    {
      id: "malformed frontmatter",
      source: "---\nwhen: 2020-01-01\n---\n\nbody\n",
      code: "frontmatter-invalid",
    },
    {
      id: "props declaration",
      source: "---\nprops: 5\n---\n\nbody\n",
      code: "props-declaration-invalid",
    },
    {
      id: "returns declaration",
      source: "---\nreturns: 5\n---\n\nbody\n",
      code: "returns-declaration-invalid",
    },
  ];

  for (const row of ROWS) {
    it(`DV6: a root ${row.id} maps to ${row.code} and invents no invocation`, function* () {
      const { result } = yield* validating(
        inlineSource(row.source, row.target === undefined ? {} : { target: row.target }),
      );

      expect(codes(result)).toEqual([row.code]);
      expect(result.outcome).toBe("invalid");
      expect(result.invocations).toEqual([]);
      expect(result.diagnostics[0]!.component).toBeUndefined();
      expect(result.diagnostics[0]!.position).toBeUndefined();
    });
  }

  it("DV6: an unreadable root is source-unreadable and carries no errno object", function* () {
    const { result } = yield* validating({ path: UNREADABLE });

    expect(codes(result)).toEqual(["source-unreadable"]);
    expect(result.diagnostics[0]!.message).toBe(`Cannot read document source: ${UNREADABLE}`);
    expect(result.invocations).toEqual([]);
  });

  it("DV6: a TypeScript root is an invalid document source", function* () {
    const { result } = yield* validating({ path: "root.ts" }, { tree: { "root.ts": "export {}" } });

    expect(codes(result)).toEqual(["source-invalid"]);
    expect(result.invocations).toEqual([]);
  });

  it("DV6: every caller of a failed definition shares its one diagnostic", function* () {
    const { result } = yield* validateText("<Broken />\n\n<Broken />\n", {
      tree: { "components/Broken.md": "---\nprops: 5\n---\n\nbody\n" },
    });

    expect(codes(result)).toEqual(["props-declaration-invalid"]);
    expect(result.diagnostics[0]!.component).toBe("Broken");
    expect(result.diagnostics[0]!.message).toContain("components/Broken.md:");
    expect(outcomes(result)).toEqual(["invalid", "invalid"]);
    for (const invocation of result.invocations) {
      expect(invocation.outcome === "invalid" && invocation.diagnosticIndexes).toEqual([0]);
    }
    // No body sites are invented for a definition that could not be parsed.
    expect(names(result)).toEqual(["Broken", "Broken"]);
  });

  it("DV6: an unreadable definition fails once and keeps its resolved origin", function* () {
    const { result } = yield* validateText("<Unreadable />\n", { includes: ["."] });

    expect(codes(result)).toEqual(["source-unreadable"]);
    const invocation = only(result);
    expect(invocation.outcome).toBe("invalid");
    expect(invocation.origin).toEqual({ kind: "repository", path: "Unreadable.md" });
  });
});

describe("Tier DV: static answers and opacity", () => {
  it("DV7: a dynamic schema-visible prop is opaque and a capture is not", function* () {
    const { result } = yield* validateText("<File path={target} />\n\n<Json value={anything} />\n");

    expect(result.diagnostics).toEqual([]);
    expect(result.outcome).toBe("valid");
    const file = named(result, "File");
    expect(file.outcome).toBe("not-statically-checkable");
    expect(file.outcome === "not-statically-checkable" && file.reasons).toEqual(["dynamic-props"]);
    expect(named(result, "Json").outcome).toBe("valid");
  });

  it("DV7: a definitely missing required key invalidates a partly dynamic invocation", function* () {
    const { result } = yield* validateText("<Fetch method={verb} />\n");

    const invocation = only(result);
    expect(invocation.outcome).toBe("invalid");
    const [diagnostic] = diagnosticsOf(result, invocation);
    expect(diagnostic!.code).toBe("props-invalid");
    expect(diagnostic!.issues?.map((issue) => issue.params)).toEqual([{ missingProperty: "url" }]);
  });

  it("DV7: a mixed static and dynamic object gets no partial schema conclusion", function* () {
    const { result } = yield* validateText('<Fetch url={endpoint} bogus="x" />\n');

    // `bogus` violates `additionalProperties: false`, and `url` is a value
    // nothing here can resolve. Ajv is never asked, so nothing is claimed.
    expect(result.diagnostics).toEqual([]);
    const invocation = only(result);
    expect(invocation.outcome).toBe("not-statically-checkable");
    expect(invocation.outcome === "not-statically-checkable" && invocation.reasons).toEqual([
      "dynamic-props",
    ]);
  });

  it("DV8: a definite form failure wins over a dynamic prop, in code order", function* () {
    const { result } = yield* validateText("<File.Delete extra={e}></File.Delete>\n");

    const invocation = only(result);
    expect(invocation.outcome).toBe("invalid");
    const found = diagnosticsOf(result, invocation);
    expect(found.map((diagnostic) => diagnostic.code)).toEqual([
      "invocation-form-invalid",
      "props-invalid",
    ]);
    expect(found[0]!.message).toContain("paired");
    expect(invocation.outcome === "invalid" && invocation.diagnosticIndexes).toEqual([0, 1]);
  });

  it("DV8: an independent body-shape defect wins over a dynamic prop", function* () {
    const { result } = yield* validateText("<Shape count={n} />\n", {
      tree: { "components/Shape.md": "text\n\n<If condition={true}>\n<Output>x</Output>\n</If>\n" },
    });

    const invocation = named(result, "Shape");
    expect(invocation.outcome).toBe("invalid");
    expect(diagnosticsOf(result, invocation).map((diagnostic) => diagnostic.code)).toEqual([
      "body-shape-invalid",
    ]);
  });

  it("DV9: an origin-only TypeScript component is never imported", function* () {
    const { result, seen } = yield* validateText(
      [
        "<Native />",
        "",
        "<Native flag={on} />",
        "",
        "<Native as={name} />",
        "",
        "<Native><DefinitelyMissing /></Native>",
        "",
      ].join("\n"),
      { tree: { "components/Native.ts": "export default function* () {}\n" } },
    );

    expect(seen.reads).not.toContain("components/Native.ts");

    const [plain, dynamic, captured, parent] = result.invocations.filter(
      (invocation) => invocation.name === "Native",
    );
    expect(plain!.outcome === "not-statically-checkable" && plain!.reasons).toEqual([
      "origin-only-contract",
    ]);
    expect(dynamic!.outcome === "not-statically-checkable" && dynamic!.reasons).toEqual([
      "dynamic-props",
      "origin-only-contract",
    ]);
    expect(captured!.outcome).toBe("invalid");
    expect(diagnosticsOf(result, captured!).map((diagnostic) => diagnostic.code)).toEqual([
      "capture-invalid",
    ]);
    expect(parent!.outcome).toBe("not-statically-checkable");
    expect(parent!.origin).toEqual({ kind: "repository", path: "components/Native.ts" });

    // Its children are the containing source's authored sites, and opacity
    // does not spread to them.
    expect(named(result, "DefinitelyMissing").outcome).toBe("invalid");
  });
});

describe("Tier DV: root ownership and body contracts", () => {
  it("DV10: root props are fully validated and traversal continues", function* () {
    const source = [
      "---",
      "props:",
      "  name:",
      "    type: string",
      "required: [name]",
      "---",
      "",
      "<DefinitelyMissing />",
      "",
    ].join("\n");

    const { result } = yield* validateText(source, {}, { props: {} });

    expect(codes(result)).toEqual(["props-invalid", "component-unresolved"]);
    const [rootProps] = result.diagnostics;
    expect(rootProps!.component).toBeUndefined();
    expect(rootProps!.position).toBeUndefined();
    expect(rootProps!.issues?.map((issue) => issue.params)).toEqual([{ missingProperty: "name" }]);
    expect(names(result)).toEqual(["DefinitelyMissing"]);
  });

  it("DV10: a root value body with no <Return> owns its own diagnostic", function* () {
    const source = ["---", "returns:", "  type: string", "---", "", "text\n"].join("\n");

    const { result } = yield* validateText(source);

    expect(codes(result)).toEqual(["return-usage-invalid"]);
    expect(result.diagnostics[0]!.component).toBeUndefined();
    expect(result.diagnostics[0]!.position).toBeUndefined();
    expect(result.invocations).toEqual([]);
  });

  it("DV10: a definition's body diagnostics keep its path and its authored position", function* () {
    const { result } = yield* validateText("<Shape />\n", {
      tree: { "components/Shape.md": "text\n\n<If condition={true}>\n<Output>x</Output>\n</If>\n" },
    });

    expect(codes(result)).toEqual(["body-shape-invalid"]);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic!.component).toBe("Output");
    expect(diagnostic!.position?.path).toBe("components/Shape.md");
    expect(diagnostic!.position?.line).toBe(4);
    // The invocation of the definition and the `<Output>` itself both point at
    // the one diagnostic the definition's own source produced.
    expect(named(result, "Shape").outcome === "invalid" && named(result, "Shape").outcome).toBe(
      "invalid",
    );
    expect(named(result, "Output").outcome).toBe("invalid");
  });

  it("DV10: a value component invoked without `as` is a return-usage failure", function* () {
    const { result } = yield* validateText('<Glob include={["*.md"]} />\n');

    const invocation = only(result);
    expect(diagnosticsOf(result, invocation).map((diagnostic) => diagnostic.code)).toEqual([
      "return-usage-invalid",
    ]);
  });
});

describe("Tier DV: ordering and determinism", () => {
  const NESTED = [
    "<Loop max={2}>",
    "<If condition={true}>",
    "<File />",
    "<Else>",
    "<Break />",
    "</Else>",
    "</If>",
    "</Loop>",
    "",
    '<Let as="kept">text</Let>',
    "",
  ].join("\n");

  it("DV11: every record, including structural sites, is in source order", function* () {
    const { result } = yield* validateText(NESTED);

    expect(names(result)).toEqual(["Loop", "If", "File", "Else", "Break", "Let"]);
    const offsets = result.invocations.map((invocation) => invocation.position!.offset);
    expect([...offsets].sort((left, right) => left - right)).toEqual(offsets);
    expect(named(result, "Break").outcome).toBe("valid");
  });

  it("DV11: repeated validation returns deep-equal diagnostics and invocations", function* () {
    const scenario = { tree: { "components/Widget.md": WIDGET } };
    const source = "<Widget />\n\n<DefinitelyMissing />\n\n<File path={p} />\n";

    const first = yield* validateText(source, scenario);
    const second = yield* validateText(source, scenario);

    expect(second.result).toEqual(first.result);
  });

  it("DV11: the closed code order is the one two diagnostics at a position use", function* () {
    const order: DocumentValidationCode[] = [
      "source-unreadable",
      "source-invalid",
      "target-invalid",
      "frontmatter-invalid",
      "props-declaration-invalid",
      "returns-declaration-invalid",
      "component-unresolved",
      "component-ambiguous",
      "invocation-form-invalid",
      "body-shape-invalid",
      "props-invalid",
      "binding-invalid",
      "capture-invalid",
      "return-usage-invalid",
      "structural-usage-invalid",
    ];

    const ranks = order.map(documentValidationCodeRank);
    expect(ranks).toEqual(order.map((_, index) => index));
    // The dormant code has a rank of its own: nothing reaches it while the
    // shared selector always answers with exactly one component, and the sorter
    // is ready for the day one can be ambiguous.
    expect(documentValidationCodeRank("component-ambiguous")).toBe(7);

    // The sorter reads the same ranks, so a document whose failures land at one
    // position reports them in this order rather than in discovery order.
    const { result } = yield* validateText("<File.Delete extra={e}></File.Delete>\n");
    expect(codes(result)).toEqual(["invocation-form-invalid", "props-invalid"]);
  });
});

describe("Tier DV: one parser, one rule catalog", () => {
  it("DV12: text the scanner treats as text produces no record", function* () {
    const { result } = yield* validateText("a < b, and <lowercase /> is prose.\n");

    expect(result.invocations).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("DV12: an executable block is neither an invocation nor run", function* () {
    const source = ["```sh exec", "echo hello", "```", ""].join("\n");

    const { result, seen } = yield* validateText(source);

    expect(result.invocations).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(seen.effects).toEqual([]);
  });

  it("DV12: a spread keeps the meaning execution's scanner gives it", function* () {
    const { result } = yield* validateText('<File {...rest} path="notes.md" />\n');

    // The scanner synthesizes no props from a spread, so validation must not
    // turn one into a stricter parse error or an unknown-value marker.
    expect(result.diagnostics).toEqual([]);
    expect(only(result).outcome).toBe("valid");
  });

  it("DV14: expansion's aggregate and validation's diagnostics read one catalog", function* () {
    const body = "text\n\n<If condition={true}>\n<Output>x</Output>\n</If>\n\n<Return />\n";
    const definition = yield* parseMarkdownDefinition("Shape", "components/Shape.md", body);
    const facts = bodyStructureFacts(definition.bodySegments, definition.returns);

    // One walk, two renderings: expansion's one aggregate sentence, and one
    // diagnostic per violation under its own code.
    const aggregate = validateBodyStructure(definition.bodySegments, definition.returns);
    expect(aggregate).toEqual(renderBodyStructure(facts));
    expect(aggregate!.message).toContain("Misplaced <Output> found");
    expect(aggregate!.message).toContain("<Return> requires a document or component");

    const { result } = yield* validateText("<Shape />\n", {
      tree: { "components/Shape.md": body },
    });
    expect(codes(result)).toEqual(["body-shape-invalid", "return-usage-invalid"]);
  });
});

/**
 * What expansion prints for one document, so a shared rule can be measured from
 * both sides.
 *
 * The document really runs here — in its own scope, with the same stubbed tree
 * — because the point is that the *other* consumer of the extracted rule says
 * the same thing. Under the ordinary printing mode a refused invocation renders
 * its error into the output; a root that fails outright reports it instead, so
 * both are folded into one string.
 */
function expansionPrints(source: string, scenario: Scenario = {}): Operation<string> {
  return scoped(function* () {
    const seen = probe();
    yield* useEnvironment(scenario.tree ?? {}, seen);
    if (scenario.registrations !== undefined) {
      yield* registerComponents(scenario.registrations);
    }
    const result = yield* completion({
      ...inlineSource(source),
      stream: new InMemoryStream(),
      ...(scenario.includes === undefined ? {} : { includes: [...scenario.includes] }),
    });
    return result.ok ? asText(result.value) : failureMessage(result);
  });
}

/**
 * One authored mistake, as both consumers of the rule that decides it report it.
 *
 * Expansion positions its sentence and validation carries the position as a
 * field, so the diagnostic's message is the substring: what is being measured is
 * that there is one sentence, from one decision, rather than two that happen to
 * agree today.
 */
function* bothCallersAgree(
  source: string,
  code: DocumentValidationCode,
  scenario: Scenario = {},
): Operation<string> {
  const { result } = yield* validateText(source, scenario);
  const found = result.diagnostics.find((diagnostic) => diagnostic.code === code);
  if (found === undefined) {
    throw new Error(`validation reported no ${code} in [${codes(result).join(", ")}]`);
  }
  const printed = yield* expansionPrints(source, scenario);
  expect(printed).toContain(found.message);
  return found.message;
}

describe("Tier DV: one decision, both callers", () => {
  it("DV14: an ordinary component's `as` binding name is decided once", function* () {
    // A registration reaches expansion through the function-component path...
    const registered = yield* bothCallersAgree('<TempDir as="1bad" />\n', "capture-invalid");
    expect(registered).toBe(
      'Prop "as" on <TempDir /> must be a valid JavaScript identifier. Got: "1bad"',
    );

    // ...and a Markdown component through the other one. Both ask this module.
    const markdown = yield* bothCallersAgree(
      '<Widget as="1bad" title="x" />\n',
      "capture-invalid",
      {
        tree: { "components/Widget.md": WIDGET },
      },
    );
    expect(markdown).toContain('Prop "as" on <Widget />');
  });

  it("DV14: `as` written as an expression is refused by one rule", function* () {
    const message = yield* bothCallersAgree("<TempDir as={name} />\n", "capture-invalid");
    expect(message).toBe('Prop "as" on <TempDir /> must be a string literal.');
  });

  it("DV14: a value component invoked without `as` is refused by one rule", function* () {
    const message = yield* bothCallersAgree(
      '<Glob include={["*.md"]} />\n',
      "return-usage-invalid",
    );
    expect(message).toBe(
      "<Glob /> declares `returns`, so it renders nothing and must be invoked with `as`: " +
        '<Glob as="binding" />.',
    );
  });

  it("DV14: <Answers> props and body shape are decided once", function* () {
    const prop = yield* bothCallersAgree(
      "<Answers wrong={1}>body</Answers>\n",
      "structural-usage-invalid",
    );
    expect(prop).toBe('<Answers> does not accept a "wrong" prop (allowed: delegate).');

    const delegate = yield* bothCallersAgree(
      '<Answers delegate="yes">body</Answers>\n',
      "structural-usage-invalid",
    );
    expect(delegate).toBe(
      '<Answers> delegate must be a boolean — write delegate={true}, not delegate="yes".',
    );

    const body = yield* bothCallersAgree(
      '<Answers><Answer template="t" value={1} /></Answers>\n',
      "structural-usage-invalid",
    );
    expect(body).toContain("<Answers> has no body to answer for.");
  });

  it("DV14: <Answer> props, template form and required value are decided once", function* () {
    const prop = yield* bothCallersAgree(
      "<Answers><Answer bogus={1} value={1} />\n\nbody\n</Answers>\n",
      "structural-usage-invalid",
    );
    expect(prop).toBe('<Answer> does not accept a "bogus" prop (allowed: template, value).');

    const template = yield* bothCallersAgree(
      "<Answers><Answer template={t} value={1} />\n\nbody\n</Answers>\n",
      "structural-usage-invalid",
    );
    expect(template).toContain("<Answer> template must be a literal string prop");

    const value = yield* bothCallersAgree(
      '<Answers><Answer template="t" />\n\nbody\n</Answers>\n',
      "structural-usage-invalid",
    );
    expect(value).toBe('<Answer> requires a "value" prop.');
  });
});

describe("Tier DV: the no-execution boundary", () => {
  const HOSTILE = [
    "---",
    "props:",
    "  who:",
    "    type: string",
    "---",
    "",
    '<Declared label="go" />',
    "",
    "<Exploding />",
    "",
    '<File path="written.txt">contents</File>',
    "",
    '<Elicit schema={{ type: "object" }} as="answer" />',
    "",
    "```sh exec",
    "rm -rf /",
    "```",
    "",
    "```ts eval",
    "globalThis.ran = true;",
    "```",
    "",
    "<Agent><Prompt>go</Prompt></Agent>",
    "",
    '<Fetch url="https://example.invalid" />',
    "",
    "<Deep />",
    "",
  ].join("\n");

  const DEEP = [
    '<File path="also-written.txt">more</File>',
    "",
    "```sh exec",
    "date",
    "```",
    "",
  ].join("\n");

  it("DV13: every effectful boundary stays untouched and only sources are read", function* () {
    const { result, seen } = yield* validateText(HOSTILE, {
      tree: { "components/Deep.md": DEEP },
      components: [refusingIdentity("Declared")],
      registrations: [
        {
          name: "Exploding",
          origin: "test:exploding",
          props: { type: "object", properties: {}, additionalProperties: false },
          description: "Ends the run if it is ever invoked.",
          // deno-lint-ignore require-yield
          *fn() {
            throw new Error("Exploding was invoked");
          },
        },
      ],
    });

    // Nothing was executed, compiled, spawned, fetched, elicited or written.
    expect(seen.effects).toEqual([]);
    // The only bytes read are the selected Markdown definition's: the root was
    // supplied as text, and every candidate probe is a `stat`.
    expect(seen.reads).toEqual(["components/Deep.md"]);
    // The document is answered rather than run: `<Agent>` and `<Prompt>` are
    // registered by no host here, so they are unresolved names.
    expect(codes(result)).toContain("component-unresolved");
    expect(named(result, "Exploding").outcome).toBe("valid");
    expect(named(result, "Declared").outcome).toBe("valid");
    expect(named(result, "Deep").outcome).toBe("valid");
  });

  it("DV13: an invalid host declaration is a configuration error, not a diagnostic", function* () {
    let raised: unknown;
    try {
      yield* validateText("text\n", {
        components: [refusingIdentity("Twice"), refusingIdentity("Twice")],
      });
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(Error);
    expect((raised as Error).message).toContain("two identity components");
  });
});

describe("Tier DV: the package boundary", () => {
  it("DV15: the operation and every version-1 type are package-root exports", function* () {
    const site: InvocationSite = { name: "File" };
    const reasons: readonly InvocationOpacityReason[] = ["dynamic-props", "origin-only-contract"];
    const settings: ValidateDocumentSettings = { props: {}, includes: ["components"] };
    const options: ValidateDocumentOptions = { ...inlineSource("text\n"), ...settings };
    const diagnostic: DocumentValidationDiagnostic = {
      code: "component-unresolved",
      message: "nothing here",
    };

    const { result } = yield* validating(options);
    const answered: DocumentValidation = result;
    const records: readonly InvocationValidation[] = answered.invocations;

    expect(typeof validateDocument).toBe("function");
    expect(site.name).toBe("File");
    expect(reasons).toHaveLength(2);
    expect(diagnostic.code).toBe("component-unresolved");
    expect(answered.version).toBe(1);
    expect(records).toEqual([]);
  });
});
