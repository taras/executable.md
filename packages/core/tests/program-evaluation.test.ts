/**
 * Tier PE — evaluating a complete XMD program
 * (specs/executable-mdx-spec.md §5.7).
 *
 * `<Evaluate>` is a composition site: it admits a complete root and runs it in
 * the current execution. Everything here is about one of four claims.
 *
 * **Composition is explicit, and the two forms mean the same thing.** A program
 * produced inside the element and a program supplied as `program` admit the
 * same bytes and the same digest, and a producer's own output never reaches the
 * surrounding document.
 *
 * **The root's own contract decides the result.** Text and value roots follow
 * their `<Output>` and `returns` rules, and explicit props are validated
 * against the program's schema before anything runs.
 *
 * **Ambiguity refuses before effects.** A structural preflight case puts a
 * negative-control effect after a malformed construct and proves it did not
 * run.
 *
 * **One occurrence keeps one decision.** The admission retains the exact
 * source, digest, props, origin and mode; a continuation restores it, a changed
 * program at the same site is stale input, and two sites are two executions
 * whatever their digests say.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";

import { createDurableOperation, InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";

import { executeInstalled, programEvaluationComponents, sourceDigest } from "../host.ts";
import type { DeclaredMarkdownComponent, IdentityClaimant, IdentityComponent } from "../host.ts";
import type { ComponentInvocation } from "../src/invocation-identity.ts";
import { pairedProgramSource, programDigest } from "../host.ts";
import { retainedSource } from "../src/root-source.ts";
import type { Json } from "../src/types.ts";

const ROOT_PATH = "documents/compose.md";

interface Attempt {
  readonly output?: string;
  readonly failure?: string;
  readonly events: DurableEvent[];
}

/**
 * A durable effect a program can perform, and a record of every time it really
 * happened.
 *
 * The list is what tells a restored effect from a repeated one: replay hands
 * back the retained result without entering the executor, so an entry here
 * means this run performed the effect rather than remembering it.
 */
const performed: string[] = [];

/**
 * The approved bytes a source-producing component returns.
 *
 * This is what `<Plan>` hands back: a complete root ending in its own newline.
 * Core has no `<Plan>`, so the equivalence of the two compositions is proved
 * against a stand-in that returns exactly what one does.
 */
const APPROVED = "# Report\n\nThe program ran.\n";

/**
 * What the producer returns on the next run.
 *
 * A resumed evaluation is one where the document is unchanged and the producer
 * is not: the element is the same occurrence, written at the same offset, and
 * what it is being handed differs. Changing the document text instead would
 * move the element and ask about a different occurrence entirely.
 */
let approved = APPROVED;

/** Every time a producer really rendered its approved source. */
const produced: string[] = [];

function probeComponents(origin = "test/probe"): readonly IdentityComponent[] {
  return [
    {
      name: "Source",
      origin: "test/source",
      props: { type: "object", properties: {}, additionalProperties: false },
      // The claim is unspent: this stands in for a text component that returns
      // approved source, and naming durable work is not what it is here for.
      factory: () =>
        // deno-lint-ignore require-yield
        function* Source(): Operation<Json> {
          produced.push(approved);
          return approved;
        },
    },
    {
      name: "Probe",
      origin,
      props: {
        type: "object",
        properties: { mark: { type: "string" } },
        required: ["mark"],
        additionalProperties: false,
      },
      factory: (claim: IdentityClaimant) =>
        function* Probe(
          elementProps: Record<string, Json>,
          invocation: ComponentInvocation,
        ): Operation<Json> {
          const mark = String(elementProps.mark);
          const id = yield* claim(invocation);
          const stored = yield createDurableOperation<string>(
            { type: "probe", name: `probe:${id}` },
            // deno-lint-ignore require-yield
            function* () {
              performed.push(mark);
              return `performed ${mark}`;
            },
          );
          return String(stored);
        },
    },
  ];
}

/** Run one document with `<Evaluate>` declared, exactly as a run profile does. */
function run(
  source: string,
  options: {
    stream?: InMemoryStream;
    /** The origin `<Probe>` is registered under, so a site can be moved. */
    probeOrigin?: string;
    declarations?: readonly DeclaredMarkdownComponent[];
    privates?: readonly IdentityComponent[];
  } = {},
): Operation<Attempt> {
  return scoped(function* () {
    const stream = options.stream ?? new InMemoryStream();
    const execution = yield* executeInstalled(
      { ...retainedSource(ROOT_PATH, source), stream, includes: [] },
      [
        {
          components: [...programEvaluationComponents(), ...probeComponents(options.probeOrigin)],
          ...(options.declarations === undefined ? {} : { declarations: options.declarations }),
        },
      ],
    );
    const result = yield* execution;
    const events = yield* stream.readAll();
    return result.ok
      ? { output: typeof result.value === "string" ? result.value : "", events }
      : { failure: result.error.message, events };
  });
}

/**
 * The journal a run interrupted immediately after one effect would hold.
 *
 * A completed journal replays as a terminal result, which proves nothing about
 * restoration: the run never re-enters its own body. Truncating after the event
 * a run committed is exactly the history an interruption leaves behind, and it
 * is what a partial continuation is offered.
 */
function through(events: DurableEvent[], type: string): DurableEvent[] {
  const index = events.findIndex(
    (event) => event.type === "yield" && event.description.type === type,
  );
  if (index === -1) {
    throw new Error(`the run recorded no ${type} event`);
  }
  return events.slice(0, index + 1);
}

/** Every complete-program admission this run recorded. */
function admissions(events: DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "evaluate_program",
  );
}

/** What one admission decided, and the terms it was granted under. */
function decision(event: DurableEvent): Record<string, Json> {
  const result = event.type === "yield" ? event.result : undefined;
  if (result === undefined || result.status !== "ok") {
    throw new Error("the admission did not settle successfully");
  }
  return result.value as Record<string, Json>;
}

describe("Tier PE — complete-program evaluation", () => {
  it("PE1 evaluates a program supplied as `program`", function* () {
    const attempt = yield* run(
      [
        '<Let value={"# Report\\n\\nThe program ran.\\n"} as="plan" />',
        "",
        "<Evaluate program={plan} />",
        "",
      ].join("\n"),
    );

    expect(attempt.failure).toBeUndefined();
    expect(attempt.output).toContain("The program ran.");
    expect(admissions(attempt.events)).toHaveLength(1);
  });

  it("PE2 evaluates a producer's program once and emits none of its source", function* () {
    produced.length = 0;
    const attempt = yield* run(["<Evaluate>", "  <Source />", "</Evaluate>", ""].join("\n"));

    expect(attempt.failure).toBeUndefined();
    // The program ran, so its own rendered line is here.
    expect(attempt.output).toContain("The program ran.");
    // Once. The producer rendered the source into the private buffer and none
    // of those bytes reached the document: a second copy would mean the
    // approved source was emitted beside the evaluation.
    expect(attempt.output?.split("The program ran.")).toHaveLength(2);
    // The heading is the program's own rendered output, and it appears once
    // for the same reason: the source the producer emitted was buffered, not
    // written into the document beside the evaluation.
    expect(attempt.output?.split("# Report")).toHaveLength(2);
    expect(produced).toEqual([APPROVED]);
  });

  it("PE3 admits the same bytes and digest for the direct and deferred forms", function* () {
    const paired = yield* run(["<Evaluate>", "  <Source />", "</Evaluate>", ""].join("\n"));
    const deferred = yield* run(
      [
        `<Let value={${JSON.stringify(APPROVED)}} as="plan" />`,
        "",
        "<Evaluate program={plan} />",
        "",
      ].join("\n"),
    );

    const pairedTerms = decision(admissions(paired.events)[0]!);
    const deferredTerms = decision(admissions(deferred.events)[0]!);
    // The paired projection equals the captured bytes naturally: the wrapper's
    // own line breaks came off and the producer's newline stayed.
    expect(pairedTerms.source).toBe(APPROVED);
    expect(deferredTerms.source).toBe(APPROVED);
    expect((pairedTerms.terms as Record<string, Json>).digest).toBe(
      (deferredTerms.terms as Record<string, Json>).digest,
    );
  });
});

describe("Tier PE — the program source a form admits", () => {
  // deno-lint-ignore require-yield
  it("PE4 takes off the paired wrapper's framing and nothing else", function* () {
    // A producer's result spliced after the wrapper's line break and indent.
    // One line break comes off each end, so the producer's own trailing
    // newline survives.
    expect(pairedProgramSource("\n  # Report\n\nBody\n\n")).toBe("# Report\n\nBody\n");
    // A program written out literally: the indentation every line shares is the
    // wrapper's, and the last line break is the closing tag's.
    expect(pairedProgramSource("\n  # Report\n\n  Body\n")).toBe("# Report\n\nBody");
    // Blank lines inside keep whatever the author put on them.
    expect(pairedProgramSource("\n  # Report\n  \n  Body\n")).toBe("# Report\n  \nBody");
    // Written on one line, there is no framing to take off.
    expect(pairedProgramSource("# Report")).toBe("# Report");
  });

  // deno-lint-ignore require-yield
  it("PE5 leaves `program` bytes exactly as supplied", function* () {
    // The discriminator: whitespace at either end of a supplied program is part
    // of the program. Nothing here goes through the paired framing rule, so a
    // digest taken of it is a digest of what the author handed over.
    const padded = "\n\n# Report\n\n\n";
    expect(programDigest(padded)).not.toBe(programDigest("# Report\n"));
    expect(programDigest(padded)).not.toBe(programDigest(pairedProgramSource(padded)));
    expect(programDigest("# R\n")).not.toBe(programDigest("# S\n"));
  });
});

/** A value root that answers with what its props said. */
const VALUE_PROGRAM = [
  "---",
  "props:",
  "  release:",
  "    type: string",
  "returns:",
  "  type: object",
  "  properties:",
  "    version: { type: string }",
  "  required: [version]",
  "---",
  "",
  "<Return value={{ version: props.release }} />",
  "",
].join("\n");

/** A text root that reads a prop its own schema declares. */
const TEXT_PROGRAM = [
  "---",
  "props:",
  "  release:",
  "    type: string",
  "    default: none",
  "---",
  "",
  "Release {props.release} ran.",
  "",
].join("\n");

describe("Tier PE — program forms", () => {
  it("PE6 binds a value root's schema-validated result under `as`", function* () {
    const attempt = yield* run(
      [
        `<Let value={${JSON.stringify(VALUE_PROGRAM)}} as="plan" />`,
        "",
        '<Evaluate program={plan} props={{ release: "1.4.0" }} as="decided" />',
        "",
        "Version {decided.version}.",
        "",
      ].join("\n"),
    );

    expect(attempt.failure).toBeUndefined();
    expect(attempt.output).toContain("Version 1.4.0.");
  });

  it("PE7 refuses a value root written without `as`, before program effects", function* () {
    const attempt = yield* run(
      [
        `<Let value={${JSON.stringify(VALUE_PROGRAM)}} as="plan" />`,
        "",
        '<Evaluate program={plan} props={{ release: "1.4.0" }} />',
        "",
      ].join("\n"),
    );

    expect(attempt.failure ?? attempt.output ?? "").toContain("requires `as`");
  });

  it("PE8 renders a text root's output where it is written", function* () {
    const attempt = yield* run(
      [
        `<Let value={${JSON.stringify(TEXT_PROGRAM)}} as="plan" />`,
        "",
        '<Evaluate program={plan} props={{ release: "1.4.0" }} />',
        "",
      ].join("\n"),
    );

    expect(attempt.failure).toBeUndefined();
    expect(attempt.output).toContain("Release 1.4.0 ran.");
  });

  it("PE9 binds a text root's selected output under `as` and emits none of it", function* () {
    const attempt = yield* run(
      [
        `<Let value={${JSON.stringify(TEXT_PROGRAM)}} as="plan" />`,
        "",
        '<Evaluate program={plan} props={{ release: "1.4.0" }} as="report" />',
        "",
        "Captured: {report}",
        "",
      ].join("\n"),
    );

    expect(attempt.failure).toBeUndefined();
    expect(attempt.output).toMatch(/Captured:\s*Release 1\.4\.0 ran\./);
    expect(attempt.output?.split("Release 1.4.0 ran.")).toHaveLength(2);
  });
});

describe("Tier PE — root props", () => {
  it("PE10 defaults to no props rather than adopting the caller's", function* () {
    const attempt = yield* run(
      [
        `<Let value={${JSON.stringify(TEXT_PROGRAM)}} as="plan" />`,
        "",
        "<Evaluate program={plan} />",
        "",
      ].join("\n"),
    );

    expect(attempt.failure).toBeUndefined();
    expect(attempt.output).toContain("Release none ran.");
  });

  it("PE11 refuses props the program's own schema refuses", function* () {
    const attempt = yield* run(
      [
        `<Let value={${JSON.stringify(VALUE_PROGRAM)}} as="plan" />`,
        "",
        '<Evaluate program={plan} props={{ release: 14 }} as="decided" />',
        "",
      ].join("\n"),
    );

    expect(attempt.failure ?? attempt.output ?? "").toContain("props the program's own schema");
  });
});

describe("Tier PE — ambiguous and misplaced forms", () => {
  it("PE12 refuses `program` written with content, before the content runs", function* () {
    const attempt = yield* run(
      [
        '<Let value={"Ran.\\n"} as="plan" />',
        "",
        "<Evaluate program={plan}>",
        "Body that must not become a program.",
        "</Evaluate>",
        "",
      ].join("\n"),
    );

    expect(attempt.failure ?? attempt.output ?? "").toContain("not both");
    expect(admissions(attempt.events)).toHaveLength(0);
  });

  it("PE13 refuses an element that names no program at all", function* () {
    const attempt = yield* run("<Evaluate />\n");

    expect(attempt.failure ?? attempt.output ?? "").toContain("evaluates a program");
    expect(admissions(attempt.events)).toHaveLength(0);
  });
});

describe("Tier PE — one artifact, one occurrence", () => {
  it("PE14 executes two sites independently and does not deduplicate by digest", function* () {
    const attempt = yield* run(
      [
        '<Let value={"Ran once.\\n"} as="plan" />',
        "",
        "<Evaluate program={plan} />",
        "",
        "<Evaluate program={plan} />",
        "",
      ].join("\n"),
    );

    expect(attempt.failure).toBeUndefined();
    expect(attempt.output?.split("Ran once.")).toHaveLength(3);
    const recorded = admissions(attempt.events);
    expect(recorded).toHaveLength(2);
    const names = recorded.map((event) =>
      event.type === "yield" ? event.description.name : undefined,
    );
    expect(new Set(names).size).toBe(2);
  });

  it("PE15 refuses a changed program at the same occurrence, and neither runs", function* () {
    const document = ["<Evaluate>", "  <Source />", "</Evaluate>", ""].join("\n");
    performed.length = 0;
    approved = '<Probe mark="first" />\n';

    const first = yield* run(document);
    expect(first.failure).toBeUndefined();
    expect(performed).toEqual(["first"]);

    // The history an interruption right after the admission leaves behind. A
    // completed journal would replay as a terminal result and never re-enter
    // this element at all, which would prove nothing about what it decides.
    const interrupted = through(first.events, "evaluate_program");
    performed.length = 0;
    approved = '<Probe mark="second" />\n';

    const replayed = yield* run(document, { stream: new InMemoryStream(interrupted) });

    expect(replayed.failure ?? replayed.output ?? "").toContain("different program");
    // Neither source won: the current program never ran, and the retained one
    // was not run in its place.
    expect(performed).toEqual([]);
    approved = APPROVED;
  });

  it("PE16 resumes on the retained program and restores its completed effect", function* () {
    const document = ["<Evaluate>", "  <Source />", "</Evaluate>", ""].join("\n");
    performed.length = 0;
    approved = '<Probe mark="one" />\n\nRestored program.\n';

    const first = yield* run(document);
    expect(first.failure).toBeUndefined();
    expect(first.output).toContain("Restored program.");
    expect(performed).toEqual(["one"]);

    // Interrupted after the program's own nested effect committed.
    const interrupted = through(first.events, "probe");
    performed.length = 0;
    produced.length = 0;

    const replayed = yield* run(document, { stream: new InMemoryStream(interrupted) });

    expect(replayed.failure).toBeUndefined();
    expect(replayed.output).toContain("Restored program.");
    // This run really re-entered the element rather than replaying a terminal
    // result: the producer rendered again. Without it the rest of this case
    // would pass against a history that was never continued.
    expect(produced).toHaveLength(1);
    // The effect was restored from the journal rather than performed again:
    // nothing entered its executor on this run.
    expect(performed).toEqual([]);
    expect(admissions(replayed.events)).toHaveLength(1);
    approved = APPROVED;
  });
});

describe("Tier PE — a program that fails", () => {
  it("PE17 stops at the failure and runs nothing after it", function* () {
    performed.length = 0;
    const attempt = yield* run(
      [
        `<Let value={${JSON.stringify(
          '<Probe mark="before" />\n\n<Fail message="the program stopped" />\n\n<Probe mark="after" />\n',
        )}} as="plan" />`,
        "",
        "<Evaluate program={plan} />",
        "",
      ].join("\n"),
    );

    expect(attempt.failure ?? attempt.output ?? "").toContain("the program stopped");
    // The effect written before the failure happened; the one after it did not.
    // A program that stopped must not leave later steps looking as though they
    // ran.
    expect(performed).toEqual(["before"]);
  });
});

/**
 * Rewrite what the retained admission says, leaving the run's own history
 * otherwise intact.
 *
 * The record is the one thing a continuation trusts, and a journal is a file:
 * this is what it looks like when the file no longer says what this evaluation
 * wrote. Nothing else about the interrupted run is touched, so a case that
 * refuses here refuses because of the record and not because the history around
 * it stopped adding up.
 */
function tamper(
  events: DurableEvent[],
  change: (record: Record<string, Json>) => Json,
): DurableEvent[] {
  return events.map((event) => {
    if (event.type !== "yield" || event.description.type !== "evaluate_program") {
      return event;
    }
    const result = event.result;
    if (result.status !== "ok") {
      return event;
    }
    const record = result.value as Record<string, Json>;
    return { ...event, result: { ...result, value: change({ ...record }) } };
  });
}

/** A program whose one effect is a probe, so "did anything run" is answerable. */
const PROBING = '<Probe mark="one" />\n\nRestored program.\n';

/** The document every hostile-record case resumes, unchanged between runs. */
const PROBING_DOCUMENT = ["<Evaluate>", "  <Source />", "</Evaluate>", ""].join("\n");

/** Interrupt a run of `PROBING` right after its admission committed. */
function* admitted(): Operation<DurableEvent[]> {
  performed.length = 0;
  approved = PROBING;
  const first = yield* run(PROBING_DOCUMENT);
  expect(first.failure).toBeUndefined();
  expect(performed).toEqual(["one"]);
  return through(first.events, "evaluate_program");
}

describe("Tier PE — the retained admission is hostile data", () => {
  it("PE18 refuses a retained source that no longer hashes to its digest", function* () {
    const interrupted = yield* admitted();
    performed.length = 0;

    // Only the source moves. The digest, the terms and the current request are
    // all exactly what they were, so nothing but the record's own internal
    // agreement can catch this.
    const replayed = yield* run(PROBING_DOCUMENT, {
      stream: new InMemoryStream(
        tamper(interrupted, (record) => ({
          ...record,
          source: '<Probe mark="substituted" />\n\nRestored program.\n',
        })),
      ),
    });

    expect(replayed.failure ?? replayed.output ?? "").toContain("cannot be read as one");
    // Neither source ran: not the substituted one, and not the one the current
    // producer would have offered in its place.
    expect(performed).toEqual([]);
  });

  it("PE19 refuses every corrupted member of the retained record", function* () {
    const interrupted = yield* admitted();

    const corruptions: Record<string, (record: Record<string, Json>) => Json> = {
      "validated props": (record) => ({ ...record, validated: { release: "substituted" } }),
      "root mode": (record) => ({ ...record, mode: "value" }),
      "a missing member": ({ validated: _validated, ...rest }) => rest,
      "an additional member": (record) => ({ ...record, admitted: true }),
      "a misspelled member": ({ validated, ...rest }) => ({ ...rest, validatedProps: validated }),
      "a component entry": (record) => ({
        ...record,
        named: [{ name: "Probe", form: "paired", identity: "registered:default:test/probe" }],
      }),
      "a component entry's shape": (record) => ({
        ...record,
        named: [{ name: "Probe", form: "self-closing" }],
      }),
      "the terms' shape": (record) => ({
        ...record,
        terms: { ...(record.terms as Record<string, Json>), extra: 1 },
      }),
      "the whole record": () => "admitted",
    };

    for (const [what, change] of Object.entries(corruptions)) {
      performed.length = 0;
      const replayed = yield* run(PROBING_DOCUMENT, {
        stream: new InMemoryStream(tamper(interrupted, change)),
      });

      expect(`${what}: ${replayed.failure ?? replayed.output ?? ""}`).toContain(
        "cannot be read as one",
      );
      expect([what, performed]).toEqual([what, []]);
    }
  });

  it("PE20 refuses a continuation whose site answers a name differently", function* () {
    const interrupted = yield* admitted();

    // The same document, the same producer, the same bytes — and `<Probe>`
    // registered under another origin, which is a different implementation
    // however identically it behaves.
    performed.length = 0;
    const moved = yield* run(PROBING_DOCUMENT, {
      stream: new InMemoryStream(interrupted),
      probeOrigin: "test/probe-replacement",
    });

    expect(moved.failure ?? moved.output ?? "").toContain("resolves differently");
    expect(performed).toEqual([]);

    // The unchanged site resumes, which is what makes the refusal above about
    // the identity rather than about resuming at all.
    performed.length = 0;
    const unchanged = yield* run(PROBING_DOCUMENT, {
      stream: new InMemoryStream(interrupted),
    });

    expect(unchanged.failure).toBeUndefined();
    expect(unchanged.output).toContain("Restored program.");
    // The history stops at the admission, so the program's own effect had not
    // committed and legitimately happens now. What matters is that it happened
    // at all: the refusal above stopped a run this one completes.
    expect(performed).toEqual(["one"]);
  });
});

describe("Tier PE — structural admission precedes every program effect", () => {
  it("PE21 refuses a malformed construct after an effect, and the effect never runs", function* () {
    performed.length = 0;
    // The negative control is first, so a preflight that ran while the program
    // expanded would have performed it before reaching the malformed element.
    approved = ['<Probe mark="before" />', "", "<Return value={1} />", ""].join("\n");

    const attempt = yield* run(PROBING_DOCUMENT);

    expect(attempt.failure ?? attempt.output ?? "").toContain("body structure is not valid");
    expect(performed).toEqual([]);
    approved = APPROVED;
  });
});

/** The origin the declared outer component reports. */
const POLICY_ORIGIN = "@executablemd/test/Policy.md";

/**
 * A private component that records each entry into its implementation.
 *
 * A tripwire rather than a fake: what this case has to show is that the
 * implementation did not run, and a refusal in the output cannot show that on
 * its own.
 */
function watching(entered: string[]): IdentityComponent {
  return {
    name: "Secret",
    origin: `${POLICY_ORIGIN}#Secret`,
    props: { type: "object", properties: {}, additionalProperties: false },
    returns: { type: "string" },
    forms: ["self-closing"],
    // deno-lint-ignore require-yield
    factory: (_claim: IdentityClaimant) =>
      function* Secret(): Operation<string> {
        entered.push("Secret");
        return "the private answer";
      },
  };
}

describe("Tier PE — a producer's private closure does not cross", () => {
  it("PE22 leaves a declaration's private name unavailable to the program it evaluates", function* () {
    const entered: string[] = [];
    performed.length = 0;
    // The program names the private component the *enclosing declaration*
    // carries, and an ordinary site-authorized one beside it.
    approved = ['<Probe mark="control" />', "", "<Secret />", ""].join("\n");

    const body = ["<Evaluate>", "  <Source />", "</Evaluate>", ""].join("\n");
    const attempt = yield* run("<Policy />\n", {
      declarations: [
        {
          name: "Policy",
          origin: POLICY_ORIGIN,
          source: body,
          digest: sourceDigest(body),
          privates: [watching(entered)],
        },
      ],
    });

    const reported = attempt.failure ?? attempt.output ?? "";
    // The name resolves to nothing inside the program, exactly as it does for
    // any other bytes that are not the declaration's own.
    expect(reported).toContain("Cannot resolve component: Secret");
    // And nothing of it ran: a refusal that reached the implementation first
    // would leave a mark here.
    expect(entered).toEqual([]);
    // The positive control: a component the site does authorize runs normally,
    // so this is about the closure rather than about programs reaching nothing.
    expect(performed).toEqual(["control"]);
    approved = APPROVED;
  });
});
