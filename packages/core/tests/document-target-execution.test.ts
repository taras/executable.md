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

/** A stream that answers reads with a substituted recorded root import. */
class PlantedStream implements DurableStream {
  readonly appended: DurableEvent[] = [];

  constructor(
    private readonly events: readonly DurableEvent[],
    private readonly planted: unknown,
  ) {}

  // deno-lint-ignore require-yield
  *readAll(): Operation<DurableEvent[]> {
    return this.events.map((event) =>
      event.type === "yield" && event.description.name === "__root__"
        ? // The one cast in this file. `Result.value` is typed `Json`, and the
          // point of these rows is to put something there that is not — which
          // is what a damaged backend does and what the boundary must survive.
          { ...event, result: { status: "ok", value: this.planted as Json } }
        : event,
    );
  }

  // deno-lint-ignore require-yield
  *append(event: DurableEvent): Operation<void> {
    this.appended.push(event);
  }
}

describe("Tier TX — unreadable recorded selections", () => {
  /** A completed journal, then a stream that answers reads with `planted`. */
  function* plantedStream(planted: unknown): Operation<PlantedStream> {
    const healthy = new InMemoryStream();
    yield* failure(inlineSource(SECTIONS, { target: "Missing" }), healthy);
    return new PlantedStream(healthy.snapshot(), planted);
  }

  /** Resume a planted journal both ways and hold every refusal to the contract. */
  function* refusesTotally(planted: unknown): Operation<void> {
    for (const target of ["Missing", "Beta"]) {
      const stream = yield* plantedStream(planted);
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
    yield* refusesTotally({
      kind: "target-failure",
      path: `${PLANTED}.md`,
      content: `---\n: [unbalanced\n  ${PLANTED}\n---\n\n# T\n`,
      failure: { kind: "no-match", selector: "Missing", matches: [], available: [] },
    });
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
    yield* refusesTotally(record);
  });

  it("TX36: a record that refuses key enumeration is malformed", function* () {
    yield* refusesTotally(
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
    );
  });

  it("TX37: a value that is not a record at all is malformed", function* () {
    for (const planted of [`a string ${PLANTED}`, 7, null, [PLANTED]]) {
      yield* refusesTotally(planted);
    }
  });
});
