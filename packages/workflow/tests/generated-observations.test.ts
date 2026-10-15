/**
 * Tier WGX — what a workflow run retains when it admits a generated fragment
 * (specs/workflow-workspace-spec.md §8.4).
 *
 * Core decides what a generated fragment *is* — what parses, what preflights,
 * which implementation a selected name runs, and what the run retains. This
 * suite is about the half that is the run's: the selection a workflow host
 * offers, what a marker-4 admission holds and does not hold, and that a
 * completed effect restores from its record rather than being performed again.
 *
 * Every row drives the public `<Evaluate>` through a real execution against the
 * selection `useWorkflowGenerated()` offers. There is no wrapper between them
 * any more: a host contributes names and forms through `Component.generated`,
 * and canonical execution reads that answer once before public policy.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, sleep, useScope, withResolvers } from "effection";
import type { Operation } from "effection";
import { createServer } from "node:http";
import { API, FETCH_NOT_PERMITTED_MESSAGE, Permissions } from "@executablemd/runtime";
import type { FetchInit, RuntimeFetchResponse } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { retainedSource, SOURCE_POSITION_FIELD } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { collect } from "@executablemd/core";
import {
  useWorkflowGenerated,
  workflowGeneratedSelection,
} from "../src/deno/workspace/evaluate.ts";
import type { GeneratedEvaluationOptions } from "../src/deno/workspace/evaluate.ts";
import { recordedFiles, useRecordedFiles } from "../../core/tests/support/fragment-files.ts";
import type { RecordedFiles } from "../../core/tests/support/fragment-files.ts";

const ROOT_PATH = "workflows/agent.md";
const URL_ONE = "https://api.example.test/one";
const URL_TWO = "https://api.example.test/two";
const NOTE = "the retained note\n";

/** What the substituted transport was asked to do. */
interface Transport {
  readonly performed: Array<{ url: string; init: FetchInit | undefined }>;
}

/**
 * A transport that stands in for one that performs the request.
 *
 * It asks `Permissions` as the first thing it does, because that is what the
 * implementation performing the operation does: the question is asked at the
 * terminal, after every contextual transformation and immediately before
 * transport. A fixture that skipped it would make every policy row here pass
 * whatever the policy said.
 */
function* useTransport(): Operation<Transport> {
  const performed: Transport["performed"] = [];
  yield* API.Fetch.around(
    {
      *fetch([url, init]): Operation<RuntimeFetchResponse> {
        if (!(yield* Permissions.operations.fetch(url, init))) {
          throw new Error(FETCH_NOT_PERMITTED_MESSAGE);
        }
        performed.push({ url, init });
        return {
          status: 200,
          headers: { get: () => null, entries: () => [] },
          *text(): Operation<string> {
            yield* sleep(0);
            return "body";
          },
        };
      },
    },
    { at: "min" },
  );
  return { performed };
}

/** What one run under one selection produced. */
interface Attempt {
  output?: string;
  failure?: string;
  events: DurableEvent[];
}

/**
 * Run one document under this host's selection.
 *
 * The selection is offered in the scope the execution runs in, which is where
 * the workflow attachment offers it: canonical execution reads that contextual
 * answer once, after initialization and the installation callbacks and before
 * public execution policy.
 */
function run(
  source: string,
  options: {
    generated?: GeneratedEvaluationOptions;
    events?: DurableEvent[];
    files?: RecordedFiles;
  } = {},
): Operation<Attempt> {
  return scoped(function* () {
    yield* useWorkflowGenerated(options.generated ?? {});
    return yield* once(source, options);
  });
}

/**
 * One execution under whatever this scope already offers.
 *
 * Separate from `run` because a row about what an installed policy decides over
 * time needs two executions while that policy is still live: a second `run`
 * would install a second policy, and the first one's scope would already have
 * ended.
 */
function once(
  source: string,
  options: { events?: DurableEvent[]; files?: RecordedFiles } = {},
): Operation<Attempt> {
  return scoped(function* () {
    const stream = new InMemoryStream(options.events ?? []);
    if (options.files !== undefined) {
      yield* useRecordedFiles(options.files);
    }
    try {
      const output = yield* collect(
        yield* executeInstalled({ ...retainedSource(ROOT_PATH, source), stream, includes: [] }, []),
      );
      return { output: String(output), events: yield* stream.readAll() };
    } catch (error) {
      return {
        failure: error instanceof Error ? error.message : String(error),
        events: yield* stream.readAll(),
      };
    }
  });
}

/** What a real server was asked, outside the policy that authorized it. */
interface Loopback {
  readonly origin: string;
  /** The bounded header of each request, as the server read it. */
  readonly received: Array<string | undefined>;
  /** Each request's method and path, for a row that asserts none arrived. */
  readonly asked: string[];
}

/**
 * A server that answers one path, torn down with the calling scope.
 *
 * Real, because the question a header bound answers is what the transport
 * sends: a substituted transport reads the request object the policy read, and
 * two differently cased spellings of one name are one header only once
 * something has actually sent them.
 */
function useLoopback(): Operation<Loopback> {
  return resource<Loopback>(function* (provide) {
    const received: Array<string | undefined> = [];
    const asked: string[] = [];
    const server = createServer((request, response) => {
      const header = request.headers["x-bound"];
      received.push(Array.isArray(header) ? header.join(", ") : header);
      asked.push(`${request.method} ${request.url}`);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("body");
    });

    const listening = withResolvers<void>();
    let onError: ((error: Error) => void) | undefined;
    yield* ensure(() => {
      if (onError) {
        server.off("error", onError);
      }
    });
    onError = (error: Error) => listening.reject(error);
    server.on("error", onError);
    server.listen(0, "127.0.0.1", () => listening.resolve());
    yield* listening.operation;

    yield* ensure(function* () {
      const closed = withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      yield* closed.operation;
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the loopback server reported no TCP address");
    }
    yield* provide({ origin: `http://127.0.0.1:${address.port}`, received, asked });
  });
}

/** Whatever this operation refused with, as text. */
function* raised(operation: Operation<unknown>): Operation<string | undefined> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A fragment that fetches one destination with these exact headers. */
function fetching(url: string, headers: Readonly<Record<string, string>>): string {
  return evaluating(
    `<Fetch url="${url}" headers={${JSON.stringify(headers)}} as="got" />\n` +
      `<Json value={got} />\n`,
  );
}

/** One fragment, as the authored element that evaluates it. */
function evaluating(fragment: string, allow: readonly string[] = ["read"]): string {
  return (
    `<Evaluate text={${JSON.stringify(fragment)}} allow={${JSON.stringify(allow)}} ` +
    `as="answer" />\n\n<Json value={answer} />\n`
  );
}

function admissions(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "generated_xmd",
  );
}

/** The policy one admission was recorded under, as the journal holds it. */
function policyOf(event: DurableEvent | undefined): Record<string, Json> | undefined {
  if (event?.type !== "yield") {
    return undefined;
  }
  const input = event.description.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  return input;
}

function reads(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "workspace_file",
  );
}

function fetches(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter((event) => event.type === "yield" && event.description.type === "fetch");
}

/** How each of these effects settled, as the journal holds it. */
function statuses(events: readonly DurableEvent[]): string[] {
  return events.map((event) => event.result.status);
}

describe("Tier WGX — the selection a workflow run offers", () => {
  it("WGX1: the generic selection is File's two spellings and the deletion", function* () {
    // A generic Workflow host offers exactly this. `<Dir>` and `<Fetch>` are
    // names a host chooses, so a run that chose neither has neither — which is
    // an absence among offered names rather than a table that happens to be
    // empty.
    expect(workflowGeneratedSelection()).toEqual({
      File: ["self-closing", "paired"],
      "File.Delete": ["self-closing"],
    });
    yield* useScope();
  });

  it("WGX2: a marker-4 admission holds the selection and nothing live", function* () {
    const files = recordedFiles({ "notes.md": NOTE });

    const attempt = yield* run(evaluating(`<File path="notes.md" />\n`), { files });

    expect(attempt.failure).toBe(undefined);
    expect(attempt.output).toContain("the retained note");
    const policy = policyOf(admissions(attempt.events)[0]);
    // The closed shape this build writes: the marker, the selected classes and
    // the rows. No Workspace basis and no request inventory — what a run stands
    // on and what a request may reach are both live state, and a grant compared
    // against a copy of either would refuse a run for its own progress.
    expect(Object.keys(policy ?? {}).toSorted()).toEqual(["allow", "allowed", "version"]);
    expect(policy?.version).toBe(4);
    expect(policy?.allow).toEqual(["read"]);
    expect(policy?.allowed).toEqual([
      {
        name: "Json",
        form: "self-closing",
        identity: "https://executable.md/components/json",
        kind: "capability",
        effect: "composition",
      },
      {
        name: "File",
        form: "self-closing",
        identity: "https://executable.md/components/file/read",
        kind: "component-answer",
        effect: "read",
      },
    ]);
  });

  it("WGX3: a fragment that asks for nothing is admitted and retains its source", function* () {
    const attempt = yield* run(evaluating("nothing to observe here.\n"));

    expect(attempt.failure).toBe(undefined);
    expect(attempt.output).toContain("nothing to observe here.");
    expect(admissions(attempt.events)).toHaveLength(1);
    expect(reads(attempt.events)).toHaveLength(0);
  });

  it("WGX4: a document with no `<Evaluate>` makes no admission at all", function* () {
    // The untaken half of the previous row: offering a selection is not
    // evaluating anything, so a run that never writes the element appends no
    // admission and resolves nothing on its behalf.
    const attempt = yield* run("The run wrote no fragment.\n");

    expect(attempt.failure).toBe(undefined);
    expect(attempt.output).toContain("The run wrote no fragment.");
    expect(admissions(attempt.events)).toHaveLength(0);
  });

  it("WGX5: a name this host did not offer is refused before any effect", function* () {
    const files = recordedFiles({ "notes.md": NOTE });

    // `<Glob />` is a core default this host did not choose. A generic workflow
    // run therefore has no search at all, and the refusal lands before the read
    // beside it in the same fragment.
    const attempt = yield* run(
      evaluating(`<Glob include={["*.md"]} as="paths" />\n<File path="notes.md" />\n`),
      { files },
    );

    expect(attempt.failure).toContain("did not admit");
    expect(files.performed).toEqual([]);
    expect(admissions(attempt.events).length).toBeLessThanOrEqual(1);
    expect(reads(attempt.events)).toHaveLength(0);
  });
});

describe("Tier WGX — what an admitted request may reach is live", () => {
  it("WGX6: a host that bounds no request offers `<Fetch>` not at all", function* () {
    const transport = yield* useTransport();

    const attempt = yield* run(evaluating(`<Fetch url="${URL_ONE}" as="got" />\n`));

    expect(attempt.failure).toContain("did not admit");
    expect(transport.performed).toHaveLength(0);
  });

  it("WGX7: a bounded destination performs once and retains one observation", function* () {
    const transport = yield* useTransport();

    const attempt = yield* run(
      evaluating(`<Fetch url="${URL_ONE}" as="got" />\n<Json value={got} />\n`),
      { generated: { requests: [{ url: URL_ONE }] } },
    );

    expect(attempt.failure).toBe(undefined);
    expect(transport.performed.map((call) => call.url)).toEqual([URL_ONE]);
    expect(fetches(attempt.events)).toHaveLength(1);
  });

  it("WGX8: a destination outside the bound reaches no transport", function* () {
    const transport = yield* useTransport();

    // The name is offered — this host bounds a request — and the destination is
    // not. So the refusal is the live terminal's, asked immediately before
    // transport, and nothing is sent.
    const attempt = yield* run(
      evaluating(`<Fetch url="${URL_TWO}" as="got" />\n<Json value={got} />\n`),
      { generated: { requests: [{ url: URL_ONE }] } },
    );

    expect(attempt.failure).toContain("not permitted in this scope");
    expect(transport.performed).toHaveLength(0);
  });

  it("WGX9: a bound this host stated cannot be moved by editing what it was given", function* () {
    const transport = yield* useTransport();
    const bound = { url: URL_ONE, headers: { "x-bound": "stated" } };

    yield* scoped(function* () {
      // One installed policy for the whole row. The edit below happens while
      // this is still the thing deciding requests, which is the only place an
      // in-place edit could have moved anything.
      yield* useWorkflowGenerated({ requests: [bound] });

      const stated = yield* once(fetching(URL_ONE, { "x-bound": "stated" }));
      expect(stated.failure).toBe(undefined);
      expect(transport.performed).toHaveLength(1);

      // The host still holds the object it passed, and edits it here.
      bound.url = URL_TWO;
      bound.headers["x-bound"] = "changed";

      // What it stated is still admitted: the policy compares against the copy
      // it captured, not against the object it was handed.
      const again = yield* once(fetching(URL_ONE, { "x-bound": "stated" }));
      expect(again.failure).toBe(undefined);
      expect(transport.performed).toHaveLength(2);

      // And what the edit tried to admit was never bounded. Both halves of it
      // are refused — the destination and the header value.
      const moved = yield* once(fetching(URL_TWO, { "x-bound": "changed" }));
      expect(moved.failure).toContain("not permitted in this scope");
      const changed = yield* once(fetching(URL_ONE, { "x-bound": "changed" }));
      expect(changed.failure).toContain("not permitted in this scope");
      expect(transport.performed).toHaveLength(2);
    });
  });

  it("WGX13: a header a transformation added is compared as the transport will send it", function* () {
    // The real terminal and a real server, because this row is about the
    // difference between the request a policy read and the request that goes
    // out. Nothing substitutes `API.Fetch`: the terminal asks `Permissions`
    // itself, after every transformation and immediately before transport.
    const server = yield* useLoopback();
    const url = `${server.origin}/bounded`;

    // Positive control: the request the host bounded, unchanged, reaches the
    // server carrying exactly the header that was stated.
    const allowed = yield* run(fetching(url, { "x-bound": "admitted" }), {
      generated: { requests: [{ url, headers: { "x-bound": "admitted" } }] },
    });
    expect(allowed.failure).toBe(undefined);
    expect(server.received).toEqual(["admitted"]);
    expect(fetches(allowed.events)).toHaveLength(1);

    // The same bound, with middleware that adds a differently cased spelling of
    // the bounded name. A transport joins the two into one sent header, so the
    // value that would go out is neither the bounded one nor anything this host
    // stated — and the request is refused before transport starts.
    const transformed = yield* scoped(function* () {
      yield* API.Fetch.around({
        *fetch([input, init], next) {
          return yield* next(input, {
            ...init,
            headers: { "X-Bound": "EXTRA", ...(init?.headers ?? {}) },
          });
        },
      });
      return yield* run(fetching(url, { "x-bound": "admitted" }), {
        generated: { requests: [{ url, headers: { "x-bound": "admitted" } }] },
      });
    });

    // Asked first, because it is the whole question: the server was asked once
    // in this row, by the control, and the transformed request reached it not
    // at all. A comparator that read a collapsed copy of the headers would let
    // this one through carrying `EXTRA, admitted`.
    expect(server.received).toEqual(["admitted"]);
    expect(transformed.failure).toContain("not permitted in this scope");
    // What it retained is the refusal, not an observation: the request was
    // refused where it would have been sent, so there is no response here to
    // restore from.
    expect(statuses(fetches(transformed.events))).toEqual(["err"]);
  });

  it("WGX14: a bound naming one header twice is refused where it is stated", function* () {
    const transport = yield* useTransport();

    // The host's own statement, read the same way the outgoing request is. Two
    // spellings of one name state no value for it, so this is refused where the
    // host installs it rather than becoming whichever one it happened to list
    // last — and no selection is offered under a bound nobody settled.
    const refusal = yield* raised(
      scoped(function* () {
        yield* useWorkflowGenerated({
          requests: [{ url: URL_ONE, headers: { "X-Bound": "first", "x-bound": "second" } }],
        });
      }),
    );

    expect(refusal).toContain("two spellings of one header name");
    expect(transport.performed).toHaveLength(0);
  });

  it("WGX15: the request allowance is read once, and `<Fetch>` comes from that reading", function* () {
    const server = yield* useLoopback();
    let reads = 0;
    // An ordinary accessor-backed options object, which is all a host has to be
    // for this to matter: the first reading states no bound and a later one
    // states one. Whichever this host meant, the name a fragment may write and
    // the policy deciding what it may reach have to come from one reading.
    const changing: GeneratedEvaluationOptions = {
      get requests() {
        reads++;
        return reads === 1 ? [] : [{ url: `${server.origin}/admitted` }];
      },
    };

    const attempt = yield* run(
      evaluating(`<Fetch url="${server.origin}/not-admitted" as="got" />\n<Json value={got} />\n`),
      { generated: changing },
    );

    // Asked first, because it is the consequence: the destination the fragment
    // names is one no reading of this host's list ever admitted, and a
    // selection taken from a second reading would send it under no policy at
    // all.
    expect(server.asked).toEqual([]);
    // The retained reading bounded nothing, so `<Fetch>` was never offered: the
    // fragment is refused at admission, by name, and retains no effect.
    expect(attempt.failure).toContain("did not admit");
    expect(fetches(attempt.events)).toEqual([]);
    // One reading for the whole setup. A second one is what would let the
    // selection and the policy disagree about the same host statement.
    expect(reads).toBe(1);
  });

  it("WGX10: an enclosing restriction still refuses what this host bounded", function* () {
    const transport = yield* useTransport();

    const attempt = yield* scoped(function* () {
      // Narrower than the host, installed outside it. A restriction delegates
      // rather than answering `true`, so the enclosing refusal is never asked
      // to delegate and the bound cannot widen it.
      yield* Permissions.around({ fetch: () => false });
      return yield* run(evaluating(`<Fetch url="${URL_ONE}" as="got" />\n<Json value={got} />\n`), {
        generated: { requests: [{ url: URL_ONE }] },
      });
    });

    expect(attempt.failure).toContain("not permitted in this scope");
    expect(transport.performed).toHaveLength(0);
  });
});

describe("Tier WGX — a completed effect restores from its record", () => {
  it("WGX11: a completed read restores with a throwing provider and no Workspace scan", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const source = evaluating(`<File path="notes.md" />\n`);

    const first = yield* run(source, { files });
    expect(first.failure).toBe(undefined);
    expect(files.performed).toEqual(["read notes.md"]);

    // The same document over its own journal, with a provider that throws for
    // every operation and a `Permissions` that refuses every one. A completed
    // local effect restores its recorded result without entering its live I/O
    // callback, asking Permissions, or inventorying the filesystem — so this
    // run reaches none of the three.
    const asked: string[] = [];
    const replayed = yield* scoped(function* () {
      yield* Permissions.around({
        files: ([operation]) => {
          asked.push(String(operation));
          return false;
        },
      });
      return yield* run(source, {
        events: first.events,
        files: {
          ...files,
          // deno-lint-ignore require-yield
          *readTextFile(): Operation<never> {
            throw new Error("the live provider was reached");
          },
        },
      });
    });

    expect(replayed.failure).toBe(undefined);
    expect(replayed.output).toBe(first.output);
    // Permissions was never asked, the throwing provider was never entered, and
    // the recorder shows the one read the first run performed and no second.
    expect(asked).toEqual([]);
    expect(files.performed).toEqual(["read notes.md"]);
  });

  it("WGX12: the admission carries the authored site, and an aligned continuation replays", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const source = evaluating(`<File path="notes.md" />\n`);

    const first = yield* run(source, { files });
    expect(first.failure).toBe(undefined);
    const admission = admissions(first.events)[0];
    if (admission?.type !== "yield") {
      throw new Error("the run recorded no generated-XMD admission");
    }
    // Where the authored element was written, as diagnostic journal data beside
    // the admission's identity.
    expect(admission.description[SOURCE_POSITION_FIELD]).toMatchObject({ path: ROOT_PATH });

    // A continuation of the retained history: the admission and the nested read
    // replay aligned, so nothing is admitted twice and no read is performed
    // again.
    const again = yield* run(source, { events: first.events, files });

    expect(again.failure).toBe(undefined);
    expect(again.output).toBe(first.output);
    expect(admissions(again.events)).toHaveLength(1);
    expect(files.performed).toEqual(["read notes.md"]);
  });
});
