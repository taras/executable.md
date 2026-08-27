/**
 * Tier CR — component registration and resolution (spec §5.3).
 *
 * What a name means is decided by one resolver, in tiers: structural syntax, a
 * reserved registration, a repository file, a registered default, nothing. These
 * drive that resolver and `registerComponents()` directly, and the end-to-end
 * cases go through `execute()` so what they assert is what a document gets.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, spawn, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { API, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import { Component } from "../src/component-api.ts";
import { collect } from "../src/collect.ts";
import { execute } from "../src/execute.ts";
import { inspectComponent } from "../src/inspect.ts";
import { ComponentRegistrationError, registerComponents } from "../src/components/registration.ts";
import type { ComponentRegistration } from "../src/components/registration.ts";
import { DEFAULT_INCLUDES, selectComponent } from "../src/components/select.ts";
import * as core from "../mod.ts";
import { CORE_ORIGIN } from "../src/components/registry.ts";
import type {
  ComponentRegistry,
  ComponentSelection,
  InvocationForm,
  Json as CoreJson,
} from "../src/types.ts";

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false };

/** A directory for one test's files, removed when the test scope closes. */
function useFixture(): Operation<string> {
  return resource(function* (provide) {
    const dir = yield* until(mkdtemp(join(tmpdir(), "cr-test-")));
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* provide(yield* until(realpath(dir)));
  });
}

/**
 * A fixture directory *relative to the process's own*, so a search path can be
 * relative. An absolute path is used verbatim, which hides any disagreement
 * about which directory a relative one is resolved against.
 */
function useLocalFixture(): Operation<string> {
  return resource(function* (provide) {
    const dir = yield* until(mkdtemp(join(process.cwd(), "cr-local-")));
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* provide(basename(dir));
  });
}

/** A registration that renders a fixed string, so selection is identifiable. */
function registration(
  name: string,
  origin: string,
  extra: Partial<ComponentRegistration> = {},
): ComponentRegistration {
  return {
    name,
    origin,
    props: NO_PROPS,
    // deno-lint-ignore require-yield
    *fn(): Operation<CoreJson> {
      return origin;
    },
    ...extra,
  };
}

/** The registry visible in the current scope. */
function currentRegistry(): Operation<ComponentRegistry> {
  return Component.operations.registry;
}

/** Resolve `name` against the current scope, looking in `dirs` for files. */
function* select(name: string, dirs: string[] = []): Operation<ComponentSelection> {
  return yield* selectComponent(name, {
    includes: dirs,
    registry: yield* currentRegistry(),
  });
}

/** The origin a selection reports, or its kind when it names none. */
function originOf(selection: ComponentSelection): string {
  if (selection.kind === "registered" && selection.origin.kind === "registered") {
    return selection.origin.origin;
  }
  if (selection.kind === "repository") {
    return selection.path;
  }
  return selection.kind;
}

/** Run `body` and report the error it threw, if any. */
function* thrown(body: () => Operation<unknown>): Operation<Error | undefined> {
  try {
    yield* body();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function run(dir: string, includes: string[] = [dir]): Operation<Json> {
  return scoped(function* () {
    // `API.Files` has no host default, and `<TempDir>` is one of the components
    // these cases resolve.
    yield* useHostFiles();
    return yield* collect(
      yield* execute({ path: join(dir, "doc.md"), stream: new InMemoryStream(), includes }),
    );
  });
}

/**
 * What one run said: its rendered text, or the failure it reported. An
 * uncaught diagnostic is the run's own outcome, and these cases are about what
 * the diagnostic names either way.
 */
function reportOf(body: () => Operation<Json>): Operation<string> {
  return (function* () {
    try {
      return String(yield* body());
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
}

describe("Tier CR — registration is validated where it is installed", () => {
  it("CR1: a structural name cannot be registered", function* () {
    const error = yield* thrown(() =>
      scoped(() => registerComponents([registration("Loop", "host")])),
    );

    expect(error).toBeInstanceOf(ComponentRegistrationError);
    expect(error?.message).toContain("structural syntax");
  });

  it("CR2: a name a document could not write is rejected", function* () {
    for (const name of ["lowercase", "", "Has-Hyphen", "Dotted.lower"]) {
      const error = yield* thrown(() =>
        scoped(() => registerComponents([registration(name, "host")])),
      );
      expect(error).toBeInstanceOf(ComponentRegistrationError);
    }
  });

  it("CR2b: a dotted name addressing a subdirectory is accepted", function* () {
    yield* registerComponents([registration("TestAgent.Scenario", "host")]);
    expect(originOf(yield* select("TestAgent.Scenario"))).toBe("host");
  });

  it("CR3: an unusable props schema fails at installation", function* () {
    const error = yield* thrown(() =>
      scoped(() =>
        registerComponents([
          registration("Widget", "host", { props: { type: "object", properties: "no" } }),
        ]),
      ),
    );

    expect(error).toBeDefined();
    expect(error?.name).toBe("PropsSchemaError");
  });

  it("CR4: an unusable returns schema fails at installation", function* () {
    const error = yield* thrown(() =>
      scoped(() =>
        registerComponents([registration("Widget", "host", { returns: { type: "nonsense" } })]),
      ),
    );

    expect(error).toBeDefined();
    expect(error?.name).toBe("ReturnSchemaError");
  });

  it("CR5: registering runs nothing and acquires nothing", function* () {
    const ran: string[] = [];
    yield* scoped(function* () {
      yield* registerComponents([
        {
          name: "Eager",
          origin: "host",
          props: NO_PROPS,
          // deno-lint-ignore require-yield
          *fn(): Operation<CoreJson> {
            ran.push("Eager");
            return "";
          },
        },
      ]);
      expect(ran).toEqual([]);
      // It is registered — the definition is there without having been invoked.
      expect(originOf(yield* select("Eager"))).toBe("host");
    });
    expect(ran).toEqual([]);
  });

  it("CR6: a rejected batch changes neither the registry nor the collision index", function* () {
    yield* registerComponents([registration("Alpha", "first")]);

    const error = yield* thrown(() =>
      registerComponents([
        registration("Beta", "second"),
        registration("Gamma", "second", { props: { type: "object", properties: 7 } }),
      ]),
    );
    expect(error).toBeDefined();

    // Nothing from the rejected batch was installed…
    expect((yield* select("Beta")).kind).toBe("unresolved");
    expect(originOf(yield* select("Alpha"))).toBe("first");

    // …and the collision index did not record it either, so the same name
    // still registers cleanly afterwards.
    yield* registerComponents([registration("Beta", "third")]);
    expect(originOf(yield* select("Beta"))).toBe("third");
  });
});

describe("Tier CR — one name per kind per scope", () => {
  it("CR7: two registrations for one name at one scope name both origins", function* () {
    const error = yield* thrown(() =>
      scoped(function* () {
        yield* registerComponents([registration("Widget", "package-a")]);
        yield* registerComponents([registration("Widget", "package-b")]);
      }),
    );

    expect(error).toBeInstanceOf(ComponentRegistrationError);
    expect(error?.message).toContain("package-a");
    expect(error?.message).toContain("package-b");
  });

  it("CR7b: a duplicate inside one batch is caught too", function* () {
    const error = yield* thrown(() =>
      scoped(() =>
        registerComponents([registration("Widget", "one"), registration("Widget", "two")]),
      ),
    );

    expect(error).toBeInstanceOf(ComponentRegistrationError);
    expect(error?.message).toContain("one");
    expect(error?.message).toContain("two");
  });

  it("CR8: a reserved and a default registration for one name coexist", function* () {
    yield* registerComponents([
      registration("Widget", "the-default"),
      registration("Widget", "the-reserved", { reserved: true }),
    ]);
    // Reserved is the higher tier, so it is what resolves.
    expect(originOf(yield* select("Widget"))).toBe("the-reserved");
  });
});

describe("Tier CR — registration is scope-local", () => {
  it("CR9/CR10: a child registration shadows its parent without a collision", function* () {
    yield* registerComponents([registration("Widget", "parent")]);
    expect(originOf(yield* select("Widget"))).toBe("parent");

    yield* scoped(function* () {
      yield* registerComponents([registration("Widget", "child")]);
      expect(originOf(yield* select("Widget"))).toBe("child");
    });

    // CR11: leaving the child restores what the parent registered.
    expect(originOf(yield* select("Widget"))).toBe("parent");
  });

  it("CR11b: leaving the only scope that registered removes the name", function* () {
    yield* scoped(function* () {
      yield* registerComponents([registration("Widget", "inner")]);
      expect(originOf(yield* select("Widget"))).toBe("inner");
    });
    expect((yield* select("Widget")).kind).toBe("unresolved");
  });

  it("CR12: siblings never see one another's registrations", function* () {
    yield* scoped(function* () {
      yield* registerComponents([registration("Widget", "left")]);
      expect(originOf(yield* select("Widget"))).toBe("left");
    });
    yield* scoped(function* () {
      yield* registerComponents([registration("Widget", "right")]);
      expect(originOf(yield* select("Widget"))).toBe("right");
    });
  });

  it("CR13: concurrent scopes stay isolated", function* () {
    const seen: string[] = [];
    yield* scoped(function* () {
      const left = yield* spawn(() =>
        scoped(function* () {
          yield* registerComponents([registration("Widget", "left")]);
          seen.push(originOf(yield* select("Widget")));
        }),
      );
      const right = yield* spawn(() =>
        scoped(function* () {
          yield* registerComponents([registration("Widget", "right")]);
          seen.push(originOf(yield* select("Widget")));
        }),
      );
      yield* left;
      yield* right;
    });

    // Sorted because the two tasks finish in whichever order they are scheduled.
    expect([...seen].sort()).toEqual(["left", "right"]);
  });
});

describe("Tier CR — resolution order", () => {
  it("CR14: structural syntax outranks everything and cannot be registered over", function* () {
    const selection = yield* select("Loop");
    expect(selection.kind).toBe("structural");
  });

  it("CR14b: Let is structural syntax and Capture is an ordinary name", function* () {
    expect((yield* select("Let")).kind).toBe("structural");

    const error = yield* thrown(() =>
      scoped(() => registerComponents([registration("Let", "host")])),
    );
    expect(error?.message).toContain("structural syntax");

    // The old spelling has no reservation left: a host may register it, and a
    // repository file named Capture.md resolves like any other component.
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "Capture.md"), "from disk\n");
    yield* scoped(function* () {
      expect((yield* select("Capture", [dir])).kind).not.toBe("structural");
    });
  });

  it("CR15: a reserved registration outranks a repository file", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "Widget.md"), "from disk\n");

    yield* scoped(function* () {
      yield* registerComponents([registration("Widget", "reserved", { reserved: true })]);
      expect(originOf(yield* select("Widget", [dir]))).toBe("reserved");
    });
  });

  it("CR16: a repository file outranks a registered default", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "Widget.md"), "from disk\n");

    yield* scoped(function* () {
      yield* registerComponents([registration("Widget", "default")]);
      const selection = yield* select("Widget", [dir]);
      expect(selection.kind).toBe("repository");
    });
  });

  it("CR16b: a repository file overrides every component core supplies", function* () {
    const dir = yield* useFixture();
    for (const name of ["Fetch", "File", "Glob", "Json", "Parse", "SafeParse", "TempDir"]) {
      yield* writeTextFile(join(dir, `${name}.md`), "mine\n");
      const selection = yield* select(name, [dir]);
      expect(selection.kind).toBe("repository");
    }
  });

  it("CR17: core's components resolve when nothing is on disk", function* () {
    const dir = yield* useFixture();
    for (const name of ["Fetch", "File", "Glob", "Json", "Parse", "SafeParse", "TempDir"]) {
      const selection = yield* select(name, [dir]);
      expect(selection.kind).toBe("registered");
      expect(originOf(selection)).toBe(CORE_ORIGIN);
    }
  });

  it("CR18: an unresolved name reports where it looked and what was registered", function* () {
    const dir = yield* useFixture();
    yield* scoped(function* () {
      yield* registerComponents([registration("Widget", "reserved-only", { reserved: true })]);
      const missing = yield* select("Absent", [dir, "elsewhere"]);
      expect(missing.kind).toBe("unresolved");
      if (missing.kind === "unresolved") {
        expect(missing.searched).toEqual([dir, "elsewhere"]);
        expect(missing.registered).toEqual([]);
      }
    });
  });

  it("CR19: Markdown wins over TypeScript, and earlier directories win", function* () {
    const first = yield* useFixture();
    const second = yield* useFixture();
    yield* writeTextFile(join(first, "Widget.ts"), "export default function*(){}\n");
    yield* writeTextFile(join(second, "Widget.md"), "second\n");

    // Within one directory .md is tried first…
    yield* writeTextFile(join(first, "Widget.md"), "first\n");
    let selection = yield* select("Widget", [first, second]);
    expect(selection.kind === "repository" && selection.path).toBe(join(first, "Widget.md"));

    // …and a whole directory is exhausted before the next one is tried.
    yield* rm(join(first, "Widget.md"));
    selection = yield* select("Widget", [first, second]);
    expect(selection.kind === "repository" && selection.path).toBe(join(first, "Widget.ts"));
  });

  it("CR20: a dotted name addresses a subdirectory", function* () {
    const dir = yield* useFixture();
    yield* ensureDir(join(dir, "TestAgent"));
    yield* writeTextFile(join(dir, "TestAgent", "Scenario.md"), "scenario\n");

    const selection = yield* select("TestAgent.Scenario", [dir]);
    expect(selection.kind === "repository" && selection.path).toBe(
      join(dir, "TestAgent", "Scenario.md"),
    );
  });
});

describe("Tier CR — installation order never decides", () => {
  /** Register the two kinds in a given order and report what resolves. */
  function* resolveWith(order: "reserved-first" | "default-first"): Operation<string> {
    return yield* scoped(function* () {
      const reserved = registration("Widget", "the-reserved", { reserved: true });
      const fallback = registration("Widget", "the-default");
      if (order === "reserved-first") {
        yield* registerComponents([reserved]);
        yield* registerComponents([fallback]);
      } else {
        yield* registerComponents([fallback]);
        yield* registerComponents([reserved]);
      }
      return originOf(yield* select("Widget"));
    });
  }

  it("CR21: reserved wins whichever order the two were installed in", function* () {
    expect(yield* resolveWith("reserved-first")).toBe("the-reserved");
    expect(yield* resolveWith("default-first")).toBe("the-reserved");
  });

  it("CR21b: a parent's reserved beats a child's default", function* () {
    yield* registerComponents([registration("Widget", "parent-reserved", { reserved: true })]);
    yield* scoped(function* () {
      yield* registerComponents([registration("Widget", "child-default")]);
      expect(originOf(yield* select("Widget"))).toBe("parent-reserved");
    });
  });

  it("CR21c: a child's reserved beats a parent's default", function* () {
    yield* registerComponents([registration("Widget", "parent-default")]);
    yield* scoped(function* () {
      yield* registerComponents([registration("Widget", "child-reserved", { reserved: true })]);
      expect(originOf(yield* select("Widget"))).toBe("child-reserved");
    });
  });

  it("CR21d: a child's reserved beats a parent's reserved", function* () {
    yield* registerComponents([registration("Widget", "parent", { reserved: true })]);
    yield* scoped(function* () {
      yield* registerComponents([registration("Widget", "child", { reserved: true })]);
      expect(originOf(yield* select("Widget"))).toBe("child");
    });
  });
});

describe("Tier CR — what a document gets", () => {
  it("CR22: a repository component replaces one of core's, end to end", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "doc.md"), "<Parse>ignored</Parse>\n");
    yield* writeTextFile(join(dir, "Parse.md"), "MINE\n");

    expect(String(yield* run(dir))).toContain("MINE");
  });

  it("CR22b: a repository Json.md replaces core's serializer, end to end", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "doc.md"), "<Json value={{ serialized: true }} />\n");
    // The override declares `value` as an ordinary prop: `captures` belongs to
    // the registration core made, and a repository file makes none.
    yield* writeTextFile(
      join(dir, "Json.md"),
      ["---", "props:", "  value: { type: object }", "---", "", "MINE"].join("\n"),
    );

    // Core's own would have rendered the object as JSON text; the repository
    // file renders a word instead, so the output says which one ran.
    const rendered = String(yield* run(dir));
    expect(rendered).toContain("MINE");
    expect(rendered).not.toContain("serialized");
  });

  // The capture belongs to the definition that was selected, not to the name.
  // An override is an ordinary Markdown component, so its `value` crosses the
  // prop JSON boundary exactly as any other component's would.
  it("CR22c: an override crosses the ordinary prop boundary, absence and all", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "doc.md"), "<Json value={undefined} />\n");
    // `required` is what makes this discriminating: on the ordinary boundary
    // this operand is an absence, so the required check is what answers it. A
    // definition treated as capturing would strip `value` before validation
    // and reach the body instead.
    yield* writeTextFile(
      join(dir, "Json.md"),
      [
        "---",
        "required: [value]",
        "props:",
        "  value: { type: 'string' }",
        "---",
        "",
        "override saw the projection",
      ].join("\n"),
    );

    // Core's `<Json>` fails this exact operand as "no JSON text", because its
    // capture is handed the authored `undefined`. The override is handed the
    // ordinary reading of the same text, where `undefined` means the prop is
    // not there — the behavior every non-capturing component has (§6.5).
    const rendered = yield* reportOf(() => run(dir));
    expect(rendered).toContain("value");
    expect(rendered).toContain("required");
    expect(rendered).not.toContain("no JSON text");
    expect(rendered).not.toContain("override saw the projection");
  });

  it("CR23: a broken local component fails instead of falling back to core's", function* () {
    const dir = yield* useFixture();
    // Core's <TempDir> renders its content, so a fall-through would succeed
    // visibly. That is what makes the failure below meaningful.
    yield* writeTextFile(join(dir, "doc.md"), "<TempDir>VISIBLE</TempDir>\n");
    yield* writeTextFile(join(dir, "TempDir.md"), "unbroken\n");
    expect(String(yield* run(dir))).toContain("unbroken");

    // Present, and unusable: the schema is not a schema.
    yield* writeTextFile(
      join(dir, "TempDir.md"),
      ["---", "props:", "  type: object", "  properties: 7", "---", "", "unbroken"].join("\n"),
    );

    const output = yield* reportOf(() => run(dir));
    expect(output).toContain("properties");
    // Neither the broken component's body nor core's component ran.
    expect(output).not.toContain("unbroken");
    expect(output).not.toContain("VISIBLE");
  });

  it("CR24: a structural name is not satisfied by a file named after it", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "doc.md"), "<Content />\n");
    yield* writeTextFile(join(dir, "Content.md"), "SHOULD NOT RENDER\n");

    const output = yield* reportOf(() => run(dir));
    expect(output).not.toContain("SHOULD NOT RENDER");
    expect(output).toContain("reserved");
  });

  // Selection stats against the process's directory, so loading has to as well.
  // `<TempDir>` rebinds the contextual `Env.cwd` for its content, and a
  // repository component written inside it must still resolve and load.
  //
  // The search path has to be *relative* for this to bite: an absolute one is
  // used verbatim and never consults a working directory at all, which is why
  // the fixture lives under the process's own directory.
  it("CR24b: a relative repository component loads inside a rebound cwd", function* () {
    const dir = yield* useLocalFixture();
    yield* writeTextFile(join(dir, "doc.md"), "<TempDir>\n<Widget />\n</TempDir>\n");
    yield* writeTextFile(
      join(dir, "Widget.ts"),
      [
        "export const props = { type: 'object', properties: {}, additionalProperties: false };",
        "export default function*() { return 'LOADED'; }",
      ].join("\n"),
    );

    expect(String(yield* run(dir))).toContain("LOADED");
  });
});

describe("Tier CR — inspection describes without running", () => {
  it("CR25: inspection and execution agree on one of core's components", function* () {
    const dir = yield* useFixture();
    const info = yield* inspectComponent({ name: "Glob", includes: [dir] });
    const selection = yield* select("Glob", [dir]);

    expect(info.kind).toBe("registered");
    expect(originOf(selection)).toBe(CORE_ORIGIN);
    if (info.kind === "registered" && info.origin.kind === "registered") {
      expect(info.origin.origin).toBe(CORE_ORIGIN);
      expect(info.origin.reserved).toBe(false);
    }
  });

  it("CR25b: Fetch is an ordinary core default with a closed props schema", function* () {
    const dir = yield* useFixture();
    const info = yield* inspectComponent({ name: "Fetch", includes: [dir] });

    expect(info.kind).toBe("registered");
    if (info.kind !== "registered" || info.origin.kind !== "registered") {
      throw new Error("Fetch did not inspect as a registered component");
    }
    expect(info.origin.origin).toBe(CORE_ORIGIN);
    // Not reserved: a repository file of the same name is chosen ahead of it.
    expect(info.origin.reserved).toBe(false);
    expect(info.props).toEqual({
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        timeout: { type: "string" },
      },
      required: ["url"],
      additionalProperties: false,
    });
    // No `returns`: declaring one would make `as` mandatory, and the
    // uncaptured mode is where a status decides whether the document carries on.
    expect("returns" in info).toBe(false);
  });

  it("CR25c: Json is an ordinary core default taking one captured operand", function* () {
    const dir = yield* useFixture();
    const info = yield* inspectComponent({ name: "Json", includes: [dir] });

    expect(info.kind).toBe("registered");
    if (info.kind !== "registered" || info.origin.kind !== "registered") {
      throw new Error("Json did not inspect as a registered component");
    }
    expect(info.origin.origin).toBe(CORE_ORIGIN);
    // Not reserved: `Json.md` above is chosen ahead of it.
    expect(info.origin.reserved).toBe(false);
    // Closed and empty: `value` is a capture, and a schema cannot describe a
    // value it never sees.
    expect(info.props).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect("returns" in info).toBe(false);

    const selection = yield* select("Json", [dir]);
    if (selection.kind !== "registered") {
      throw new Error("Json did not select as a registered component");
    }
    expect(selection.definition.captures).toEqual(["value"]);
  });

  it("CR26: a structural name inspects as the construct, with no definition", function* () {
    const info = yield* inspectComponent({ name: "Each" });
    expect(info.kind).toBe("structural");
    expect(info.kind === "structural" && info.construct).toBe("Each");
  });

  it("CR27: inspecting a repository TypeScript component does not import it", function* () {
    const dir = yield* useFixture();
    // Importing this would throw at module scope; inspection must not.
    yield* writeTextFile(join(dir, "Widget.ts"), 'throw new Error("imported!");\n');

    const info = yield* inspectComponent({ name: "Widget", includes: [dir] });
    expect(info.kind).toBe("function");
    expect(info.kind === "function" && info.origin.kind === "repository" && info.origin.path).toBe(
      join(dir, "Widget.ts"),
    );
  });

  it("CR28: a Markdown component inspects to its declared schemas", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(
      join(dir, "Widget.md"),
      [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    who:",
        "      type: string",
        "---",
        "",
        "hi",
      ].join("\n"),
    );

    const info = yield* inspectComponent({ name: "Widget", includes: [dir] });
    expect(info.kind).toBe("markdown");
    if (info.kind === "markdown") {
      expect(Object.keys((info.props.properties ?? {}) as Record<string, unknown>)).toEqual([
        "who",
      ]);
    }
  });

  it("CR29: an unresolved name inspects to where it looked", function* () {
    const dir = yield* useFixture();
    const info = yield* inspectComponent({ name: "Absent", includes: [dir] });
    expect(info.kind).toBe("unresolved");
    expect(info.kind === "unresolved" && info.searched).toEqual([dir]);
  });
});

describe("Tier CR — selection is journaled", () => {
  /** Every component name the journal recorded an import for, in order. */
  function* imported(stream: InMemoryStream): Operation<string[]> {
    const events = yield* stream.readAll();
    const names: string[] = [];
    for (const event of events) {
      if (event.type === "yield" && event.description.type === "import_component") {
        names.push(String(event.description.name));
      }
    }
    return names;
  }

  function runOn(dir: string, stream: InMemoryStream): Operation<Json> {
    return scoped(function* () {
      yield* useHostFiles();
      return yield* collect(yield* execute({ path: join(dir, "doc.md"), stream, includes: [dir] }));
    });
  }

  it("CR30: a component core supplies is journaled, and replays", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "doc.md"), "<TempDir>inside</TempDir>\n");

    const stream = new InMemoryStream();
    const first = String(yield* runOn(dir, stream));
    expect(yield* imported(stream)).toEqual(["__root__", "TempDir"]);

    // A replay restores the recorded run rather than performing it again, so
    // the journal is not appended to a second time.
    expect(String(yield* runOn(dir, stream))).toBe(first);
    expect(yield* imported(stream)).toEqual(["__root__", "TempDir"]);
  });

  it("CR31: a repository override records its path and content, and replays", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "doc.md"), "<Parse>x</Parse>\n");
    yield* writeTextFile(join(dir, "Parse.md"), "MINE\n");

    /** Run with a recorder over the contextual filesystem's `stat`. */
    function* probing(stream: InMemoryStream): Operation<{ output: string; probed: string[] }> {
      const probed: string[] = [];
      const output = yield* scoped(function* () {
        yield* API.Fs.around({
          *stat([path], next) {
            probed.push(path);
            return yield* next(path);
          },
        });
        return String(yield* runOn(dir, stream));
      });
      return { output, probed };
    }

    const stream = new InMemoryStream();
    const first = yield* probing(stream);
    expect(first.output).toContain("MINE");
    // The recorder works: selecting the override probed the filesystem.
    expect(first.probed).toContain(join(dir, "Parse.md"));

    // The journal holds the path and the content, so a replay never goes back
    // to disk — the same recorder now sees nothing.
    const again = yield* probing(stream);
    expect(again.output).toBe(first.output);
    expect(again.probed).toEqual([]);
  });

  /** The journal without the root's close, so the next run continues live. */
  function* partial(stream: InMemoryStream): Operation<InMemoryStream> {
    const events = yield* stream.readAll();
    return new InMemoryStream(
      events.filter((event) => !(event.type === "close" && event.coroutineId === "root")),
    );
  }

  /** Execute with `registrations` installed in the surrounding scope. */
  function runRegistered(
    dir: string,
    stream: InMemoryStream,
    registrations: readonly ComponentRegistration[],
  ): Operation<Json> {
    return scoped(function* () {
      yield* registerComponents(registrations);
      return yield* collect(yield* execute({ path: join(dir, "doc.md"), stream, includes: [dir] }));
    });
  }

  it("CR32: a reserved registration is journaled by origin, and replays", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "doc.md"), "<Widget />\n");
    const reserved = [registration("Widget", "host-a", { reserved: true })];

    const stream = new InMemoryStream();
    const first = String(yield* runRegistered(dir, stream, reserved));
    expect(first).toContain("host-a");
    expect(yield* imported(stream)).toEqual(["__root__", "Widget"]);

    expect(String(yield* runRegistered(dir, stream, reserved))).toBe(first);
  });

  it("CR33: a recorded registration that is gone fails explicitly", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "doc.md"), "<Widget />\n");

    const stream = new InMemoryStream();
    yield* runRegistered(dir, stream, [registration("Widget", "host-a")]);

    // Resume with nothing registered: the recorded origin names an
    // implementation this run does not have.
    const resumed = yield* reportOf(() =>
      scoped(function* () {
        return yield* collect(
          yield* execute({
            path: join(dir, "doc.md"),
            stream: yield* partial(stream),
            includes: [dir],
          }),
        );
      }),
    );

    expect(resumed).toContain("host-a");
    expect(resumed).toContain("not registered in this run");
  });

  it("CR34: a recorded registration replaced by another fails explicitly", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "doc.md"), "<Widget />\n");

    const stream = new InMemoryStream();
    yield* runRegistered(dir, stream, [registration("Widget", "host-a")]);

    // Resume where the same name is registered by somebody else. Quietly
    // invoking that one is exactly what the check prevents, so its output is
    // distinguishable from its origin.
    const other: ComponentRegistration = {
      name: "Widget",
      origin: "host-b",
      props: NO_PROPS,
      // deno-lint-ignore require-yield
      *fn(): Operation<CoreJson> {
        return "RENDERED-BY-B";
      },
    };
    const truncated = yield* partial(stream);
    const resumed = yield* reportOf(() => runRegistered(dir, truncated, [other]));

    // The printed error names both the recorded origin and the one found instead…
    expect(resumed).toContain("host-a");
    expect(resumed).toContain("host-b");
    // …and the component that was found was never invoked.
    expect(resumed).not.toContain("RENDERED-BY-B");
  });

  // §1: a capture is a prop the schema never sees, so the registration must
  // reject every shape that would make that ambiguous or unusable.
  it("CR-CAP: rejects captures a registration cannot honor", function* () {
    const bad = [
      // Also a schema property: a schema cannot describe a value it never sees.
      {
        props: { type: "object", properties: { actual: { type: "string" } } },
        captures: ["actual"],
      },
      // The engine's own props.
      { props: NO_PROPS, captures: ["as"] },
      { props: NO_PROPS, captures: ["slot"] },
      // Not a usable prop name.
      { props: NO_PROPS, captures: ["actual", "actual"] },
      { props: NO_PROPS, captures: [""] },
    ];

    for (const extra of bad) {
      let thrown: unknown;
      yield* scoped(function* () {
        try {
          yield* registerComponents([registration("Widget", "host", extra)]);
        } catch (error) {
          thrown = error;
        }
      });
      expect(thrown).toBeInstanceOf(ComponentRegistrationError);
    }
  });

  // Forms are documentation, and documentation nobody can act on is worse than
  // none: one canonical spelling per meaning means a catalog is comparable
  // without normalizing it first.
  it("CR-FORM: rejects a forms declaration that is not canonical", function* () {
    const bad: unknown[] = [
      [],
      ["paired", "self-closing"],
      ["paired", "paired"],
      ["self-closing", "self-closing"],
      ["either"],
      ["self-closing", "paired", "self-closing"],
      "paired",
      null,
    ];

    for (const forms of bad) {
      let thrown: unknown;
      yield* scoped(function* () {
        const declaration = registration("Widget", "host");
        // Planted rather than declared: a host reaches registration from
        // JavaScript, so the refusal exists for what the compiler could not
        // have stopped.
        Reflect.set(declaration, "forms", forms);
        try {
          yield* registerComponents([declaration]);
        } catch (error) {
          thrown = error;
        }
      });
      expect(thrown).toBeInstanceOf(ComponentRegistrationError);
      expect(String(thrown)).toContain("self-closing");
    }
  });

  it("CR-FORM: accepts the three canonical spellings, and carries them through", function* () {
    const canonical: readonly (readonly InvocationForm[] | undefined)[] = [
      undefined,
      ["self-closing"],
      ["paired"],
      ["self-closing", "paired"],
    ];

    for (const forms of canonical) {
      yield* scoped(function* () {
        yield* registerComponents([
          registration("Widget", "host", forms === undefined ? {} : { forms }),
        ]);
        const selected = yield* select("Widget", []);
        expect(selected.kind).toBe("registered");
        if (selected.kind === "registered") {
          // Omission stays omission on the definition: absence is what every
          // registration written before forms existed already means.
          expect(selected.definition.forms).toEqual(forms);
        }
      });
    }
  });
});

describe("Tier CR — includes are the configured contribution to the search path", () => {
  it("CR36: DEFAULT_INCLUDES is the default the resolver falls back to, and core exports it", function* () {
    expect(DEFAULT_INCLUDES).toEqual(["components", "."]);
    expect(Object.keys(core)).toContain("DEFAULT_INCLUDES");
  });

  it("CR37: an omitted includes searches the defaults, an empty one searches nothing", function* () {
    const omitted = yield* selectComponent("AbsentByDefault", {
      registry: yield* currentRegistry(),
    });
    expect(omitted.kind).toBe("unresolved");
    if (omitted.kind === "unresolved") {
      expect(omitted.searched).toEqual([...DEFAULT_INCLUDES]);
      // The reported list is this selection's own, so reading it cannot edit
      // the default every later selection falls back to.
      omitted.searched.push("smuggled");
      expect(DEFAULT_INCLUDES).toEqual(["components", "."]);
    }

    // An explicitly empty contribution is not absence: `??` keeps it, where
    // `||` would widen it back to the defaults.
    const empty = yield* select("AbsentByDefault", []);
    expect(empty.kind).toBe("unresolved");
    if (empty.kind === "unresolved") {
      expect(empty.searched).toEqual([]);
    }
  });
});
