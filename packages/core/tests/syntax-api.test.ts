import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { type Api, createApi } from "@effectionx/context-api";
import { call, ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStream } from "@executablemd/durable-streams";
import { Syntax } from "../api.ts";
import type { SyntaxApi, SyntaxSymbols } from "../api.ts";
import {
  Syntax as RootSyntax,
  collect,
  inlineSource,
  renderSyntaxMarkdown,
  UnknownComponentError,
} from "../mod.ts";
import { executeInstalled, useSyntax } from "../host.ts";
import { selecting } from "./support/generated-selection.ts";

function symbolsOf(...names: string[]): SyntaxSymbols {
  return {
    version: 2,
    categories: [
      { kind: "structural", entries: [] },
      {
        kind: "built-in",
        entries: names.map((name) => ({
          kind: "component",
          name,
          origin: { kind: "registered", origin: "test://syntax-api", reserved: false },
          sourceKind: "registered",
          inspectability: "complete",
          forms: ["self-closing"],
          props: { type: "object", properties: {}, additionalProperties: false },
          captures: [],
          returnMode: "text",
          returns: { type: "string" },
        })),
      },
      { kind: "user-provided", entries: [] },
    ],
  };
}

function without(symbols: SyntaxSymbols, name: string): SyntaxSymbols {
  return {
    ...symbols,
    categories: [
      symbols.categories[0],
      {
        ...symbols.categories[1],
        entries: symbols.categories[1].entries.filter((entry) => entry.name !== name),
      },
      symbols.categories[2],
    ],
  };
}

function* run(text: string, stream = new InMemoryStream()): Operation<string> {
  return String(
    yield* collect(
      yield* executeInstalled({ ...inlineSource(text), stream, includes: [] }, [
        selecting({ Syntax: ["self-closing"] }),
      ]),
    ),
  );
}

describe("Tier SA — contextual Syntax", () => {
  it("SA1: exact public property types, reusable lazy defaults and a suspending transform", function* () {
    const descriptor: Api<SyntaxApi> = Syntax;
    expect(descriptor).toBe(RootSyntax);
    const directory = yield* until(mkdtemp(join(tmpdir(), "syntax-api-")));
    yield* ensure(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "marker");
    yield* writeTextFile(path, "First");
    let reads = 0;
    yield* useSyntax(function* () {
      reads += 1;
      return symbolsOf(yield* readTextFile(path), "Hidden");
    });
    expect(reads).toBe(0);
    yield* Syntax.around({
      *symbols(_args, next) {
        return without(yield* next(), "Hidden");
      },
    });
    const first = yield* descriptor.operations.text;
    expect(first).toBe(renderSyntaxMarkdown(without(symbolsOf("First", "Hidden"), "Hidden")));
    yield* writeTextFile(path, "Second");
    expect(yield* descriptor.operations.text).toContain("### `<Second>`");
    expect(reads).toBe(2);
  });

  it("SA2: symbols affect default text and named availability; text-only middleware changes neither", function* () {
    const all = symbolsOf("Kept", "Hidden");
    let source = 0;
    let effective = 0;
    yield* useSyntax(function* () {
      source += 1;
      return all;
    });
    yield* Syntax.around({
      *symbols(_args, next) {
        effective += 1;
        return without(yield* next(), "Hidden");
      },
    });
    const text = yield* Syntax.operations.text;
    expect(text).toContain("### `<Kept>`");
    expect(text).not.toContain("### `<Hidden>`");
    source = effective = 0;
    const named = yield* Syntax.operations.documentation(["Hidden", "Kept"]);
    expect(named).toContain("### `<Hidden>`");
    expect(named).toContain("**Available in this evaluation:** no");
    expect(named).toContain("**Available in this evaluation:** yes");
    expect(source).toBe(1);
    expect(effective).toBe(1);
    yield* scoped(function* () {
      yield* Syntax.around({
        *text() {
          return "custom text";
        },
      });
      expect(yield* Syntax.operations.text).toBe("custom text");
      expect(yield* Syntax.operations.symbols).toEqual(without(all, "Hidden"));
      expect(yield* Syntax.operations.documentation(["Hidden", "Kept"])).toBe(named);
    });
    expect(yield* Syntax.operations.text).toBe(text);
  });

  it("SA3: synthetic answers skip default source work and leaving the child restores its providers", function* () {
    let reads = 0;
    yield* useSyntax(function* () {
      reads += 1;
      return symbolsOf("Outer");
    });
    yield* scoped(function* () {
      yield* Syntax.around({
        *symbols() {
          return symbolsOf("Synthetic");
        },
        *documentation() {
          return "synthetic named answer";
        },
      });
      expect(yield* Syntax.operations.text).toContain("Synthetic");
      expect(yield* Syntax.operations.documentation(["Unknown"])).toBe("synthetic named answer");
      expect(reads).toBe(0);
    });
    expect(yield* Syntax.operations.text).toContain("Outer");
    expect(reads).toBe(1);
  });

  it("SA4: moving named occurrences resolve one basis each and record the final transformed answer", function* () {
    let reads = 0;
    let symbols = 0;
    yield* useSyntax(function* () {
      return symbolsOf(`Marker${++reads}`);
    });
    yield* Syntax.around({
      *symbols(_args, next) {
        symbols += 1;
        return yield* next();
      },
      *documentation([names], next) {
        return `${yield* next(names)}\nFINAL NAMED`;
      },
    });
    const stream = new InMemoryStream();
    const source = '<Syntax names={["Marker1"]} />\n<Syntax names={["Marker2"]} />\n';
    const output = yield* run(source, stream);
    expect(output).toContain("Marker1");
    expect(output).toContain("Marker2");
    expect(output.match(/FINAL NAMED/g)).toHaveLength(2);
    expect(reads).toBe(2);
    expect(symbols).toBe(2);
    const records = stream
      .snapshot()
      .filter((event) => event.type === "yield" && event.description.type === "syntax_symbols");
    expect(records).toHaveLength(2);
    for (const [index, record] of records.entries()) {
      if (record.type !== "yield" || record.result.status !== "ok") {
        throw new Error(
          `Syntax occurrence ${index + 1} saved an unexpected result: ${JSON.stringify(record)}`,
        );
      }
      expect({ occurrence: index + 1, saved: JSON.stringify(record.result.value) }).toEqual({
        occurrence: index + 1,
        saved: expect.stringContaining("FINAL NAMED"),
      });
    }
  });

  it("SA5: complete and partial replay restore bare/named final text without live providers", function* () {
    const source = '<Syntax />\n<Syntax names={["HostOnly"]} />\n';
    const stream = new InMemoryStream();
    const first = yield* scoped(function* () {
      yield* useSyntax(function* () {
        return symbolsOf("HostOnly");
      });
      yield* Syntax.around({
        *text(_args, next) {
          return `${yield* next()}\nFINAL BARE`;
        },
        *documentation([names], next) {
          return `${yield* next(names)}\nFINAL NAMED`;
        },
      });
      return yield* run(source, stream);
    });
    expect(first).toContain("FINAL BARE");
    expect(first).toContain("FINAL NAMED");
    const partial = new InMemoryStream(stream.snapshot().filter((event) => event.type !== "close"));
    yield* useSyntax(function* (): Operation<SyntaxSymbols> {
      throw new Error("live source reached on replay");
    });
    yield* Syntax.around({
      *symbols(): Operation<SyntaxSymbols> {
        throw new Error("live symbols reached on replay");
      },
      *text(): Operation<string> {
        throw new Error("live text reached on replay");
      },
      *documentation(): Operation<string> {
        throw new Error("live catalog reached on replay");
      },
    });
    expect(yield* run(source, stream)).toBe(first);
    expect(yield* run(source, partial)).toBe(first);
  });

  it("SA6: generated descriptions retain host-only metadata and never grant execution", function* () {
    let reads = 0;
    yield* useSyntax(function* () {
      reads += 1;
      return symbolsOf("HostOnly");
    });
    const output = yield* run(
      "<Evaluate text={'<Syntax names={[\"HostOnly\"]} />'} />\n<Syntax />\n",
    );
    expect(output).toContain("### `<HostOnly>`");
    expect(output).toContain("**Available in this evaluation:** no");
    expect(reads).toBe(2);
    yield* Syntax.around({
      *symbols() {
        return symbolsOf("HostOnly");
      },
    });
    const refused = yield* run("<PrintErrors><Evaluate text={'<HostOnly />'} /></PrintErrors>\n");
    expect(refused).toContain("a component this host did not admit");
    expect(refused).not.toContain("No long-form documentation");
  });

  it("SA7: a descriptive filter cannot disable an admitted generated component", function* () {
    yield* Syntax.around({
      *symbols() {
        return symbolsOf();
      },
    });
    yield* Syntax.around({
      *text() {
        return "ADMITTED SYNTAX RAN";
      },
    });
    expect(yield* run("<Evaluate text={'<Syntax />'} />\n")).toContain("ADMITTED SYNTAX RAN");
  });

  it("SA8: canonical unknown names are safe records; provider-thrown UnknownComponentError is terminal", function* () {
    const stream = new InMemoryStream();
    yield* useSyntax(function* () {
      return symbolsOf("HostOnly");
    });
    yield* run('<PrintErrors><Syntax names={["Missing"]} /></PrintErrors>\n', stream);
    const record = stream
      .snapshot()
      .find((event) => event.type === "yield" && event.description.type === "syntax_symbols");
    expect(record?.type === "yield" ? record.result.status : "absent").toBe("ok");
    expect(JSON.stringify(record)).toContain('"refused"');
    yield* scoped(function* () {
      yield* useSyntax(function* (): Operation<SyntaxSymbols> {
        throw new UnknownComponentError("provider failure");
      });
      const failed = new InMemoryStream();
      yield* run('<PrintErrors><Syntax names={["HostOnly"]} /></PrintErrors>\n', failed);
      const saved = failed
        .snapshot()
        .find((event) => event.type === "yield" && event.description.type === "syntax_symbols");
      expect(saved?.type === "yield" ? saved.result.status : "absent").toBe("err");
      expect(JSON.stringify(saved)).toContain("provider failure");
    });
  });

  it("SA9: independently constructed same-name descriptors share ordinary middleware", function* () {
    const other: Api<SyntaxApi> = createApi<SyntaxApi>("executablemd.core.syntax", {
      symbols: call(function* (): Operation<SyntaxSymbols> {
        throw new Error("foreign default must not run");
      }),
      text: call(function* (): Operation<string> {
        throw new Error("foreign default must not run");
      }),
      *documentation() {
        throw new Error("foreign default must not run");
      },
    });
    yield* other.around({
      *text() {
        return "OTHER DESCRIPTOR";
      },
    });
    expect(yield* run("<Syntax />\n")).toContain("OTHER DESCRIPTOR");
  });
});
