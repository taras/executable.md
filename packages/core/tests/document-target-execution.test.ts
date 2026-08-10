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
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";

import { collect } from "../src/collect.ts";
import { execute } from "../src/execute.ts";
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
