/**
 * Tier TX — targeted document execution and replay (spec §5.4, §6.11).
 *
 * A projected document is not a rendering exercise: what it must prove is that
 * a skipped sibling *did not run*, that a retained element kept the identity it
 * has in a full run, and that a journal recorded against one section cannot be
 * resumed as another.
 *
 * Every "did not run" assertion is made from a component that records its own
 * invocation, not from absent text — text can be absent because it rendered
 * empty. Every identity assertion reads the expansion ID the engine derived,
 * not a position that merely looks unchanged.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStream } from "@executablemd/durable-streams";
import { StaleInputError } from "@executablemd/durable-streams";
import {
  createDurableOperation,
  defaultLiveDurableOperationCoordinator,
  establishJournalProvenance,
  guardDurableStream,
  ReplayGuard,
} from "@executablemd/durable-streams";
import type {
  JournalProvenance,
  LiveDurableOperationCoordinator,
} from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Yield } from "@executablemd/durable-streams";
import { createApi } from "@effectionx/context-api";
import { API, useHostFiles } from "@executablemd/runtime";

import { collect } from "../src/collect.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { execute, Execution } from "../src/execute.ts";
import { inspectDocument } from "../src/inspect.ts";
import { getExpansion } from "../src/expansion.ts";
import { registerComponents } from "../src/components/registration.ts";
import {
  asDocumentTargetError,
  DocumentTargetError,
  isDocumentTargetError,
} from "../src/document-targets.ts";
import { isJsonObject, parseJson } from "../src/json.ts";
import { fileSource, formatDocumentReference, inlineSource } from "../src/root-source.ts";
import type { RootDocumentSource } from "../src/root-source.ts";
import type { Json } from "../src/types.ts";
import { asText } from "./helpers.ts";

/** What every `<Probe>` in a run reported, in the order it expanded. */
interface Probes {
  names: string[];
  ids: string[];
}

/**
 * `<Probe name="..." />` — proof of expansion.
 *
 * A component that records its own invocation and its expansion ID. Absent
 * output would not distinguish "skipped" from "rendered nothing"; an absent
 * entry here can only mean the element never expanded.
 */
function* useProbes(seen: Probes): Operation<void> {
  yield* registerComponents([
    {
      name: "Probe",
      origin: "tier-tx",
      props: { type: "object", properties: { name: { type: "string" } } },
      *fn(props) {
        const name = props["name"];
        seen.names.push(typeof name === "string" ? name : "?");
        seen.ids.push((yield* getExpansion()).id);
        return `[${typeof name === "string" ? name : "?"}]`;
      },
    },
  ]);
}

/** A directory the contextual cwd points at, removed when the test ends. */
function* useWorkspace(files: Record<string, string>): Operation<string> {
  const root = yield* until(mkdtemp(join(tmpdir(), "xmd-targets-")));
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    yield* writeTextFile(join(root, name), content);
  }
  yield* API.Env.around(
    {
      *cwd() {
        return root;
      },
    },
    { at: "min" },
  );
  yield* useHostFiles();
  return root;
}

function rootImports(stream: InMemoryStream) {
  return stream
    .snapshot()
    .flatMap((event) =>
      event.type === "yield" &&
      event.description.type === "import_component" &&
      event.description.name === "__root__"
        ? [event]
        : [],
    );
}

function closes(stream: InMemoryStream) {
  return stream.snapshot().filter((event) => event.type === "close");
}

/** Run a document and report both its text and what expanded. */
function run(root: RootDocumentSource, stream: InMemoryStream, seen: Probes): Operation<string> {
  return scoped(function* () {
    yield* useProbes(seen);
    return asText(yield* collect(yield* execute({ ...root, stream })));
  });
}

/** The failure a run produced, refusing to pass a success off as one. */
function* failure(
  root: RootDocumentSource,
  stream: InMemoryStream,
  seen: Probes = { names: [], ids: [] },
): Operation<unknown> {
  try {
    yield* run(root, stream, seen);
  } catch (error) {
    return error;
  }
  throw new Error("the run completed instead of failing");
}

const SECTIONS = [
  'preamble <Probe name="pre" />',
  "",
  "# Title",
  "",
  'title content <Probe name="title" />',
  "",
  "## Alpha",
  "",
  'alpha content <Probe name="alpha" />',
  "",
  "### Inner",
  "",
  'inner content <Probe name="inner" />',
  "",
  "## Beta",
  "",
  'beta content <Probe name="beta" />',
  "",
  "```sh exec",
  "echo beta-ran",
  "```",
  "",
].join("\n");

describe("Tier TX — targeted execution", () => {
  it("TX1: only the preamble, the ancestors, and the subtree expand", function* () {
    const seen: Probes = { names: [], ids: [] };
    const text = yield* run(
      inlineSource(SECTIONS, { target: "Alpha/Inner" }),
      new InMemoryStream(),
      seen,
    );

    expect(seen.names).toEqual(["pre", "title", "alpha", "inner"]);
    expect(text).toContain("# Title");
    expect(text).toContain("## Alpha");
    expect(text).toContain("### Inner");
    expect(text).not.toContain("## Beta");
  });

  it("TX2: a skipped sibling's components and code blocks never run", function* () {
    const seen: Probes = { names: [], ids: [] };
    yield* scoped(function* () {
      yield* API.Process.around({
        *exec([options], _next) {
          throw new Error(`a skipped code block ran: ${JSON.stringify(options.command)}`);
        },
      });
      yield* run(inlineSource(SECTIONS, { target: "Alpha" }), new InMemoryStream(), seen);
    });
    expect(seen.names).toEqual(["pre", "title", "alpha", "inner"]);
  });

  it("TX3: selecting a non-leaf expands every descendant", function* () {
    const seen: Probes = { names: [], ids: [] };
    yield* run(inlineSource(SECTIONS, { target: "Alpha" }), new InMemoryStream(), seen);
    expect(seen.names).toContain("inner");
  });

  it("TX4: a retained element keeps the expansion ID it has in a full run", function* () {
    const whole: Probes = { names: [], ids: [] };
    const targeted: Probes = { names: [], ids: [] };
    yield* run(inlineSource(SECTIONS), new InMemoryStream(), whole);
    yield* run(inlineSource(SECTIONS, { target: "Beta" }), new InMemoryStream(), targeted);

    const idOf = (probes: Probes, name: string) => probes.ids[probes.names.indexOf(name)];
    expect(targeted.names).toEqual(["pre", "title", "beta"]);
    expect(idOf(targeted, "beta")).toBe(idOf(whole, "beta"));
    expect(idOf(targeted, "pre")).toBe(idOf(whole, "pre"));
  });

  /**
   * The identifier is derived from position, not from what ran. Two targets
   * that retain the same element therefore agree with each other and with the
   * full run — and seeding identity with the target string would break all
   * three at once.
   */
  it("TX5: two different targets agree on a shared retained element", function* () {
    const alpha: Probes = { names: [], ids: [] };
    const beta: Probes = { names: [], ids: [] };
    yield* run(inlineSource(SECTIONS, { target: "Alpha" }), new InMemoryStream(), alpha);
    yield* run(inlineSource(SECTIONS, { target: "Beta" }), new InMemoryStream(), beta);
    expect(beta.ids[beta.names.indexOf("title")]).toBe(alpha.ids[alpha.names.indexOf("title")]);
  });

  it("TX6: a file root and an inline root behave identically", function* () {
    const workspace = yield* useWorkspace({ "doc.md": SECTIONS });
    const fromFile: Probes = { names: [], ids: [] };
    const fromText: Probes = { names: [], ids: [] };
    const fileText = yield* run(
      fileSource(formatDocumentReference(join(workspace, "doc.md"), "Beta")),
      new InMemoryStream(),
      fromFile,
    );
    const inlineText = yield* run(
      inlineSource(SECTIONS, { target: "Beta" }),
      new InMemoryStream(),
      fromText,
    );
    expect(fromFile.names).toEqual(fromText.names);
    expect(fileText).toBe(inlineText);
  });

  it("TX7: root props and frontmatter apply to the projected body", function* () {
    const body = [
      "---",
      "title: Doc",
      "props:",
      "  who:",
      "    type: string",
      "---",
      "",
      "# {meta.title}",
      "",
      "## Greeting",
      "",
      "hello {props.who}",
      "",
      "## Skipped",
      "",
      "skipped {props.who}",
      "",
    ].join("\n");
    const text = yield* scoped(function* () {
      const execution = yield* execute({
        ...inlineSource(body, { target: "Greeting" }),
        stream: new InMemoryStream(),
        props: { who: "world" },
      });
      return asText(yield* collect(execution));
    });
    expect(text).toContain("# Doc");
    expect(text).toContain("hello world");
    expect(text).not.toContain("skipped");
  });

  it("TX8: a value root returns from the projected body", function* () {
    const body = [
      "---",
      "returns:",
      "  type: object",
      "  properties:",
      "    picked:",
      "      type: string",
      "---",
      "",
      "# Title",
      "",
      "## Kept",
      "",
      '<Return value={{ "picked": "kept" }} />',
      "",
    ].join("\n");
    const value = yield* collect(
      yield* execute({
        ...inlineSource(body, { target: "Kept" }),
        stream: new InMemoryStream(),
      }),
    );
    expect(value).toEqual({ picked: "kept" });
  });

  it("TX9: `<Output>` in the projected body selects what is emitted", function* () {
    const body = [
      "# Title",
      "",
      "title text",
      "",
      "## Kept",
      "",
      "<Output>",
      "chosen",
      "</Output>",
      "",
      "not chosen",
      "",
    ].join("\n");
    const text = asText(
      yield* collect(
        yield* execute({
          ...inlineSource(body, { target: "Kept" }),
          stream: new InMemoryStream(),
        }),
      ),
    );
    expect(text.trim()).toBe("chosen");
  });

  /**
   * Structural preflight applies to the projected body, so a violation the
   * caller did not select is not a violation of what runs.
   */
  it("TX10: an invalid structure in a skipped sibling is irrelevant", function* () {
    const body = [
      "# Title",
      "",
      "## Kept",
      "",
      'kept body <Probe name="kept" />',
      "",
      "## Broken",
      "",
      '<Return value="x" />',
      "",
    ].join("\n");
    const seen: Probes = { names: [], ids: [] };
    const text = yield* run(inlineSource(body, { target: "Kept" }), new InMemoryStream(), seen);
    expect(seen.names).toEqual(["kept"]);
    expect(text).toContain("kept body");
    expect(text).not.toContain("<Return> requires");
  });

  it("TX11: an invalid structure in the retained range fails before any effect", function* () {
    const body = [
      "# Title",
      "",
      '<Probe name="title" />',
      "",
      "## Kept",
      "",
      '<Return value="x" />',
      "",
    ].join("\n");
    const seen: Probes = { names: [], ids: [] };
    const text = yield* run(inlineSource(body, { target: "Kept" }), new InMemoryStream(), seen);
    expect(seen.names).toEqual([]);
    expect(text).toContain("<Return> requires");
  });

  /**
   * Resolution sits inside the durable root import, so a target failure travels
   * out of `execute()` the way every failure crossing that boundary does: by
   * name and message, its class left behind with the journal round trip. The
   * typed `DocumentTargetError` is what `inspectDocument()` reports, and
   * inspection is where a host resolves a selector before running anything.
   */
  it("TX12: a target that resolves to nothing runs no authored effect", function* () {
    const stream = new InMemoryStream();
    const seen: Probes = { names: [], ids: [] };
    const error = yield* failure(inlineSource(SECTIONS, { target: "Missing" }), stream, seen);
    expect(isDocumentTargetError(error)).toBe(true);
    expect(asDocumentTargetError(error)?.data).toMatchObject({
      kind: "no-match",
      selector: "Missing",
      matches: [],
    });
    expect(seen.names).toEqual([]);
    // The selection was recorded as an observation, and the effect succeeded:
    // what failed is the document, deterministically, from that record.
    expect(rootImports(stream).map((event) => event.result.status)).toEqual(["ok"]);
    expect(stream.snapshot().filter((event) => event.type === "yield").length).toBe(1);
  });

  it("TX13: an ambiguous target runs no authored effect", function* () {
    const stream = new InMemoryStream();
    const seen: Probes = { names: [], ids: [] };
    const error = yield* failure(inlineSource(SECTIONS, { target: "**" }), stream, seen);
    expect(asDocumentTargetError(error)?.data.kind).toBe("multiple-matches");
    expect(seen.names).toEqual([]);
    expect(stream.snapshot().filter((event) => event.type === "yield").length).toBe(1);
  });

  it("TX14: inspection resolves a target without expanding a component", function* () {
    const seen: Probes = { names: [], ids: [] };
    const info = yield* scoped(function* () {
      yield* useProbes(seen);
      return yield* inspectDocument(inlineSource(SECTIONS, { target: "**/Inner" }));
    });
    expect(info.target).toBe("Alpha/Inner");
    expect(seen.names).toEqual([]);
  });
});

describe("Tier TX — targeted replay", () => {
  it("TX15: the journal records the exact target, never the glob", function* () {
    const stream = new InMemoryStream();
    const seen: Probes = { names: [], ids: [] };
    yield* run(inlineSource(SECTIONS, { target: "**/I*" }), stream, seen);

    const imports = rootImports(stream);
    expect(imports.length).toBe(1);
    expect(imports[0]).toMatchObject({
      result: { status: "ok", value: { target: "Alpha/Inner" } },
    });
  });

  it("TX16: an untargeted run records no target member at all", function* () {
    const stream = new InMemoryStream();
    yield* run(inlineSource(SECTIONS), stream, { names: [], ids: [] });
    const recorded = rootImports(stream)[0];
    expect(recorded?.result.status).toBe("ok");
    const value = recorded?.result.status === "ok" ? recorded.result.value : undefined;
    expect(value !== null && typeof value === "object" && "target" in value).toBe(false);
  });

  it("TX17: a different selector naming the same section replays", function* () {
    const stream = new InMemoryStream();
    const first: Probes = { names: [], ids: [] };
    const golden = yield* run(inlineSource(SECTIONS, { target: "Alpha/Inner" }), stream, first);

    const second: Probes = { names: [], ids: [] };
    const replayed = yield* run(inlineSource(SECTIONS, { target: "**/I*" }), stream, second);

    expect(replayed).toBe(golden);
    expect(rootImports(stream).length).toBe(1);
  });

  /**
   * The reuse this has to beat is the root Close, which `durableRun` honours
   * before any effect is replayed. Validating in the decide phase alone would
   * leave a completed journal answering for a section it never ran.
   */
  it("TX18: a different exact target refuses to reuse a completed journal", function* () {
    const stream = new InMemoryStream();
    yield* run(inlineSource(SECTIONS, { target: "Alpha" }), stream, { names: [], ids: [] });
    expect(closes(stream).length).toBeGreaterThan(0);

    const error = yield* failure(inlineSource(SECTIONS, { target: "Beta" }), stream);
    expect(error).toBeInstanceOf(StaleInputError);
    expect((error as Error).message).toContain("Alpha");
    expect((error as Error).message).toContain("Beta");
  });

  it("TX19: an untargeted request refuses a targeted journal", function* () {
    const stream = new InMemoryStream();
    yield* run(inlineSource(SECTIONS, { target: "Beta" }), stream, { names: [], ids: [] });

    const error = yield* failure(inlineSource(SECTIONS), stream);
    expect(error).toBeInstanceOf(StaleInputError);
    expect((error as Error).message).toContain("the whole document");
  });

  it("TX20: a targeted request refuses an untargeted journal", function* () {
    const stream = new InMemoryStream();
    yield* run(inlineSource(SECTIONS), stream, { names: [], ids: [] });

    const error = yield* failure(inlineSource(SECTIONS, { target: "Beta" }), stream);
    expect(error).toBeInstanceOf(StaleInputError);
  });

  it("TX21: a selector the recorded content no longer resolves fails stale", function* () {
    const stream = new InMemoryStream();
    yield* run(inlineSource(SECTIONS, { target: "Alpha" }), stream, { names: [], ids: [] });

    // "**" is ambiguous against the recorded content, so this run cannot show
    // that it means the recorded section.
    const error = yield* failure(inlineSource(SECTIONS, { target: "**" }), stream);
    expect(error).toBeInstanceOf(StaleInputError);
    // Stale input is what this is, and it carries nothing else: the guard
    // retains no failure object from the selection it could not match.
    expect((error as Error).cause).toBe(undefined);
    expect(isDocumentTargetError(error)).toBe(false);
  });

  /**
   * The defect this stack shipped first, and the reason a failed selection is
   * recorded structurally rather than left to the effect's own failure.
   *
   * `Missing` matched nothing, so the run failed and `durableRun` closed the
   * root. A later request for `Good` — which the document really offers — was
   * then answered with the recorded `Missing` error, because the guard
   * delegated past every `err` result and the completed Close short-circuited
   * everything after it.
   */
  it("TX24: a journal from a failed selector never answers a valid one", function* () {
    const stream = new InMemoryStream();
    const first = yield* failure(inlineSource(SECTIONS, { target: "Missing" }), stream);
    expect(asDocumentTargetError(first)?.data.selector).toBe("Missing");

    const second = yield* failure(inlineSource(SECTIONS, { target: "Beta" }), stream);
    expect(second).toBeInstanceOf(StaleInputError);
    expect((second as Error).message).not.toContain("Missing");
  });

  it("TX25: the same failing selector replays its own recorded failure", function* () {
    const stream = new InMemoryStream();
    const seen: Probes = { names: [], ids: [] };
    const first = yield* failure(inlineSource(SECTIONS, { target: "Missing" }), stream);
    const replayed = yield* failure(inlineSource(SECTIONS, { target: "Missing" }), stream, seen);

    expect(isDocumentTargetError(replayed)).toBe(true);
    expect(asDocumentTargetError(replayed)?.data).toEqual(asDocumentTargetError(first)?.data);
    expect(seen.names).toEqual([]);
    // One recorded import, and it is the first run's.
    expect(rootImports(stream).length).toBe(1);
  });

  it("TX26: one failed selection never answers for another kind of failure", function* () {
    const stream = new InMemoryStream();
    yield* failure(inlineSource(SECTIONS, { target: "Missing" }), stream);

    // Ambiguous rather than unmatched: a different outcome, not a different
    // spelling of the same one.
    const ambiguous = yield* failure(inlineSource(SECTIONS, { target: "**" }), stream);
    expect(ambiguous).toBeInstanceOf(StaleInputError);

    // Invalid syntax rather than unmatched.
    const invalid = yield* failure(inlineSource(SECTIONS, { target: "/bad" }), stream);
    expect(invalid).toBeInstanceOf(StaleInputError);

    // A different selector that also matches nothing is still a different
    // request, and the recorded failure describes the one that was made.
    const other = yield* failure(inlineSource(SECTIONS, { target: "AlsoMissing" }), stream);
    expect(other).toBeInstanceOf(StaleInputError);
  });

  it("TX27: live and replayed selection failures are the same structural error", function* () {
    const stream = new InMemoryStream();
    const live = yield* failure(inlineSource(SECTIONS, { target: "**/N*/Deep" }), stream);
    const replayed = yield* failure(inlineSource(SECTIONS, { target: "**/N*/Deep" }), stream);

    for (const error of [live, replayed]) {
      expect(isDocumentTargetError(error)).toBe(true);
      expect(asDocumentTargetError(error)?.data.selector).toBe("**/N*/Deep");
      expect(asDocumentTargetError(error)?.data.available).toEqual([
        "Alpha",
        "Alpha/Inner",
        "Beta",
      ]);
    }
  });

  it("TX22: an untargeted journal still replays for an untargeted run", function* () {
    const stream = new InMemoryStream();
    const golden = yield* run(inlineSource(SECTIONS), stream, { names: [], ids: [] });
    const replayed = yield* run(inlineSource(SECTIONS), stream, { names: [], ids: [] });
    expect(replayed).toBe(golden);
    expect(rootImports(stream).length).toBe(1);
  });

  /**
   * A replay projects the text the journal holds. Rewriting the file between
   * runs would change which section a re-resolved selector names if the current
   * copy were consulted; it does not, so the replayed output is the first run's.
   */
  it("TX23: replay projects the recorded content, not the file on disk", function* () {
    const workspace = yield* useWorkspace({ "doc.md": SECTIONS });
    const reference = formatDocumentReference(join(workspace, "doc.md"), "Beta");
    const stream = new InMemoryStream();
    const golden = yield* run(fileSource(reference), stream, { names: [], ids: [] });

    yield* writeTextFile(
      join(workspace, "doc.md"),
      ["# Title", "", "## Beta", "", "rewritten beta", ""].join("\n"),
    );

    const replayed = yield* run(fileSource(reference), stream, { names: [], ids: [] });
    expect(replayed).toBe(golden);
    expect(replayed).not.toContain("rewritten beta");
  });
});

/**
 * Tier TX — a corrupted root-import record fails closed.
 *
 * "Not the root import" and "the root import, malformed" have to be different
 * answers. A boundary that returns one absent value for both delegates a
 * corrupted record onward, and `durableRun` then reuses the recorded terminal
 * result — replaying a failure or a success the record no longer describes.
 *
 * Every case here starts from a *valid* completed journal and corrupts only the
 * recorded selection, so what is being measured is the parse and nothing else.
 * Each is resumed twice: once with the selector that produced the journal, once
 * with a selector that would succeed against a healthy record. Both must be
 * refused with the fixed diagnostic, and neither may expand anything or append
 * history.
 */
/** The one thing an unreadable recorded root import says. */
const UNREADABLE_RECORD = "The recorded root document import cannot be read by this version.";

describe("Tier TX — malformed recorded selections", () => {
  const UNREADABLE = UNREADABLE_RECORD;

  /** A completed journal whose root import recorded a failed selection. */
  function* failedJournal(): Operation<InMemoryStream> {
    const stream = new InMemoryStream();
    yield* failure(inlineSource(SECTIONS, { target: "Missing" }), stream);
    return stream;
  }

  /** Rewrite the recorded root-import selection, keeping everything else. */
  function* corrupt(
    stream: InMemoryStream,
    change: (record: Record<string, unknown>) => Record<string, unknown>,
  ): Operation<InMemoryStream> {
    const corrupted = new InMemoryStream();
    for (const event of stream.snapshot()) {
      const record =
        event.type === "yield" &&
        event.description.name === "__root__" &&
        event.result.status === "ok"
          ? event.result.value
          : undefined;
      if (event.type === "yield" && isJsonObject(record)) {
        yield* corrupted.append({
          ...event,
          result: { status: "ok", value: parseJson(change({ ...record })) },
        });
        continue;
      }
      yield* corrupted.append(event);
    }
    return corrupted;
  }

  /** Every way a corrupted record must be refused, resumed both ways. */
  function* refuses(
    change: (record: Record<string, unknown>) => Record<string, unknown>,
  ): Operation<void> {
    const healthy = yield* failedJournal();
    const before = (yield* corrupt(healthy, change)).snapshot().length;

    for (const target of ["Missing", "Beta"]) {
      const stream = yield* corrupt(healthy, change);
      const seen: Probes = { names: [], ids: [] };
      const error = yield* failure(inlineSource(SECTIONS, { target }), stream, seen);

      expect((error as Error).message).toBe(UNREADABLE);
      expect((error as Error).cause).toBe(undefined);
      // Not the recorded failure, and not a document-target failure at all.
      expect(isDocumentTargetError(error)).toBe(false);
      expect((error as Error).message).not.toContain("Missing");
      // Nothing expanded, and no history was appended on top of the corruption.
      expect(seen.names).toEqual([]);
      expect(stream.snapshot().length).toBe(before);
    }
  }

  it("TX28: a missing or non-array `available` is refused", function* () {
    yield* refuses((record) => ({
      ...record,
      failure: omit(record["failure"], "available"),
    }));
    yield* refuses((record) => ({
      ...record,
      failure: { ...asRecord(record["failure"]), available: "Beta" },
    }));
  });

  it("TX29: an unknown selection kind is refused", function* () {
    yield* refuses((record) => ({ ...record, kind: "something-else" }));
    yield* refuses((record) => omit(record, "kind"));
  });

  it("TX30: extra data in the record or the failure is refused", function* () {
    yield* refuses((record) => ({ ...record, extra: "payload" }));
    yield* refuses((record) => ({
      ...record,
      failure: { ...asRecord(record["failure"]), extra: "payload" },
    }));
  });

  /**
   * Two different facts, and only the second belongs to this protocol.
   *
   * `Beta ` and `a%2fb` are not canonical encodings, so the data parser refuses
   * them (DT58). `../../etc/passwd` *is* a canonical four-level heading path
   * (DT59) — what refuses it here is that the recorded document's derived
   * catalog does not contain it. Shape checking alone would accept it.
   */
  it("TX31: a catalog the recorded document does not derive is refused", function* () {
    for (const available of [["../../etc/passwd"], ["Beta "], ["a%2fb"]]) {
      yield* refuses((record) => ({
        ...record,
        failure: { ...asRecord(record["failure"]), available },
      }));
    }
    // The same rule on a successful repository selection's own target: `beta`
    // is a perfectly canonical target that this document simply does not have.
    const healthy = new InMemoryStream();
    yield* run(inlineSource(SECTIONS, { target: "Beta" }), healthy, { names: [], ids: [] });
    const stream = yield* corrupt(healthy, (record) => ({ ...record, target: "beta" }));
    const error = yield* failure(inlineSource(SECTIONS, { target: "Beta" }), stream);
    expect((error as Error).message).toBe(UNREADABLE);
  });

  it("TX32: semantically inconsistent kind and matches are refused", function* () {
    // `no-match` carrying matches, and a selector that really does match.
    yield* refuses((record) => ({
      ...record,
      failure: { ...asRecord(record["failure"]), matches: ["Beta"] },
    }));
    yield* refuses((record) => ({
      ...record,
      failure: { ...asRecord(record["failure"]), selector: "Beta" },
    }));
    // `multiple-matches` with a single match.
    yield* refuses((record) => ({
      ...record,
      failure: {
        ...asRecord(record["failure"]),
        kind: "multiple-matches",
        selector: "Beta",
        matches: ["Beta"],
      },
    }));
  });

  it("TX33: a valid record still replays, so the refusals are not vacuous", function* () {
    const stream = yield* failedJournal();
    const seen: Probes = { names: [], ids: [] };
    const replayed = yield* failure(inlineSource(SECTIONS, { target: "Missing" }), stream, seen);
    expect(isDocumentTargetError(replayed)).toBe(true);
    expect((replayed as Error).message).not.toBe(UNREADABLE);
    expect(seen.names).toEqual([]);
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? { ...(value as object) } : {};
}

function omit(value: unknown, key: string): Record<string, unknown> {
  const record = asRecord(value);
  delete record[key];
  return record;
}

/**
 * Tier TX — reading a recorded root selection is total.
 *
 * The record is journal data, and journal data has ways of refusing to be read
 * that are not defects of this run: a property may be an accessor that throws,
 * a key list may come from a Proxy that refuses, and recorded markdown may have
 * frontmatter no parser accepts. Each must become the one fixed answer, not an
 * error of its own — an exception escaping here would carry a parser message, a
 * path, or whatever a hostile record planted, and would do it from a boundary
 * whose whole job is to refuse.
 *
 * The seam is the stream, not the record. `InMemoryStream` structured-clones on
 * append, so nothing hostile can be *stored* in one; what a run actually
 * consumes is whatever `readAll()` hands back. `PlantedStream` is therefore a
 * stream that answers reads with a substituted root-import result, which is the
 * shape a damaged or hostile backend really has.
 *
 * Each row plants a distinctive value and asserts it reaches nothing.
 */
const PLANTED = "pl4nted-s3cret";

/**
 * A stream that answers reads with a substituted recorded root import.
 *
 * The substitution is a function of the healthy event, so a row can plant at
 * any depth: inside a normally readable `result.value`, or on the envelope
 * itself — `result`, `result.status`, `result.value` — which is where a damaged
 * backend's unreadability actually lives.
 */
class PlantedStream implements DurableStream {
  readonly appended: DurableEvent[] = [];

  constructor(
    private readonly events: readonly DurableEvent[],
    private readonly plant: (event: DurableEvent) => DurableEvent,
  ) {}

  // deno-lint-ignore require-yield
  *readAll(): Operation<DurableEvent[]> {
    return this.events.map((event) =>
      event.type === "yield" && event.description.name === "__root__" ? this.plant(event) : event,
    );
  }

  // deno-lint-ignore require-yield
  *append(event: DurableEvent): Operation<void> {
    this.appended.push(event);
  }
}

/**
 * Substitute the recorded root-import result value.
 *
 * `Result.value` is typed `Json`, and the point of these rows is to put
 * something there that is not — which is what a damaged backend does and what
 * the boundary has to survive. The casts in this file exist for that reason and
 * no other.
 */
function plantValue(value: unknown): (event: DurableEvent) => DurableEvent {
  return (event) => ({ ...event, result: { status: "ok", value: value as Json } });
}

/** Replace part of the recorded root-import envelope with a refusing accessor. */
function plantEnvelope(
  member: "result" | "status" | "value",
): (event: DurableEvent) => DurableEvent {
  const refuse = () => {
    throw new Error(`envelope refused: ${PLANTED}`);
  };
  return (event) => {
    if (member === "result") {
      const planted: Record<string, unknown> = { ...event };
      Object.defineProperty(planted, "result", { enumerable: true, get: refuse });
      return planted as unknown as DurableEvent;
    }
    const result: Record<string, unknown> =
      member === "status"
        ? { value: { kind: "repository", path: "doc.md", content: SECTIONS } }
        : { status: "ok" };
    Object.defineProperty(result, member, { enumerable: true, get: refuse });
    return { ...event, result: result as unknown as DurableEvent["result"] };
  };
}

describe("Tier TX — unreadable recorded selections", () => {
  /** A completed journal, then a stream that answers reads with `plant`. */
  function* plantedStream(plant: (event: DurableEvent) => DurableEvent): Operation<PlantedStream> {
    const healthy = new InMemoryStream();
    yield* failure(inlineSource(SECTIONS, { target: "Missing" }), healthy);
    return new PlantedStream(healthy.snapshot(), plant);
  }

  /**
   * Resume a planted journal both ways and hold every refusal to the contract.
   *
   * Both directions matter and they fail differently when the boundary is
   * wrong: the original `Missing` selector would replay the recorded failure,
   * and the different, genuinely valid `Beta` selector would replay that same
   * `Missing` failure — an outcome for a request nobody made.
   */
  function* refusesTotally(plant: (event: DurableEvent) => DurableEvent): Operation<void> {
    for (const target of ["Missing", "Beta"]) {
      const stream = yield* plantedStream(plant);
      const seen: Probes = { names: [], ids: [] };
      const error = yield* scoped(function* () {
        yield* useProbes(seen);
        try {
          yield* collect(yield* execute({ ...inlineSource(SECTIONS, { target }), stream }));
        } catch (caught) {
          return caught;
        }
        throw new Error("the run completed instead of failing");
      });

      expect((error as Error).message).toBe(UNREADABLE_RECORD);
      expect((error as Error).cause).toBe(undefined);
      // Never the recorded failure, for either request.
      expect(isDocumentTargetError(error)).toBe(false);
      // Nothing the record planted escapes, by any route a consumer would use.
      const rendered = `${String(error)} ${(error as Error).stack ?? ""} ${JSON.stringify({
        ...(error as object),
      })}`;
      expect(rendered).not.toContain(PLANTED);
      expect(rendered).not.toContain("Missing");
      // Nothing expanded, and nothing was appended on top of the record.
      expect(seen.names).toEqual([]);
      expect(stream.appended).toEqual([]);
    }
  }

  it("TX34: recorded content whose frontmatter no parser accepts is malformed", function* () {
    // Valid JSON, valid string, unparseable document: without a total boundary
    // the YAML parser's own failure escapes, carrying the planted text with it.
    yield* refusesTotally(
      plantValue({
        kind: "target-failure",
        path: `${PLANTED}.md`,
        content: `---\n: [unbalanced\n  ${PLANTED}\n---\n\n# T\n`,
        failure: { kind: "no-match", selector: "Missing", matches: [], available: [] },
      }),
    );
  });

  it("TX35: an unreadable member is malformed, and says nothing about itself", function* () {
    const record: Record<string, unknown> = {
      kind: "target-failure",
      path: "doc.md",
      failure: { kind: "no-match", selector: "Missing", matches: [], available: [] },
    };
    Object.defineProperty(record, "content", {
      enumerable: true,
      get() {
        throw new Error(`accessor refused: ${PLANTED}`);
      },
    });
    yield* refusesTotally(plantValue(record));
  });

  it("TX36: a record that refuses key enumeration is malformed", function* () {
    yield* refusesTotally(
      plantValue(
        new Proxy(
          {
            kind: "target-failure",
            path: "doc.md",
            content: "# T\n\n## Beta\n",
            failure: { kind: "no-match", selector: "Missing", matches: [], available: [] },
          },
          {
            ownKeys() {
              throw new Error(`enumeration refused: ${PLANTED}`);
            },
          },
        ),
      ),
    );
  });

  it("TX37: a value that is not a record at all is malformed", function* () {
    for (const planted of [`a string ${PLANTED}`, 7, null, [PLANTED]]) {
      yield* refusesTotally(plantValue(planted));
    }
  });

  /**
   * The envelope, not its contents.
   *
   * Recognizing the event and reading its settled value are different questions,
   * and answering both with one absent value conflates "this is not the root
   * import" with "the root import will not say what it settled to". The second
   * then delegates, and `durableRun` reuses the recorded terminal result — so a
   * request for a section that really exists is answered with the failure of a
   * request nobody made.
   */
  it("TX38: a successful root result whose value refuses to be read is malformed", function* () {
    yield* refusesTotally(plantEnvelope("value"));
  });

  it("TX39: a root result whose settlement refuses to be read is malformed", function* () {
    yield* refusesTotally(plantEnvelope("status"));
  });

  /**
   * The envelope itself, which used to be an exception.
   *
   * `ReplayIndex` read every Yield's result while building itself — before any
   * guard's check phase — so a stream that would not produce the envelope
   * failed inside indexing and carried its own error out past every refusal.
   * Indexing now reads identity and leaves the result alone until a consumer
   * asks, which puts this case back inside the same sanitized refusal as the
   * rest. The ordering property itself is pinned in the durable-streams suite.
   */
  it("TX40: a root event whose result refuses to be read is malformed", function* () {
    yield* refusesTotally(plantEnvelope("result"));
  });

  it("TX41: a successful root result with no value at all is malformed", function* () {
    yield* refusesTotally((event) => ({ ...event, result: { status: "ok" } }));
  });

  /**
   * The other side of the classification: an ordinary failed settlement on the
   * root import is recognized and left alone, because a root can fail for
   * reasons that are not about selection.
   */
  it("TX42: an ordinary failed root settlement is not this protocol's to refuse", function* () {
    const stream = yield* plantedStream((event) => ({
      ...event,
      result: { status: "err", error: { message: "the file went away" } },
    }));
    const error = yield* scoped(function* () {
      try {
        yield* collect(yield* execute({ ...inlineSource(SECTIONS, { target: "Beta" }), stream }));
      } catch (caught) {
        return caught;
      }
      throw new Error("the run completed instead of failing");
    });
    // Not refused by this protocol. Because the guard leaves the event alone,
    // the completed journal's terminal result is reused as it always is — and
    // that path deserializes, so what arrives is the recorded outcome's message
    // rather than a reconstructed typed failure. That is the ordinary durable
    // behavior an unclaimed event should get.
    expect((error as Error).message).not.toBe(UNREADABLE_RECORD);
    expect((error as Error).message).toContain("matches no document target");
  });
});

/**
 * Tier TX — the guard and replay read one settled value, not two.
 *
 * A recorded result is validated in the check phase and consumed during replay.
 * If those are two reads of the stream's own event, a source that answers
 * differently between them decides one thing for the guard and another for
 * execution — the guard approves the section it was shown, and the run executes
 * the section it was handed. Exact-target identity says the section that ran is
 * the section the record names, and two reads make that unenforceable.
 *
 * Both answers here are *valid*: two real recorded selections from two real
 * runs. Nothing is malformed, nothing is refused, and the only thing separating
 * a correct run from a wrong one is that the value is read once.
 */
describe("Tier TX — one read across check and replay", () => {
  /** The recorded root-import value of a real run against `target`. */
  function* recordedSelection(target: string): Operation<Json> {
    const stream = new InMemoryStream();
    yield* run(inlineSource(SECTIONS, { target }), stream, { names: [], ids: [] });
    const recorded = stream
      .snapshot()
      .find((event) => event.type === "yield" && event.description.name === "__root__");
    if (recorded === undefined || recorded.result.status !== "ok") {
      throw new Error("no recorded root import");
    }
    const value = recorded.result.value;
    if (value === undefined) {
      throw new Error("recorded root import carried no value");
    }
    return value;
  }

  /**
   * A partial journal: the recorded root import and nothing after it.
   *
   * Without a Close there is no completed-run shortcut, so the run replays the
   * import and then continues live — which is the shape that lets the guard and
   * the replay consumer both reach the same retained event.
   */
  function* partialJournal(target: string): Operation<DurableEvent[]> {
    const stream = new InMemoryStream();
    yield* run(inlineSource(SECTIONS, { target }), stream, { names: [], ids: [] });
    return stream
      .snapshot()
      .filter((event) => event.type === "yield" && event.description.name === "__root__");
  }

  /**
   * The same substitution one level down.
   *
   * The record itself is stable; only the `target` member beneath it answers
   * afresh. Freezing the outer result stops nothing here — the guard reads a
   * record naming Alpha and replay reads the same record naming Beta.
   */
  it("TX46: a nested target accessor cannot substitute another section", function* () {
    const alpha = yield* recordedSelection("Alpha");
    const events = yield* partialJournal("Alpha");
    const reads = { count: 0 };
    const targets = ["Alpha", "Beta"];

    const stream = new PlantedStream(events, (event) => {
      const record: Record<string, unknown> = { ...asRecord(alpha) };
      Object.defineProperty(record, "target", {
        enumerable: true,
        get() {
          const answer = targets[Math.min(reads.count, targets.length - 1)];
          reads.count++;
          return answer;
        },
      });
      return {
        ...event,
        result: { status: "ok", value: record as unknown as Json },
      };
    });

    const seen: Probes = { names: [], ids: [] };
    const text = yield* scoped(function* () {
      yield* useProbes(seen);
      return asText(
        yield* collect(yield* execute({ ...inlineSource(SECTIONS, { target: "Alpha" }), stream })),
      );
    });

    expect(seen.names).toEqual(["pre", "title", "alpha", "inner"]);
    expect(text).not.toContain("## Beta");
    expect(reads.count).toBe(1);
    const close = stream.appended.find((event) => event.type === "close");
    expect(JSON.stringify(close)).toContain("alpha content");
    expect(JSON.stringify(close)).not.toContain("beta content");
  });

  it("TX43: a source that answers twice decides nothing twice", function* () {
    const alpha = yield* recordedSelection("Alpha");
    const beta = yield* recordedSelection("Beta");
    const events = yield* partialJournal("Alpha");
    const answers: Json[] = [alpha, beta];
    const reads = { count: 0 };

    const stream = new PlantedStream(events, (event) => {
      const result: Record<string, unknown> = { status: "ok" };
      Object.defineProperty(result, "value", {
        enumerable: true,
        get() {
          const answer = answers[Math.min(reads.count, answers.length - 1)]!;
          reads.count++;
          return answer;
        },
      });
      return { ...event, result: result as unknown as DurableEvent["result"] };
    });

    const seen: Probes = { names: [], ids: [] };
    const text = yield* scoped(function* () {
      yield* useProbes(seen);
      return asText(
        yield* collect(yield* execute({ ...inlineSource(SECTIONS, { target: "Alpha" }), stream })),
      );
    });

    // The guard approved Alpha, so Alpha is what ran.
    expect(seen.names).toEqual(["pre", "title", "alpha", "inner"]);
    expect(text).toContain("### Inner");
    expect(text).not.toContain("## Beta");
    // And the record was consulted once, so there was never a second answer to
    // disagree with the first.
    expect(reads.count).toBe(1);
    // What the run published describes the section the guard approved.
    const close = stream.appended.find((event) => event.type === "close");
    expect(close).toBeDefined();
    expect(JSON.stringify(close)).toContain("alpha content");
    expect(JSON.stringify(close)).not.toContain("beta content");
  });
});

/**
 * A section before the title must not run as preamble.
 *
 * The projection rows prove the text is absent; only a component that records
 * its own invocation proves the section did not execute.
 */
describe("Tier TX — preamble boundary", () => {
  const OPENS_DEEP = [
    "## Before",
    "",
    'before body <Probe name="before" />',
    "",
    "# Title",
    "",
    'title content <Probe name="title" />',
    "",
    "## After",
    "",
    'after body <Probe name="after" />',
    "",
  ].join("\n");

  it("TX44: selecting the later section never executes the earlier one", function* () {
    const seen: Probes = { names: [], ids: [] };
    const text = yield* run(
      inlineSource(OPENS_DEEP, { target: "After" }),
      new InMemoryStream(),
      seen,
    );
    expect(seen.names).toEqual(["title", "after"]);
    expect(text).not.toContain("## Before");
    expect(text).not.toContain("before body");
  });

  it("TX45: the earlier section still runs when it is the target", function* () {
    const seen: Probes = { names: [], ids: [] };
    yield* run(inlineSource(OPENS_DEEP, { target: "Before" }), new InMemoryStream(), seen);
    expect(seen.names).toEqual(["before"]);
  });
});

/**
 * Tier TX — a retained terminal result needs the import that produced it.
 *
 * `durableRun` reuses a recorded Close before replaying anything, and the check
 * phase only ever sees the Yields a journal actually contains. A journal whose
 * root import is gone therefore offers the guard nothing to validate, and the
 * Close answers for a selection that was never established — a resume asking
 * for one section receives another section's completed result.
 *
 * A replay that means to reuse terminal history must first establish exactly
 * one recognizable root import.
 */
describe("Tier TX — a terminal journal without its root import", () => {
  /** A completed journal for `target`, minus its root-import Yield. */
  function* withoutRootImport(target: string): Operation<InMemoryStream> {
    const complete = new InMemoryStream();
    yield* run(inlineSource(SECTIONS, { target }), complete, { names: [], ids: [] });
    const stripped = new InMemoryStream();
    for (const event of complete.snapshot()) {
      if (event.type === "yield" && event.description.name === "__root__") {
        continue;
      }
      yield* stripped.append(event);
    }
    return stripped;
  }

  /** Hold a resume against a stripped journal to the refusal contract. */
  function* refusesStripped(stream: InMemoryStream, target?: string): Operation<void> {
    const before = stream.snapshot().length;
    const seen: Probes = { names: [], ids: [] };
    const source =
      target === undefined ? inlineSource(SECTIONS) : inlineSource(SECTIONS, { target });
    const error = yield* failure(source, stream, seen);

    expect((error as Error).message).toBe(UNREADABLE_RECORD);
    expect((error as Error).cause).toBe(undefined);
    expect(isDocumentTargetError(error)).toBe(false);
    // Never the retained Close's own outcome.
    expect((error as Error).message).not.toContain("alpha content");
    expect(seen.names).toEqual([]);
    expect(stream.snapshot().length).toBe(before);
  }

  it("TX47: a targeted journal missing its root import refuses", function* () {
    yield* refusesStripped(yield* withoutRootImport("Alpha"), "Beta");
    yield* refusesStripped(yield* withoutRootImport("Alpha"), "Alpha");
  });

  it("TX48: an untargeted journal missing its root import refuses", function* () {
    const complete = new InMemoryStream();
    yield* run(inlineSource(SECTIONS), complete, { names: [], ids: [] });
    const stripped = new InMemoryStream();
    for (const event of complete.snapshot()) {
      if (event.type === "yield" && event.description.name === "__root__") {
        continue;
      }
      yield* stripped.append(event);
    }
    yield* refusesStripped(stripped);
  });

  it("TX49: a duplicated root import refuses", function* () {
    const complete = new InMemoryStream();
    yield* run(inlineSource(SECTIONS, { target: "Alpha" }), complete, { names: [], ids: [] });
    const doubled = new InMemoryStream();
    for (const event of complete.snapshot()) {
      yield* doubled.append(event);
      if (event.type === "yield" && event.description.name === "__root__") {
        yield* doubled.append(event);
      }
    }
    yield* refusesStripped(doubled, "Alpha");
  });

  it("TX50: the control — an intact terminal journal still replays", function* () {
    const stream = new InMemoryStream();
    const golden = yield* run(inlineSource(SECTIONS, { target: "Alpha" }), stream, {
      names: [],
      ids: [],
    });
    const replayed = yield* run(inlineSource(SECTIONS, { target: "Alpha" }), stream, {
      names: [],
      ids: [],
    });
    expect(replayed).toBe(golden);
  });
});

/**
 * Tier TX — definition identity is not middleware.
 *
 * Exact canonical target is workflow-definition identity, and identity may not
 * be decided by anything a document, a component, or an enclosing scope can
 * replace. A public `ReplayGuard` handler installed further out may decline to
 * call `next` — that is what composable policy is *for* — so a comparison
 * living there is a comparison an outer handler can switch off.
 *
 * These install exactly such a handler and assert the answer does not change.
 */
describe("Tier TX — identity authority is execution-owned", () => {
  /** A guard that swallows every stage it is given, calling `next` for none. */
  function* useSuppressingGuard(stage: "check" | "admit"): Operation<void> {
    if (stage === "check") {
      yield* ReplayGuard.around({
        // deno-lint-ignore require-yield
        *check() {},
      });
      return;
    }
    yield* ReplayGuard.around({
      // deno-lint-ignore require-yield
      *admit() {},
    });
  }

  /** Resume `stream` as `target` with `install` in scope, and report what happened. */
  function* resumeWith(
    stream: InMemoryStream,
    target: string,
    install: () => Operation<void>,
  ): Operation<{ error: unknown; seen: Probes; appended: number }> {
    const before = stream.snapshot().length;
    const seen: Probes = { names: [], ids: [] };
    const error = yield* scoped(function* () {
      yield* install();
      yield* useProbes(seen);
      try {
        yield* collect(yield* execute({ ...inlineSource(SECTIONS, { target }), stream }));
      } catch (caught) {
        return caught;
      }
      return undefined;
    });
    return { error, seen, appended: stream.snapshot().length - before };
  }

  /** A completed journal for `target`. */
  function* completed(target: string): Operation<InMemoryStream> {
    const stream = new InMemoryStream();
    yield* run(inlineSource(SECTIONS, { target }), stream, { names: [], ids: [] });
    return stream;
  }

  /** A journal for `target` with its terminal result removed. */
  function* partial(target: string): Operation<InMemoryStream> {
    const complete = yield* completed(target);
    const stripped = new InMemoryStream();
    for (const event of complete.snapshot()) {
      if (event.type === "close") {
        continue;
      }
      yield* stripped.append(event);
    }
    return stripped;
  }

  it("TX51: an enclosing check handler that never delegates cannot admit Beta", function* () {
    const outcome = yield* resumeWith(yield* completed("Alpha"), "Beta", () =>
      useSuppressingGuard("check"),
    );
    expect(outcome.error).toBeInstanceOf(StaleInputError);
    expect(outcome.seen.names).toEqual([]);
    expect(outcome.appended).toBe(0);
  });

  it("TX52: an enclosing admit handler that never delegates cannot admit Beta", function* () {
    const outcome = yield* resumeWith(yield* completed("Alpha"), "Beta", () =>
      useSuppressingGuard("admit"),
    );
    expect(outcome.error).toBeInstanceOf(StaleInputError);
    expect(outcome.seen.names).toEqual([]);
    expect(outcome.appended).toBe(0);
  });

  /**
   * A guard registered under the same name by a separately loaded copy composes
   * with this run's guards, because an Effection context is keyed by its name.
   * That is the portability mechanism, and it is exactly why identity is not
   * kept there.
   */
  it("TX53: a same-name guard from another loaded copy cannot admit Beta", function* () {
    const foreign = createApi<{ check(event: Yield): Operation<void> }>(
      "DurableEffection.ReplayGuard",
      {
        // deno-lint-ignore require-yield
        *check() {},
      },
    );
    const outcome = yield* resumeWith(yield* completed("Alpha"), "Beta", function* () {
      yield* foreign.around({
        // deno-lint-ignore require-yield
        *check() {},
      });
    });
    expect(outcome.error).toBeInstanceOf(StaleInputError);
    expect(outcome.seen.names).toEqual([]);
    expect(outcome.appended).toBe(0);
  });

  it("TX54: a partial journal is held to its recorded selection too", function* () {
    const outcome = yield* resumeWith(yield* partial("Alpha"), "Beta", () =>
      useSuppressingGuard("check"),
    );
    expect(outcome.error).toBeInstanceOf(StaleInputError);
    expect(outcome.seen.names).toEqual([]);
    expect(outcome.appended).toBe(0);
  });

  it("TX55: the controls — the same target replays, complete and partial", function* () {
    const whole = yield* resumeWith(yield* completed("Alpha"), "Alpha", () =>
      useSuppressingGuard("check"),
    );
    expect(whole.error).toBe(undefined);

    const half = yield* resumeWith(yield* partial("Alpha"), "Alpha", () =>
      useSuppressingGuard("check"),
    );
    expect(half.error).toBe(undefined);
    expect(half.seen.names).toEqual(["pre", "title", "alpha", "inner"]);
  });

  it("TX56: ordinary guard composition still works", function* () {
    const stream = yield* completed("Alpha");
    const observed: string[] = [];
    const outcome = yield* resumeWith(stream, "Alpha", function* () {
      yield* ReplayGuard.around({
        *check([event], next) {
          observed.push(event.description.name);
          return yield* next(event);
        },
      });
    });
    expect(outcome.error).toBe(undefined);
    expect(observed).toContain("__root__");
  });
});

/**
 * Tier TX — the root import that authorizes a terminal result is the terminal
 * coroutine's own.
 *
 * Reusing a recorded terminal result means standing behind the selection its
 * root import established. A root import belonging to some other coroutine
 * established that coroutine's selection, not this one's, and two of them
 * establish nothing at all.
 */
describe("Tier TX — a terminal result needs its own root import", () => {
  /** A completed Alpha journal, rewritten event by event. */
  function* rewritten(
    change: (events: DurableEvent[]) => DurableEvent[],
  ): Operation<InMemoryStream> {
    const complete = new InMemoryStream();
    yield* run(inlineSource(SECTIONS, { target: "Alpha" }), complete, { names: [], ids: [] });
    const rebuilt = new InMemoryStream();
    for (const event of change(complete.snapshot())) {
      yield* rebuilt.append(event);
    }
    return rebuilt;
  }

  function isRootImport(event: DurableEvent): boolean {
    return event.type === "yield" && event.description.name === "__root__";
  }

  /** Hold a resume to the refusal contract. */
  function* refuses(stream: InMemoryStream): Operation<void> {
    const before = stream.snapshot().length;
    const seen: Probes = { names: [], ids: [] };
    const error = yield* failure(inlineSource(SECTIONS, { target: "Alpha" }), stream, seen);
    expect((error as Error).message).toBe(UNREADABLE_RECORD);
    expect((error as Error).cause).toBe(undefined);
    expect(seen.names).toEqual([]);
    expect(stream.snapshot().length).toBe(before);
  }

  it("TX57: only a child coroutine carries the root import", function* () {
    yield* refuses(
      yield* rewritten((events) =>
        events.map((event) => (isRootImport(event) ? { ...event, coroutineId: "root.7" } : event)),
      ),
    );
  });

  it("TX58: a valid root import plus a root-named child event", function* () {
    yield* refuses(
      yield* rewritten((events) =>
        events.flatMap((event) =>
          isRootImport(event) ? [event, { ...event, coroutineId: "root.7" }] : [event],
        ),
      ),
    );
  });

  it("TX59: no root import at all", function* () {
    yield* refuses(yield* rewritten((events) => events.filter((event) => !isRootImport(event))));
  });

  it("TX60: two root imports on the terminal coroutine", function* () {
    yield* refuses(
      yield* rewritten((events) =>
        events.flatMap((event) => (isRootImport(event) ? [event, event] : [event])),
      ),
    );
  });
});

/**
 * Tier TX — a detached retained value is still ordinary JSON.
 *
 * Detaching is a claim against the journal, not against the document. A
 * replayed value a document goes on to update must behave as it did when the
 * run first produced it.
 */
describe("Tier TX — detached values stay mutable", () => {
  const MUTATES = [
    "```js eval",
    "const state = { count: 0, tags: ['a'] };",
    "```",
    "",
    "```js eval",
    "state.count += 1;",
    "state.tags.push('b');",
    "output(`${state.count}:${state.tags.join(',')}`);",
    "```",
    "",
  ].join("\n");

  function* runMutating(stream: DurableStream): Operation<string> {
    return yield* scoped(function* () {
      // The portable compiler: a data: module is not importable under every
      // runtime.
      yield* useTempFileCompiler();
      return asText(yield* collect(yield* execute({ ...inlineSource(MUTATES), stream })));
    });
  }

  /**
   * A genuine partial replay: the binding is restored from the journal and then
   * written to by an iteration that runs live.
   *
   * The first eval block is retained, so `state` comes back detached from the
   * journal. The second is dropped along with the terminal result, so the
   * update runs for real. A detached member that is not writable fails here.
   */
  it("TX61: a restored binding is mutated by the live continuation", function* () {
    const complete = new InMemoryStream();
    const golden = yield* runMutating(complete);
    expect(golden).toContain("1:a,b");

    const evals = complete
      .snapshot()
      .filter((event) => event.type === "yield" && event.description.type === "eval");
    expect(evals.length).toBeGreaterThan(1);

    const partial = new InMemoryStream();
    let kept = 0;
    for (const event of complete.snapshot()) {
      if (event.type === "close") {
        continue;
      }
      if (event.type === "yield" && event.description.type === "eval") {
        kept += 1;
        if (kept > 1) {
          continue;
        }
      }
      yield* partial.append(event);
    }

    // The first block replays and restores `state`; the second runs live and
    // writes to it.
    expect(yield* runMutating(partial)).toBe(golden);
  });
});

/**
 * Tier TX — one validation order on every public path.
 *
 * A caller who named a section the document does not offer asked the wrong
 * question, and should hear that — not a complaint about a schema they never
 * reached. Resolving the target before compiling schemas makes the answer the
 * same whether a host inspects, runs, or resumes.
 */
describe("Tier TX — target resolution precedes schema compilation", () => {
  const BROKEN_SCHEMA = [
    "---",
    "props:",
    "  type: object",
    "  properties:",
    "    who:",
    "      type: not-a-json-schema-type",
    "---",
    "",
    "# Title",
    "",
    "## Kept",
    "",
    "kept body",
    "",
  ].join("\n");

  const GOOD_SCHEMA = BROKEN_SCHEMA.replace("not-a-json-schema-type", "string");

  /** The failure each public path reports for one source and selector. */
  function* onEveryPath(source: string, target: string): Operation<unknown[]> {
    const inspected = yield* scoped(function* () {
      try {
        yield* inspectDocument(inlineSource(source, { target }));
      } catch (error) {
        return error;
      }
      return undefined;
    });

    const stream = new InMemoryStream();
    const live = yield* failure(inlineSource(source, { target }), stream);
    // The same journal again: a recorded failed selection keeps its precedence
    // and is not replaced by the recorded terminal error.
    const replayed = yield* failure(inlineSource(source, { target }), stream);
    return [inspected, live, replayed];
  }

  it("TX64: an unresolvable target outranks an invalid schema on all three paths", function* () {
    for (const failed of yield* onEveryPath(BROKEN_SCHEMA, "Missing")) {
      expect(isDocumentTargetError(failed)).toBe(true);
      expect(asDocumentTargetError(failed)?.data).toMatchObject({
        kind: "no-match",
        selector: "Missing",
        available: ["Kept"],
      });
    }
  });

  it("TX65: a resolvable target lets the invalid schema be reported", function* () {
    // All three paths, replay included: the recorded terminal error is the
    // schema failure, and nothing replaces it with a target failure.
    for (const failed of yield* onEveryPath(BROKEN_SCHEMA, "Kept")) {
      expect(isDocumentTargetError(failed)).toBe(false);
      expect((failed as Error).name).toBe("PropsSchemaError");
    }
  });

  it("TX66: an unresolvable target with a valid schema still reports the target", function* () {
    for (const failed of yield* onEveryPath(GOOD_SCHEMA, "Missing")) {
      expect(isDocumentTargetError(failed)).toBe(true);
    }
  });

  it("TX67: the control — a resolvable target and a valid schema run", function* () {
    const info = yield* inspectDocument(inlineSource(GOOD_SCHEMA, { target: "Kept" }));
    expect(info.target).toBe("Kept");
    const text = asText(
      yield* collect(
        yield* execute({
          ...inlineSource(GOOD_SCHEMA, { target: "Kept" }),
          stream: new InMemoryStream(),
        }),
      ),
    );
    expect(text).toContain("kept body");
  });
});

/**
 * Tier TX — a Close cannot change coroutines between phases.
 *
 * The admission gate decides whether a terminal result exists; the index
 * decides whose it is. Read separately, a Close can belong to a child while the
 * gate asks and to the root while the index does — the gate admits a history it
 * believes has no terminal result, and the run then returns one, for a section
 * nobody requested.
 *
 * Recorded before the fix, resuming as Beta against an Alpha journal whose root
 * import was removed:
 *
 * ```json
 * {"requested":"Beta","ok":true,"value":"# Title\n\n## Alpha\n\nalpha content\n\n"}
 * ```
 */
describe("Tier TX — a shifting terminal coroutine", () => {
  it("TX68: a Close that moves from a child to the root returns nothing", function* () {
    const complete = new InMemoryStream();
    yield* run(inlineSource(SECTIONS, { target: "Alpha" }), complete, { names: [], ids: [] });

    let reads = 0;
    const events: DurableEvent[] = [];
    for (const event of complete.snapshot()) {
      if (event.type === "yield" && event.description.name === "__root__") {
        continue;
      }
      if (event.type === "close") {
        const close: Record<string, unknown> = { type: "close", result: event.result };
        Object.defineProperty(close, "coroutineId", {
          enumerable: true,
          get() {
            reads += 1;
            return reads === 1 ? "root.7" : "root";
          },
        });
        events.push(close as unknown as DurableEvent);
        continue;
      }
      events.push(event);
    }

    const appended: DurableEvent[] = [];
    const stream: DurableStream = {
      // deno-lint-ignore require-yield
      *readAll(): Operation<DurableEvent[]> {
        return events;
      },
      // deno-lint-ignore require-yield
      *append(event: DurableEvent): Operation<void> {
        appended.push(event);
      },
    };

    const seen: Probes = { names: [], ids: [] };
    const error = yield* scoped(function* () {
      yield* useProbes(seen);
      try {
        yield* collect(yield* execute({ ...inlineSource(SECTIONS, { target: "Beta" }), stream }));
      } catch (caught) {
        return caught;
      }
      throw new Error("the run completed instead of failing");
    });

    // Never Alpha's retained output, and never a partial answer either.
    expect((error as Error).message).toBe(UNREADABLE_RECORD);
    expect((error as Error).cause).toBe(undefined);
    expect((error as Error).message).not.toContain("alpha content");
    expect(seen.names).toEqual([]);
    expect(appended).toEqual([]);
    // The coroutine was asked once, so there was never a second answer.
    expect(reads).toBe(1);
  });
});

/**
 * Tier TX — nothing the backend still owns survives admission.
 *
 * The private gate accepts a history; public `ReplayGuard` policy runs next;
 * terminal reuse happens after that. If a Close still points at the backend's
 * own result through all of it, those two later phases are a window in which
 * the answer can be replaced — and public policy is code any enclosing scope
 * may install.
 *
 * Recorded before the fix, resuming Alpha under a `check` handler that rewrites
 * the raw Close result:
 *
 * ```json
 * {"ok":true,"value":"planted after admission","appended":0}
 * ```
 */
describe("Tier TX — a terminal result cannot be replaced after admission", () => {
  /** An intact Alpha journal whose Close carries a caller-owned result. */
  function* plantableJournal(): Operation<{
    events: DurableEvent[];
    planted: Record<string, unknown>;
  }> {
    const complete = new InMemoryStream();
    yield* run(inlineSource(SECTIONS, { target: "Alpha" }), complete, { names: [], ids: [] });

    const events: DurableEvent[] = [];
    let planted: Record<string, unknown> = {};
    for (const event of complete.snapshot()) {
      if (event.type === "close") {
        const value = parseJson(event.result.status === "ok" ? (event.result.value ?? null) : null);
        if (isJsonObject(value)) {
          planted = value;
        }
        events.push({
          type: "close",
          coroutineId: "root",
          result: { status: "ok", value },
        } as DurableEvent);
        continue;
      }
      events.push(event);
    }
    return { events, planted };
  }

  function reading(events: DurableEvent[], appended: DurableEvent[]): DurableStream {
    return {
      // deno-lint-ignore require-yield
      *readAll(): Operation<DurableEvent[]> {
        return events;
      },
      // deno-lint-ignore require-yield
      *append(event: DurableEvent): Operation<void> {
        appended.push(event);
      },
    };
  }

  it("TX69: public policy cannot rewrite the terminal result it was shown", function* () {
    const { events, planted } = yield* plantableJournal();
    const appended: DurableEvent[] = [];
    const stream = reading(events, appended);

    const text = yield* scoped(function* () {
      yield* ReplayGuard.around({
        *check([event], next) {
          // Public policy, running between private admission and terminal
          // reuse, rewriting what the backend still owns.
          planted["output"] = "planted after admission";
          planted["value"] = "planted after admission";
          return yield* next(event);
        },
      });
      return asText(
        yield* collect(yield* execute({ ...inlineSource(SECTIONS, { target: "Alpha" }), stream })),
      );
    });

    expect(text).toContain("alpha content");
    expect(text).not.toContain("planted after admission");
    expect(appended).toEqual([]);
  });

  it("TX70: a terminal result that refuses is the fixed diagnostic", function* () {
    const { events } = yield* plantableJournal();
    let asked = 0;
    const refusing = events.map((event) => {
      if (event.type !== "close") {
        return event;
      }
      const close: Record<string, unknown> = { type: "close", coroutineId: "root" };
      Object.defineProperty(close, "result", {
        enumerable: true,
        get() {
          asked += 1;
          if (asked === 1) {
            throw new Error("the backend will not produce this result");
          }
          return { status: "ok", value: "answered later" };
        },
      });
      return close as unknown as DurableEvent;
    });

    const appended: DurableEvent[] = [];
    const seen: Probes = { names: [], ids: [] };
    const error = yield* scoped(function* () {
      yield* useProbes(seen);
      try {
        yield* collect(
          yield* execute({
            ...inlineSource(SECTIONS, { target: "Alpha" }),
            stream: reading(refusing, appended),
          }),
        );
      } catch (caught) {
        return caught;
      }
      throw new Error("the run completed instead of failing");
    });

    expect((error as Error).message).toBe(UNREADABLE_RECORD);
    expect((error as Error).cause).toBe(undefined);
    expect((error as Error).message).not.toContain("answered later");
    // Read once during retention, and never retried afterwards.
    expect(asked).toBe(1);
    expect(seen.names).toEqual([]);
    expect(appended).toEqual([]);
  });

  it("TX71: the control — an intact terminal journal still replays", function* () {
    const { events } = yield* plantableJournal();
    const appended: DurableEvent[] = [];
    const text = asText(
      yield* collect(
        yield* execute({
          ...inlineSource(SECTIONS, { target: "Alpha" }),
          stream: reading(events, appended),
        }),
      ),
    );
    expect(text).toContain("alpha content");
    expect(appended).toEqual([]);
  });
});

/**
 * Tier TX — public policy observes; it does not hold authority.
 *
 * The execution-owned gate validates a history and replay consumes it. Between
 * those, public `ReplayGuard` policy runs — `check`, then `admit`, then `decide`
 * during replay — and it is code any enclosing scope may install. Handing it the
 * retained events themselves would let it rewrite the root selection, the
 * recorded content, an effect description, or a result *after* admission had
 * accepted them, which is exactly the authority the private gate exists to keep
 * out of public hands.
 *
 * Recorded before the fix, resuming a partial Alpha journal as Alpha with
 * `check` rewriting the retained root-import target to Beta: the run executed
 * the Beta projection.
 */
describe("Tier TX — guards observe a copy, not the retained history", () => {
  /** A partial Alpha journal: the recorded import, no terminal result. */
  function* partialAlpha(): Operation<InMemoryStream> {
    const complete = new InMemoryStream();
    yield* run(inlineSource(SECTIONS, { target: "Alpha" }), complete, { names: [], ids: [] });
    const partial = new InMemoryStream();
    for (const event of complete.snapshot()) {
      if (event.type === "close") {
        continue;
      }
      yield* partial.append(event);
    }
    return partial;
  }

  /** Rewrite a root-import observation the way hostile policy would. */
  function rewriteRoot(event: Yield, change: (record: Record<string, unknown>) => void): void {
    if (event.description.name !== "__root__" || event.result.status !== "ok") {
      return;
    }
    const record = event.result.value;
    if (isJsonObject(record)) {
      change(record as unknown as Record<string, unknown>);
    }
  }

  /** Resume Alpha with `install` in scope; report what ran. */
  function* resume(
    stream: InMemoryStream,
    install: () => Operation<void>,
  ): Operation<{ seen: Probes; text: string | undefined; error: unknown; appended: number }> {
    const before = stream.snapshot().length;
    const seen: Probes = { names: [], ids: [] };
    const outcome = yield* scoped(function* () {
      yield* install();
      yield* useProbes(seen);
      try {
        return {
          text: asText(
            yield* collect(
              yield* execute({ ...inlineSource(SECTIONS, { target: "Alpha" }), stream }),
            ),
          ),
          error: undefined,
        };
      } catch (error) {
        return { text: undefined, error };
      }
    });
    return { seen, ...outcome, appended: stream.snapshot().length - before };
  }

  /** Every root mismatch has the same shape of answer. */
  function expectAlphaOnly(outcome: {
    seen: Probes;
    text: string | undefined;
    error: unknown;
  }): void {
    expect(outcome.seen.names).not.toContain("beta");
    expect(outcome.text ?? "").not.toContain("beta content");
    if (outcome.error === undefined) {
      expect(outcome.text).toContain("alpha content");
    }
  }

  it("TX72: check cannot rewrite the retained root target", function* () {
    const outcome = yield* resume(yield* partialAlpha(), function* () {
      yield* ReplayGuard.around({
        *check([event], next) {
          rewriteRoot(event, (record) => {
            record["target"] = "Beta";
          });
          return yield* next(event);
        },
      });
    });
    expectAlphaOnly(outcome);
  });

  it("TX73: admit cannot rewrite the retained root target", function* () {
    const outcome = yield* resume(yield* partialAlpha(), function* () {
      yield* ReplayGuard.around({
        *admit([history], next) {
          for (const event of history.yields) {
            rewriteRoot(event, (record) => {
              record["target"] = "Beta";
            });
          }
          return yield* next(history);
        },
      });
    });
    expectAlphaOnly(outcome);
  });

  it("TX74: decide cannot rewrite the retained root target", function* () {
    const outcome = yield* resume(yield* partialAlpha(), function* () {
      yield* ReplayGuard.around({
        decide([event], next) {
          rewriteRoot(event, (record) => {
            record["target"] = "Beta";
          });
          return next(event);
        },
      });
    });
    expectAlphaOnly(outcome);
  });

  it("TX75: the recorded content and failure record are equally out of reach", function* () {
    const outcome = yield* resume(yield* partialAlpha(), function* () {
      yield* ReplayGuard.around({
        *check([event], next) {
          rewriteRoot(event, (record) => {
            record["content"] = "# Rewritten\\n\\n## Beta\\n\\nrewritten beta\\n";
            record["kind"] = "target-failure";
            record["failure"] = {
              kind: "no-match",
              selector: "Alpha",
              matches: [],
              available: [],
            };
          });
          return yield* next(event);
        },
      });
    });
    expectAlphaOnly(outcome);
    expect(outcome.text ?? "").not.toContain("rewritten beta");
  });

  it("TX76: a completed journal refused for a mismatch appends nothing", function* () {
    const complete = new InMemoryStream();
    yield* run(inlineSource(SECTIONS, { target: "Alpha" }), complete, { names: [], ids: [] });
    const outcome = yield* scoped(function* () {
      const seen: Probes = { names: [], ids: [] };
      const before = complete.snapshot().length;
      yield* useProbes(seen);
      let error: unknown;
      try {
        yield* collect(
          yield* execute({ ...inlineSource(SECTIONS, { target: "Beta" }), stream: complete }),
        );
      } catch (caught) {
        error = caught;
      }
      return { seen, error, appended: complete.snapshot().length - before };
    });
    expect(outcome.error).toBeInstanceOf(StaleInputError);
    expect(outcome.seen.names).toEqual([]);
    expect(outcome.appended).toBe(0);
  });

  it("TX77: downstream guard composition still reads its observation", function* () {
    const observed: string[] = [];
    const outcome = yield* resume(yield* partialAlpha(), function* () {
      yield* ReplayGuard.around({
        *check([event], next) {
          // An annotation on the observation: composition still works, and
          // nothing it writes reaches replay.
          Object.assign(event.description, { annotated: true });
          observed.push(event.description.name);
          return yield* next(event);
        },
      });
    });
    expect(observed).toContain("__root__");
    expectAlphaOnly(outcome);
  });
});

/**
 * Tier TX — the witness survives every wrapper a run puts on its journal.
 *
 * Journal provenance is deliberately non-transitive (#425): a wrapper is
 * unproven unless a trusted wrapping site carries its source's witness onto it,
 * and a run whose journal is unproven is refused by a Workspace provider before
 * any transaction. Core puts two wrappers on the journal a host supplies — the
 * secret filter, and the execution-owned target-admission gate — so both have
 * to be explicit about it or a live coordinator receives nothing.
 *
 * Recorded before the fix, at the exact head:
 *
 * ```json
 * {"filtered":true,"identityGate":false,"identityGateMissing":true}
 * ```
 *
 * These exercise `execute()` rather than the wrapper in isolation, because what
 * is being measured is what reaches live coordination after every wrapper.
 */
describe("Tier TX — journal provenance across the admission gate", () => {
  /** What a live durable operation's coordinator was handed. */
  interface Coordinated {
    witnesses: (JournalProvenance | undefined)[];
  }

  /**
   * A coordinator that records the provenance it is handed.
   *
   * Installed on a durable operation raised from inside a real document
   * execution, so what it sees is what core's journal — after secret filtering
   * and target admission — actually delivers to live coordination.
   */
  function witnessing(seen: Coordinated): LiveDurableOperationCoordinator {
    return {
      *run(execute, publish, activateFailure, journalProvenance) {
        seen.witnesses.push(journalProvenance);
        return yield* defaultLiveDurableOperationCoordinator.run(
          execute,
          publish,
          activateFailure,
          journalProvenance,
        );
      },
    };
  }

  /** Raise one coordinated durable operation inside the document's own run. */
  function* useWitnessProbe(seen: Coordinated): Operation<void> {
    yield* Execution.around({
      *document([props], next) {
        yield createDurableOperation<Json>(
          { type: "probe", name: "provenance" },
          // deno-lint-ignore require-yield
          function* () {
            return "probed";
          },
          { coordinator: witnessing(seen) },
        );
        return yield* next(props);
      },
    });
  }

  const LIVE = [
    "# Title",
    "",
    "## Alpha",
    "",
    "alpha content",
    "",
    "## Beta",
    "",
    "beta content",
    "",
  ].join("\n");

  /** Run `source` against `stream`, reporting what coordination witnessed. */
  function* observing(
    stream: DurableStream,
    source: RootDocumentSource,
    settings: { secretDetection?: boolean } = {},
  ): Operation<Coordinated> {
    const seen: Coordinated = { witnesses: [] };
    yield* scoped(function* () {
      yield* useWitnessProbe(seen);
      yield* collect(yield* execute({ ...source, stream, ...settings }));
    });
    return seen;
  }

  it("TX78: an untargeted run delivers the selected journal's exact witness", function* () {
    const stream = new InMemoryStream();
    const witness = establishJournalProvenance(stream);
    const seen = yield* observing(stream, inlineSource(LIVE));
    expect(seen.witnesses.length).toBeGreaterThan(0);
    for (const observed of seen.witnesses) {
      expect(observed).toBe(witness);
    }
  });

  it("TX79: a targeted run delivers the same exact witness", function* () {
    const stream = new InMemoryStream();
    const witness = establishJournalProvenance(stream);
    const seen = yield* observing(stream, inlineSource(LIVE, { target: "Alpha" }));
    expect(seen.witnesses.length).toBeGreaterThan(0);
    for (const observed of seen.witnesses) {
      expect(observed).toBe(witness);
    }
  });

  it("TX80: secret detection disabled delivers the same exact witness", function* () {
    const stream = new InMemoryStream();
    const witness = establishJournalProvenance(stream);
    const seen = yield* observing(stream, inlineSource(LIVE, { target: "Alpha" }), {
      secretDetection: false,
    });
    expect(seen.witnesses.length).toBeGreaterThan(0);
    for (const observed of seen.witnesses) {
      expect(observed).toBe(witness);
    }
  });

  it("TX81: an unproven journal stays unproven through both wrappers", function* () {
    const stream = new InMemoryStream();
    const seen = yield* observing(stream, inlineSource(LIVE, { target: "Alpha" }));
    expect(seen.witnesses.length).toBeGreaterThan(0);
    for (const observed of seen.witnesses) {
      expect(observed).toBe(undefined);
    }
  });

  it("TX82: an ordinary wrapper of a proven journal is not promoted", function* () {
    const backend = new InMemoryStream();
    establishJournalProvenance(backend);
    // A wrapper nobody trusted: generic guarding, not a wrapping site.
    const ordinary = guardDurableStream(backend, function* () {});
    const seen = yield* observing(ordinary, inlineSource(LIVE, { target: "Alpha" }));
    expect(seen.witnesses.length).toBeGreaterThan(0);
    for (const observed of seen.witnesses) {
      expect(observed).toBe(undefined);
    }
  });

  it("TX83: replay reaches no live coordination at all", function* () {
    const stream = new InMemoryStream();
    establishJournalProvenance(stream);
    yield* observing(stream, inlineSource(LIVE, { target: "Alpha" }));

    const replayed = yield* observing(stream, inlineSource(LIVE, { target: "Alpha" }));
    expect(replayed.witnesses).toEqual([]);
  });
});
