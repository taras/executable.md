/**
 * The durable envelope an owned Issue operation runs inside, and the
 * compatibility it owes the profile that used to be the only one.
 *
 * Portable on purpose: the envelope is provider-neutral — a request encoding, a
 * durable name, one live callback and the validation around it — so it is held
 * to the same rules under every runtime the CLI starts on. Nothing here opens a
 * socket or reads a credential: the live callback is the suite's, which is
 * exactly the seam the workers exist to offer.
 *
 * The two halves are:
 *
 * - **E1, the envelope.** One live attempt per position, the composed answer
 *   retained and validated, a replay that invokes nothing, and a changed
 *   request that refuses rather than consuming the result retained for a
 *   different question.
 * - **E7, compatibility.** A workflow run's record is byte-for-byte the one it
 *   has always written, an inherited prefix replays under the identity it was
 *   created with, and a request named by inherited history that reaches live
 *   execution still refuses.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { resource, scoped } from "effection";
import type { Operation } from "effection";
import { writeTextFile } from "@effectionx/fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { ensure, until } from "effection";
import { rm } from "@effectionx/fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { collect, content, registerComponents } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { retainedWorkflowInstallation } from "@executablemd/workflow";
import { WORKFLOW_RUN } from "../../workflow/src/journal.ts";
import type { WorkflowRun } from "@executablemd/workflow";
import { ISSUE_EFFECT } from "../src/issue/effect-type.ts";
import { IssueApi } from "../src/issue/api.ts";
import type {
  IssueDetails,
  IssueInput,
  IssueReadOptions,
  IssueReference,
  IssueUpsertOptions,
} from "../src/issue/api.ts";
import { readOwnedIssue, upsertOwnedIssue } from "../src/issue/owned.ts";
import { useRetainedIssueOperations } from "../src/issue/effect.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { issueIdentityAdmission } from "../src/identities.ts";

const ORIGIN = "@executablemd/git/tests/issue-owned";

/** The issue every row reads, and the tracker every row files in. */
const ISSUE_URL = "https://github.com/octo/project/issues/7";
const TRACKER = "https://github.com/octo/project";

/** What a read's live callback answers with, unless a row says otherwise. */
const DETAILS: IssueDetails = Object.freeze({
  url: ISSUE_URL,
  title: "A read issue",
  description: "what the tracker holds",
  tags: Object.freeze(["one", "two"]),
  assignee: null,
});

/** What one execution of a row observed, from inside the components. */
interface Observed {
  /** Each live callback invocation, in order, by operation. */
  readonly live: string[];
  /** Each `IssueApi` call, in order. */
  readonly transport: string[];
  /** What each worker handed back, in order. */
  readonly answers: Json[];
  /** The idempotency key each upsert presented to the transport, in order. */
  readonly keys: string[];
}

function observed(): Observed {
  return { live: [], transport: [], answers: [], keys: [] };
}

/** What a row's live callbacks do, which is the whole point of the seam. */
interface Live {
  /** Answer a read without any transport at all. */
  read?: () => Operation<unknown>;
  /** Answer an upsert without any transport at all. */
  upsert?: () => Operation<unknown>;
}

interface Fixture {
  readonly root: string;
}

function useFixture(): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "issue-owned-")))));
    yield* ensure(() => rm(root, { recursive: true }));
    yield* provide({ root });
  });
}

/**
 * The two components a row writes, which call the workers directly.
 *
 * Authored here rather than reached through `<Issue>` on purpose: what these
 * rows are about is the envelope, and the component above it is the subject of
 * the entry suite. A component is still needed, because a durable operation is
 * named after the expansion that asked for it and there is no expansion outside
 * an element.
 */
function useOwnedComponents(seen: Observed, live: Live): Operation<void> {
  return registerComponents([
    {
      name: "OwnedRead",
      origin: ORIGIN,
      props: {
        type: "object",
        properties: {
          url: { type: "string" },
          owner: { type: "string" },
          site: { type: "string" },
        },
        additionalProperties: false,
      },
      *fn(props: Record<string, Json>): Operation<Json> {
        const request = { url: String(props.url ?? ISSUE_URL), provider: undefined };
        const details = yield* readOwnedIssue(
          {
            owner: String(props.owner ?? "owner-1"),
            site: String(props.site ?? "site-1"),
            request,
          },
          function* (): Operation<unknown> {
            seen.live.push("read");
            if (live.read === undefined) {
              throw new Error("this row's read was not supposed to run live");
            }
            return yield* live.read();
          },
        );
        seen.answers.push({ ...details, tags: [...details.tags] });
        return null;
      },
    },
    {
      name: "OwnedUpsert",
      origin: ORIGIN,
      props: {
        type: "object",
        properties: {
          title: { type: "string" },
          owner: { type: "string" },
          site: { type: "string" },
          target: { type: "string" },
        },
        additionalProperties: false,
      },
      *fn(props: Record<string, Json>): Operation<Json> {
        const issue: IssueInput = Object.freeze({
          title: String(props.title ?? "Filed"),
          description: "what this entry asked for",
          tags: Object.freeze([]),
          assignee: null,
        });
        const reference = yield* upsertOwnedIssue(
          {
            owner: String(props.owner ?? "owner-1"),
            site: String(props.site ?? "site-1"),
            request: { target: String(props.target ?? TRACKER), provider: undefined, issue },
          },
          function* (): Operation<unknown> {
            seen.live.push("upsert");
            if (live.upsert === undefined) {
              throw new Error("this row's upsert was not supposed to run live");
            }
            return yield* live.upsert();
          },
        );
        seen.answers.push({ url: reference.url });
        return null;
      },
    },
    {
      // A paired component, so a row can put one worker call inside another's
      // content and see which record lands first.
      name: "OwnedParent",
      origin: ORIGIN,
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn(): Operation<Json> {
        // Projected, because content a component does not render is content
        // nothing reaches: the child worker call is the point of this one.
        yield* content();
        return null;
      },
    },
  ]);
}

/**
 * The transport, counted — and answering only where a row said it may.
 *
 * Every row counts it, because "no provider was reached" is most of what these
 * rows assert. A row that does not supply an answer gets a transport that
 * refuses, so reaching one is a failure rather than a silently served request.
 */
function useCountedTransport(seen: Observed, transport: Transport): Operation<void> {
  return IssueApi.around(
    {
      *read([url]: [string, IssueReadOptions]): Operation<IssueDetails> {
        seen.transport.push(`read ${url}`);
        if (transport.read === undefined) {
          throw new Error("this row was not supposed to reach a transport");
        }
        return yield* transport.read(url);
      },
      *upsert([issue, options]: [IssueInput, IssueUpsertOptions]): Operation<IssueReference> {
        seen.transport.push(`upsert ${options.url}`);
        seen.keys.push(options.idempotencyKey);
        if (transport.upsert === undefined) {
          throw new Error("this row was not supposed to reach a transport");
        }
        return yield* transport.upsert(issue, options);
      },
    },
    { at: "min" },
  );
}

/** What a row's transport answers, where a row lets one be reached. */
interface Transport {
  read?: (url: string) => Operation<IssueDetails>;
  upsert?: (issue: IssueInput, options: IssueUpsertOptions) => Operation<IssueReference>;
}

interface Ran {
  readonly seen: Observed;
  readonly events: readonly DurableEvent[];
  readonly refusal: string | undefined;
}

/** One document, over one journal, with the live callbacks this row supplies. */
function run(
  fixture: Fixture,
  source: string,
  stream: DurableStream,
  live: Live,
  options: {
    readonly transport?: Transport;
    readonly installations?: readonly ExecutionInstallation[];
    /** Install the workflow run's own Issue lifecycle, as a workflow host does. */
    readonly retained?: boolean;
  } = {},
): Operation<Ran> {
  return scoped(function* (): Operation<Ran> {
    const path = join(fixture.root, `entry-${crypto.randomUUID()}.md`);
    yield* writeTextFile(path, source);
    const seen = observed();
    yield* useCompositionComponents();
    yield* useOwnedComponents(seen, live);
    yield* useCountedTransport(seen, options.transport ?? {});
    if (options.retained === true) {
      yield* useRetainedIssueOperations();
    }
    let refusal: string | undefined;
    try {
      yield* collect(yield* executeInstalled({ path, stream }, [...(options.installations ?? [])]));
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    return { seen, events: yield* stream.readAll(), refusal };
  });
}

/** Every Issue effect this journal holds, in order. */
function issueRecords(events: readonly DurableEvent[]): readonly DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === ISSUE_EFFECT,
  );
}

/** The request one record was named after, as the journal holds it. */
function requestOf(event: DurableEvent | undefined): unknown {
  return event?.type === "yield" ? event.description["request"] : undefined;
}

function valueOf(event: DurableEvent | undefined): unknown {
  return event?.type === "yield" && event.result.status === "ok" ? event.result.value : undefined;
}

function nameOf(event: DurableEvent | undefined): string | undefined {
  return event?.type === "yield" ? event.description.name : undefined;
}

/**
 * The digest a record's name is, computed by this suite rather than by the
 * code under test.
 *
 * Written out here because that is what makes it evidence: a row comparing the
 * production fingerprint with itself would pass however the encoding moved.
 */
function* digestOf(value: unknown): Operation<string> {
  const text = JSON.stringify(sorted(value));
  const encoded = new TextEncoder().encode(text === undefined ? "null" : text);
  const digest = yield* until(crypto.subtle.digest("SHA-256", encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The same canonical ordering the record encoding uses: keys, sorted. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sorted);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => [key, sorted(Reflect.get(value, key))] as const);
  return Object.fromEntries(entries);
}

/**
 * The same history, inherited by another run.
 *
 * A fork writes its own run record and inherits the effects beneath it, so a
 * row that only changed the installed run would be refused by the run record
 * itself before any Issue question arose. Rewriting it here is what makes the
 * inherited *Issue* prefix the subject.
 */
function forked(events: readonly DurableEvent[], runId: string): DurableEvent[] {
  return events
    .filter((event) => event.type !== "close")
    .map((event) =>
      event.type === "yield" && event.description.type === WORKFLOW_RUN
        ? {
            ...event,
            result: { status: "ok" as const, value: { runId, bundleHash: RUN.bundleHash } },
          }
        : event,
    );
}

/** Everything before the root Close, which is what a continuation reopens. */
function unfinished(events: readonly DurableEvent[]): InMemoryStream {
  return new InMemoryStream(events.filter((event) => event.type !== "close"));
}

/** The document the workflow rows run, which is the ordinary public one. */
const WORKFLOW_ENTRY = `<IssueTracker url="${TRACKER}"><Issue title="Filed" as="filed">a described issue</Issue></IssueTracker>`;

const RUN: WorkflowRun = Object.freeze({
  runId: "run-owned-issue",
  bundleHash: "a".repeat(64),
});

/** The run that inherits the first one's history. */
const FORK = "run-owned-issue-fork";

/** What a workflow run installs for these rows: the run, and its identity table. */
function workflowProfile(runId: string): readonly ExecutionInstallation[] {
  return [
    retainedWorkflowInstallation({ ...RUN, runId }),
    // The Git Plugin's own contribution, which is what publishes the identity
    // every retained Issue record in this history was written under.
    { admissions: [issueIdentityAdmission()] },
  ];
}

describe("the durable envelope an owned Issue operation runs inside", () => {
  it("E1: retains the answer one live read composed, and names it after the request", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const stream = new InMemoryStream();
    const ran = yield* run(
      fixture,
      '<OwnedRead url="https://github.com/octo/project/issues/7" />',
      stream,
      {
        read: function* (): Operation<unknown> {
          // A valid normalized result, answered without any transport: this is
          // what a live middleware answer is, and the envelope records it.
          return { ...DETAILS, tags: [...DETAILS.tags] };
        },
      },
    );

    expect(ran.refusal).toBe(undefined);
    expect(ran.seen.live).toEqual(["read"]);
    expect(ran.seen.transport).toEqual([]);
    expect(ran.seen.answers).toEqual([{ ...DETAILS, tags: [...DETAILS.tags] }]);

    const records = issueRecords(ran.events);
    expect(records.length).toBe(1);
    expect(requestOf(records[0])).toEqual({
      operation: "read",
      identity: { runId: "owner-1", expansionId: "site-1" },
      url: ISSUE_URL,
      provider: null,
    });
    expect(valueOf(records[0])).toEqual({ ...DETAILS, tags: [...DETAILS.tags] });
    expect(nameOf(records[0])).toBe(yield* digestOf(requestOf(records[0])));
  });

  it("E1: replays a completed read without invoking the live operation at all", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const source = '<OwnedRead url="https://github.com/octo/project/issues/7" />';
    const first = yield* run(fixture, source, new InMemoryStream(), {
      read: function* (): Operation<unknown> {
        return { ...DETAILS, tags: [...DETAILS.tags] };
      },
    });
    expect(first.refusal).toBe(undefined);

    // Both chains set to fail if invoked: the live callback is absent, which is
    // what the component refuses on, and the transport counts and throws.
    const again = yield* run(fixture, source, unfinished(first.events), {});

    expect(again.refusal).toBe(undefined);
    expect(again.seen.live).toEqual([]);
    expect(again.seen.transport).toEqual([]);
    // The exact saved result, not a fresh observation of a live object.
    expect(again.seen.answers).toEqual([{ ...DETAILS, tags: [...DETAILS.tags] }]);
    expect(issueRecords(again.events).length).toBe(1);
  });

  it("E1: refuses a request the retained record does not answer, and takes nothing from it", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const source = '<OwnedRead url="https://github.com/octo/project/issues/7" />';
    const first = yield* run(fixture, source, new InMemoryStream(), {
      read: function* (): Operation<unknown> {
        return { ...DETAILS, tags: [...DETAILS.tags] };
      },
    });
    expect(first.refusal).toBe(undefined);

    // A record for a different question, correctly named for *that* question,
    // at the position this document reaches. The source cannot be edited to
    // produce this: a continuation executes the root it retained rather than
    // whatever the file now says, so a changed request is a history holding an
    // answer to something else.
    const asked = {
      operation: "read",
      identity: { runId: "owner-1", expansionId: "site-1" },
      url: "https://github.com/octo/project/issues/8",
      provider: null,
    };
    const held = { ...DETAILS, url: "https://github.com/octo/project/issues/8", tags: ["other"] };
    const name = yield* digestOf(asked);
    const substituted = new InMemoryStream(
      first.events
        .filter((event) => event.type !== "close")
        .map((event) =>
          event.type === "yield" && event.description.type === ISSUE_EFFECT
            ? {
                ...event,
                description: { type: ISSUE_EFFECT, name, request: asked },
                result: { status: "ok" as const, value: held },
              }
            : event,
        ),
    );

    const changed = yield* run(fixture, source, substituted, {});

    // Whatever this execution does about the mismatch, what it must not do is
    // answer this question with the result retained for the other one.
    expect(changed.seen.answers).toEqual([]);
    expect(changed.refusal).not.toBe(undefined);
  });

  it("E1: retains an upsert's URL alone, and replays it without a live attempt", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const source = '<OwnedUpsert title="Filed" />';
    const filed = yield* run(fixture, source, new InMemoryStream(), {
      upsert: function* (): Operation<unknown> {
        // A provider answers with a URL and nothing else, however much it
        // knows: everything else is what this boundary keeps on its own side.
        return { url: `${TRACKER}/issues/11` };
      },
    });

    expect(filed.refusal).toBe(undefined);
    expect(filed.seen.live).toEqual(["upsert"]);
    expect(valueOf(issueRecords(filed.events)[0])).toEqual({ url: `${TRACKER}/issues/11` });

    const again = yield* run(fixture, source, unfinished(filed.events), {});
    expect(again.refusal).toBe(undefined);
    expect(again.seen.live).toEqual([]);
    expect(again.seen.answers).toEqual([{ url: `${TRACKER}/issues/11` }]);
    expect(issueRecords(again.events).length).toBe(1);
  });

  it("E1: a child's record lands before its parent's, and each call retains one", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const ran = yield* run(
      fixture,
      [
        "<OwnedParent>",
        '<OwnedRead url="https://github.com/octo/project/issues/7" site="child" />',
        "</OwnedParent>",
        '<OwnedUpsert title="Filed" site="parent" />',
      ].join("\n"),
      new InMemoryStream(),
      {
        read: function* (): Operation<unknown> {
          return { ...DETAILS, tags: [...DETAILS.tags] };
        },
        upsert: function* (): Operation<unknown> {
          return { url: `${TRACKER}/issues/12` };
        },
      },
    );

    expect(ran.refusal).toBe(undefined);
    const records = issueRecords(ran.events);
    // One envelope per Issue operation, in the order the document reached them:
    // the content's read finished at its own position before the upsert that
    // follows it was offered.
    expect(records.length).toBe(2);
    expect(requestOf(records[0])).toMatchObject({ operation: "read" });
    expect(requestOf(records[1])).toMatchObject({ operation: "upsert" });
  });

  it("E7: writes a workflow run's record exactly as it has always written it", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const stream = new InMemoryStream();
    const ran = yield* run(
      fixture,
      WORKFLOW_ENTRY,
      stream,
      {},
      {
        retained: true,
        installations: workflowProfile(RUN.runId),
        transport: {
          // deno-lint-ignore require-yield
          *upsert(): Operation<IssueReference> {
            return { url: `${TRACKER}/issues/21` };
          },
        },
      },
    );

    expect(ran.refusal).toBe(undefined);
    expect(ran.seen.transport).toEqual([`upsert ${TRACKER}`]);

    const record = issueRecords(ran.events)[0];
    const asked = requestOf(record);
    // The expansion id is the engine's, so it is read back rather than
    // predicted. Everything around it is the encoding this row is about.
    const site = String(Reflect.get(Object(Reflect.get(Object(asked), "identity")), "expansionId"));
    expect(asked).toEqual({
      operation: "upsert",
      identity: { runId: RUN.runId, expansionId: site },
      target: TRACKER,
      provider: null,
      issue: {
        title: "Filed",
        description: "a described issue",
        tags: [],
        assignee: null,
      },
    });
    expect(valueOf(record)).toEqual({ url: `${TRACKER}/issues/21` });
    expect(nameOf(record)).toBe(yield* digestOf(asked));
    // And the key the provider was handed is the canonical encoding of this
    // run's own identity and target, computed here rather than by the code
    // that produced it.
    expect(ran.seen.keys).toEqual([
      JSON.stringify(
        sorted({
          operation: "upsert",
          canonicalTargetUrl: TRACKER,
          runId: RUN.runId,
          expansionId: site,
        }),
      ),
    ]);
  });

  it("E7: replays the run's own record without reaching a provider", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const filed = yield* run(
      fixture,
      WORKFLOW_ENTRY,
      new InMemoryStream(),
      {},
      {
        retained: true,
        installations: workflowProfile(RUN.runId),
        transport: {
          // deno-lint-ignore require-yield
          *upsert(): Operation<IssueReference> {
            return { url: `${TRACKER}/issues/21` };
          },
        },
      },
    );
    expect(filed.refusal).toBe(undefined);

    const again = yield* run(
      fixture,
      WORKFLOW_ENTRY,
      unfinished(filed.events),
      {},
      {
        retained: true,
        installations: workflowProfile(RUN.runId),
      },
    );

    expect(again.refusal).toBe(undefined);
    expect(again.seen.transport).toEqual([]);
    expect(issueRecords(again.events).length).toBe(1);
  });

  it("E7: a fork replays the inherited prefix under the identity it was created with", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const filed = yield* run(
      fixture,
      WORKFLOW_ENTRY,
      new InMemoryStream(),
      {},
      {
        retained: true,
        installations: workflowProfile(RUN.runId),
        transport: {
          // deno-lint-ignore require-yield
          *upsert(): Operation<IssueReference> {
            return { url: `${TRACKER}/issues/21` };
          },
        },
      },
    );
    expect(filed.refusal).toBe(undefined);

    // Another run, over the first one's history. The record was named by a run
    // this execution is not, so without borrowing its name would not be the
    // name this request produces and the inherited issue would be filed twice.
    const inherited = yield* run(
      fixture,
      WORKFLOW_ENTRY,
      new InMemoryStream(forked(filed.events, FORK)),
      {},
      { retained: true, installations: workflowProfile(FORK) },
    );

    expect(inherited.refusal).toBe(undefined);
    expect(inherited.seen.transport).toEqual([]);
    const records = issueRecords(inherited.events);
    expect(records.length).toBe(1);
    expect(requestOf(records[0])).toMatchObject({ identity: { runId: RUN.runId } });
  });

  it("E7: refuses live work under a borrowed identity, and reaches no provider", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const filed = yield* run(
      fixture,
      WORKFLOW_ENTRY,
      new InMemoryStream(),
      {},
      {
        retained: true,
        installations: workflowProfile(RUN.runId),
        transport: {
          // deno-lint-ignore require-yield
          *upsert(): Operation<IssueReference> {
            return { url: `${TRACKER}/issues/21` };
          },
        },
      },
    );
    expect(filed.refusal).toBe(undefined);

    // The record is in the history the identity table is built from, and it is
    // not where positional replay will look for it: a prefix a fork inherited
    // whose coroutine this execution does not reach. So the request is named by
    // retained history and still arrives live, which is the one case that must
    // perform nothing at all.
    const moved = new InMemoryStream(
      forked(filed.events, FORK).map((event) =>
        event.type === "yield" && event.description.type === ISSUE_EFFECT
          ? { ...event, coroutineId: `${event.coroutineId}-elsewhere` }
          : event,
      ),
    );
    const live = yield* run(
      fixture,
      WORKFLOW_ENTRY,
      moved,
      {},
      {
        retained: true,
        installations: workflowProfile(FORK),
      },
    );

    expect(live.seen.transport).toEqual([]);
    expect(live.refusal ?? "").toContain("repeat work that already happened outside this journal");
  });
});
