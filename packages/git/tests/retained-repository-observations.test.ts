/**
 * Tier ROB — what one REPL entry's local Git reads retain, replay and refuse
 * to guess.
 *
 * Everything here runs a document through canonical execution with the
 * production entry host installed, so what is proven is the whole path: the
 * authored component asks the contextual Api, the contained performer runs real
 * `git` against a real checkout, and the page is recorded once. A fixture that
 * asserted on the record without the performer would prove the bookkeeping and
 * nothing about the answer.
 *
 * The contract these rows hold the host to is the REPL's execution model.
 * Replay restores recorded pages; it does not restore the checkout or require
 * it to match. So the rows that matter most are the ones where the two
 * disagree: a checkout whose files have all changed behind a completed listing,
 * a selected checkout deleted outright, and a read that physically happened and
 * was never acknowledged.
 *
 * ## How "nothing was resolved" is proven
 *
 * Counting `git` is not enough: routing a live read canonicalizes its working
 * directory and chooses among this entry's registered checkouts, and neither
 * touches `git`. So the directory an entry is opened in is a symbolic link, and
 * a continuation runs with that link pointing somewhere else entirely. Live
 * routing would resolve it, find it inside none of the checkouts this entry
 * registered, and fail admission. A continuation that answers normally has
 * therefore resolved nothing and selected nothing.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Err, Ok, race, scoped, sleep, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { exists, rm, writeTextFile } from "@effectionx/fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { GitQuery } from "@executablemd/git/api";
import type {
  GitDiffInvocation,
  GitDiffResult,
  GitObservationValue,
} from "@executablemd/git/api";
import { parseGitObservationValue } from "../src/composition/observation-records.ts";
import { GitObservationError } from "../src/composition/errors.ts";
import {
  elementOf,
  parseReplObservationRecord,
  replObservationFingerprint,
  replObservationRecordJson,
  replObservationRecordName,
  REPL_REPOSITORY_OBSERVATION,
} from "../src/retained-repository/observation-records.ts";
import type {
  ReplObservationCheckout,
  ReplObservationRequest,
} from "../src/retained-repository/observation-records.ts";
import { admitReplRepositoryHistory } from "../src/retained-repository/admission.ts";
import { Elicitation, registerComponents } from "@executablemd/core";
import { useObservationFixture, writeFixtureFile } from "./support/observations.ts";
import type { EntryCounters } from "./support/repl-observations.ts";
import {
  appears,
  entryCounters,
  entrySubcommands,
  leftEntry,
  repoint,
  running,
  runEntry,
  useEntryPlace,
} from "./support/repl-observations.ts";
import type { GitInvocation } from "../src/deno/composition/host.ts";
import { useCommonDirectoryLease } from "../src/deno/retained-repository/leases.ts";
import { commonDirectoryOf } from "./support/run-composition.ts";

/** One journal event standing for a saved observation record. */
function recordEvent(name: string, payload: Json): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type: REPL_REPOSITORY_OBSERVATION, name },
    result: { status: "ok", value: payload },
  };
}

/** This payload as an object a case can change one member of. */
function objectOf(payload: Json): Record<string, Json> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("expected a record payload");
  }
  return payload;
}

/** One page, as the writer needs it typed. */
function pageOf(page: Json | undefined): GitObservationValue {
  const parsed = page === undefined ? undefined : parseGitObservationValue(page, FILES_QUERY);
  if (parsed !== undefined) {
    return parsed;
  }
  if (typeof page !== "object" || page === null || Array.isArray(page)) {
    throw new Error("expected a page object");
  }
  // Every page in this case is already the shape its own writer accepts; the
  // files parser above is only the cheapest way to narrow the common one.
  return unchecked(page);
}

const FILES_QUERY = Object.freeze({
  kind: "files" as const,
  prefix: null,
  limit: 100,
  cursor: null,
});

/** The record's own writers refuse a value of the wrong shape, so this narrows. */
function unchecked(page: Record<string, Json>): GitObservationValue {
  const changes = parseGitObservationValue(page, {
    kind: "changes",
    comparison: { compare: "unstaged" },
    paths: null,
    limit: 100,
    cursor: null,
  });
  if (changes !== undefined) {
    return changes;
  }
  const diff = parseGitObservationValue(page, {
    kind: "diff",
    comparison: { compare: "unstaged" },
    paths: null,
    offset: 0,
    limit: 4096,
    cursor: null,
  });
  if (diff !== undefined) {
    return diff;
  }
  const file = parseGitObservationValue(page, {
    kind: "file",
    commit: String(page.commit ?? ""),
    path: String(page.path ?? ""),
    offset: 0,
    limit: 4096,
  });
  if (file === undefined) {
    throw new Error("expected a page of one of the four shapes");
  }
  return file;
}

/**
 * A journal that collects what it is given, with one hook before each append.
 *
 * The hook is where a row cuts or refuses: holding it keeps the native work
 * done and the acknowledgement undone, and throwing from it is the engine's own
 * persistence failure.
 */
function collecting(
  events: DurableEvent[],
  before?: (event: DurableEvent) => Operation<void>,
): DurableStream {
  return {
    *readAll(): Operation<DurableEvent[]> {
      return [...events];
    },
    *append(event: DurableEvent): Operation<void> {
      if (before !== undefined) {
        yield* before(event);
      }
      events.push(event);
    },
  };
}

/** What a watched `git` child reported about its own lifetime. */
interface WatchedChildren {
  readonly spawned: Operation<void>;
  readonly observe: NonNullable<GitInvocation["observe"]>;
  observed(): number;
  closed(): boolean;
  alive(): boolean;
}

/**
 * Watch the real children one invocation spawns.
 *
 * The production host forwards this to the one place a child exists, which is
 * the only point at which a row can see the process a command really started.
 * A wrapper around the host sees the call and its answer and never the child
 * between them, so observing residue afterwards cannot tell an interrupted
 * command from one that never began.
 */
function watchChildren(): WatchedChildren {
  const pids: number[] = [];
  let count = 0;
  let closes = 0;
  const first = withResolvers<void>();
  return {
    spawned: first.operation,
    observe(child): void {
      count += 1;
      if (child.pid !== undefined) {
        pids.push(child.pid);
      }
      child.on("close", () => {
        closes += 1;
      });
      first.resolve();
    },
    observed: () => count,
    closed: () => count > 0 && closes === count,
    alive: () => pids.some((pid) => running(pid)),
  };
}

/**
 * A script that reports it ran and then waits.
 *
 * What makes a child cut deterministic: the marker says the command really
 * reached this point, and the wait keeps it there until the halt arrives. The
 * process group teardown is what ends it.
 */
function* waitingScript(path: string, marker: string): Operation<void> {
  yield* writeTextFile(path, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nsleep 120\n`);
  yield* until(chmod(path, 0o755));
}

/** The one observation payload this history holds, as an object. */
function soundPayload(events: readonly DurableEvent[]): Json {
  for (const event of events) {
    if (
      event.type === "yield" &&
      event.description.type === REPL_REPOSITORY_OBSERVATION &&
      event.result.status === "ok"
    ) {
      return event.result.value ?? null;
    }
  }
  throw new Error("this history holds no observation record");
}

/** The route member of one observation payload. */
function soundCheckout(payload: Json): Json {
  const checkout = objectOf(payload).checkout;
  if (checkout === undefined) {
    throw new Error("this observation payload holds no checkout");
  }
  return checkout;
}

/**
 * This history with its one observation replaced, and everything else intact.
 *
 * The placements, the ambient routing and the terminal stay exactly as the
 * entry wrote them, which is what makes a refusal below about the record that
 * changed rather than about a history missing its context.
 */
function replacingObservation(
  events: readonly DurableEvent[],
  name: string,
  payload: Json,
): readonly DurableEvent[] {
  return events.map((event) => {
    if (event.type !== "yield" || event.description.type !== REPL_REPOSITORY_OBSERVATION) {
      return event;
    }
    return {
      ...event,
      description: { ...event.description, name },
      result: { status: "ok" as const, value: payload },
    };
  });
}

/** The native reads one entry performed, which is what a read's `git` is. *//** The native reads one entry performed, which is what a read's `git` is. */
const READ_SUBCOMMANDS: readonly string[] = ["ls-files", "diff", "cat-file", "ls-tree"];

function reads(counted: EntryCounters): string[] {
  // By exact argument rather than by "the first word that is not an option":
  // every read states `-c <setting>` pre-command options, and a setting's value
  // is not an option either.
  return counted.commands
    .map((args) => args.find((arg) => READ_SUBCOMMANDS.includes(arg)))
    .filter((name): name is string => name !== undefined);
}

/** The records of this feature's own observation type, parsed. */
function observations(events: readonly DurableEvent[]) {
  return events
    .filter(
      (event) =>
        event.type === "yield" && event.description.type === REPL_REPOSITORY_OBSERVATION,
    )
    .map((event) => {
      if (event.type !== "yield" || event.result.status !== "ok") {
        throw new Error("an observation record is not a successful envelope");
      }
      const parsed = parseReplObservationRecord(event.result.value);
      if (parsed === undefined) {
        throw new Error("an observation record did not parse");
      }
      return { name: event.description.name, record: parsed };
    });
}

/** The place and request a hand-built record is named by. */
function requestOf(fixture: { root: string; c1: string }, common: string): ReplObservationRequest {
  return Object.freeze({
    repository: Object.freeze({
      name: "checkout",
      locatorFingerprint: "a".repeat(64),
      requestedBase: null,
      creationCommit: fixture.c1,
      primaryBranch: "main",
      objectFormat: "sha1" as const,
    }),
    selectionCheckout: fixture.root,
    commonDirectory: common,
    workingDirectory: fixture.root,
    query: Object.freeze({
      kind: "files" as const,
      prefix: null,
      limit: 100,
      cursor: null,
    }),
  });
}

function checkoutOf(fixture: { root: string }, common: string): ReplObservationCheckout {
  return Object.freeze({
    root: fixture.root,
    commonDirectory: common,
    repositoryName: "checkout",
    worktreeName: null,
  });
}

describe("ROB1 — a completed read answers from its record", () => {
  it("restores all four pages with no git, through a link pointing elsewhere", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const first = entryCounters();
    const source = [
      '<Git.Files limit={1000} as="files" />',
      "",
      '<Git.Changes compare="unstaged" as="changes" />',
      "",
      '<Git.Diff compare="unstaged" limit={100000} as="diff" />',
      "",
      `<Git.File commit="${fixture.c1}" path="src/a.ts" as="source" />`,
      "",
      "<Json value={files} />",
      "",
      "<Json value={changes} />",
      "",
      "<Json value={diff} />",
      "",
      "<Json value={source} />",
      "",
    ].join("\n");
    const stream = new InMemoryStream();
    yield* writeFixtureFile(fixture.root, "src/a.ts", "export const a = 5;\n");
    const live = yield* runEntry(place, source, stream, first);
    expect(live.refusal).toBe(undefined);
    const recorded = observations(live.events);
    expect(recorded.map((entry) => entry.record.operation)).toEqual([
      "files",
      "changes",
      "diff",
      "file",
    ]);

    // Everything the first entry read is now wrong: the files are gone, the
    // checkout is gone, and the directory the entry was opened through points
    // somewhere else.
    yield* rm(fixture.root, { recursive: true, force: true });
    yield* repoint(place, place.root);

    const second = entryCounters();
    const again = yield* runEntry(
      place,
      source,
      new InMemoryStream([...live.events]),
      second,
    );
    expect(again.refusal).toBe(undefined);
    expect(again.output).toBe(live.output);
    // Not one `git`, no scratch directory, and no session.
    expect(entrySubcommands(second)).toEqual([]);
    expect(second.directories).toBe(0);
    expect(second.sessions).toEqual([]);
  });
});

describe("ROB2 — the record is closed, and named by the request it carries", () => {
  it("round-trips all four pages and one refusal", function* () {
    const fixture = yield* useObservationFixture();
    const common = commonDirectoryOf({ root: fixture.root, home: fixture.home, run: fixture.run });
    const request = requestOf(fixture, common);
    const checkout = checkoutOf(fixture, common);
    const fingerprint = yield* replObservationFingerprint(request);

    const pages: Json[] = [
      { paths: ["a.ts"], next: null },
      { comparison: { compare: "unstaged" }, changes: [], next: null },
      { comparison: { compare: "unstaged" }, text: "patch", offset: 0, length: 5, next: null },
      {
        commit: fixture.c1,
        path: "src/a.ts",
        text: "text",
        offset: 0,
        length: 4,
        next: null,
      },
    ];
    const queries: ReplObservationRequest["query"][] = [
      { kind: "files", prefix: null, limit: 100, cursor: null },
      { kind: "changes", comparison: { compare: "unstaged" }, paths: null, limit: 100, cursor: null },
      {
        kind: "diff",
        comparison: { compare: "unstaged" },
        paths: null,
        offset: 0,
        limit: 4096,
        cursor: null,
      },
      { kind: "file", commit: fixture.c1, path: "src/a.ts", offset: 0, limit: 4096 },
    ];

    for (const [index, query] of queries.entries()) {
      const own: ReplObservationRequest = { ...request, query };
      const digest = yield* replObservationFingerprint(own);
      const payload = replObservationRecordJson({
        fingerprint: digest,
        request: own,
        checkout,
        outcome: Ok(pageOf(pages[index])),
      });
      const parsed = parseReplObservationRecord(payload);
      expect(`${query.kind}: ${parsed === undefined ? "unreadable" : "read"}`).toBe(
        `${query.kind}: read`,
      );
      expect(parsed?.request.query).toEqual(query);
      expect(parsed?.outcome.ok).toBe(true);
      // And the name is the digest of the request, so the record and the
      // question it answers cannot be separated.
      expect(replObservationRecordName({ operation: query.kind, fingerprint: digest })).toBe(
        replObservationRecordName({
          operation: query.kind,
          fingerprint: yield* replObservationFingerprint(own),
        }),
      );
    }

    const refused = replObservationRecordJson({
      fingerprint,
      request,
      checkout,
      outcome: Err(
        new GitObservationError(
          elementOf("files"),
          "unusable-repository",
          "<Git.Files> could not read its tracked files.",
        ),
      ),
    });
    const parsedRefusal = parseReplObservationRecord(refused);
    expect(parsedRefusal?.outcome.ok).toBe(false);
    expect(
      parsedRefusal?.outcome.ok === false ? parsedRefusal.outcome.error.message : "",
    ).toBe("<Git.Files> could not read its tracked files.");
  });

  // Over a real production history rather than a hand-built record, because the
  // route check below is a relationship *between* records: an observation names
  // the checkout it read, and what authorizes that is a placement the same
  // history made. A lone observation has no history to be routed by.
  it("refuses a version, a fingerprint, a name, a page and a route it cannot read", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const live = yield* runEntry(
      place,
      '<Git.Files as="files" />\n',
      new InMemoryStream(),
      entryCounters(),
    );
    expect(live.refusal).toBe(undefined);
    const recorded = observations(live.events);
    expect(recorded).toHaveLength(1);
    const name = recorded[0]?.name ?? "";
    const sound = soundPayload(live.events);

    // The control: this history is admitted as it stands, so every refusal
    // below is about the one thing it changed.
    yield* admitReplRepositoryHistory(live.events);

    const broken: [string, string, Json][] = [
      ["a stated version this host does not implement", name, { ...objectOf(sound), version: 2 }],
      [
        "a fingerprint that is not the request's digest",
        name,
        { ...objectOf(sound), fingerprint: "0".repeat(64) },
      ],
      ["a name its own request does not produce", `${name} `, sound],
      [
        "a page holding more records than the limit asked for",
        name,
        {
          ...objectOf(sound),
          outcome: {
            ok: true,
            value: { paths: Array.from({ length: 101 }, (_, i) => `p${i}`), next: null },
          },
        },
      ],
      [
        "an operation the request's query is not",
        name,
        { ...objectOf(sound), operation: "diff" },
      ],
      [
        "a checkout route this version did not write",
        name,
        { ...objectOf(sound), checkout: { root: fixture.root } },
      ],
      // Fully shaped, and wrong. Every required member is present, the request,
      // the fingerprint and the journaled name are untouched, and only the root
      // names a checkout no placement in this history selected.
      [
        "a complete checkout no placement in this history selected",
        name,
        {
          ...objectOf(sound),
          checkout: { ...objectOf(soundCheckout(sound)), root: "/unregistered/other-checkout" },
        },
      ],
      [
        "a complete checkout under another repository's name",
        name,
        {
          ...objectOf(sound),
          checkout: { ...objectOf(soundCheckout(sound)), repositoryName: "elsewhere" },
        },
      ],
      [
        "a complete checkout claiming to be a worktree",
        name,
        {
          ...objectOf(sound),
          checkout: { ...objectOf(soundCheckout(sound)), worktreeName: "side" },
        },
      ],
      [
        "a complete checkout under another Git directory",
        name,
        {
          ...objectOf(sound),
          checkout: {
            ...objectOf(soundCheckout(sound)),
            commonDirectory: "/unregistered/other-checkout/.git",
          },
        },
      ],
    ];

    for (const [named, recordName, payload] of broken) {
      let refusal: unknown;
      try {
        yield* admitReplRepositoryHistory(replacingObservation(live.events, recordName, payload));
      } catch (error) {
        refusal = error;
      }
      expect(`${named}: ${refusal === undefined ? "admitted" : "refused"}`).toBe(
        `${named}: refused`,
      );
    }
  });

  it("refuses a well-shaped wrong route before reusing a completed or unfinished page", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const source = ['<Git.Files as="files" />', "", "<Json value={files} />", ""].join("\n");

    // A settled entry, and the same entry left at a question: the route has to
    // be refused before either is reused, and a completed terminal is reused
    // without the body that checks the live registry ever being entered.
    const settled = yield* runEntry(place, source, new InMemoryStream(), entryCounters());
    expect(settled.refusal).toBe(undefined);
    const unfinished = yield* leftEntry(
      place,
      [source, '<Elicit schema={{ type: "object" }} as="answer">Carry on?</Elicit>', ""].join("\n"),
      entryCounters(),
    );

    for (const [named, history] of [
      ["a completed history", settled.events],
      ["an unfinished history", unfinished],
    ] as const) {
      const elsewhere = replacingObservation(
        history,
        observations(history)[0]?.name ?? "",
        {
          ...objectOf(soundPayload(history)),
          checkout: {
            ...objectOf(soundCheckout(soundPayload(history))),
            root: "/unregistered/other-checkout",
          },
        },
      );
      const counted = entryCounters();
      const replayed = yield* runEntry(place, source, new InMemoryStream([...elsewhere]), counted);
      // Refused through the production trusted admission, so no page is bound
      // and the original output is not reproduced.
      expect(`${named}: ${replayed.refusal === undefined ? "reused" : "refused"}`).toBe(
        `${named}: refused`,
      );
      expect(`${named}: ${replayed.refusal ?? ""}`).toContain(
        "names a checkout no placement in this history selected",
      );
      expect(replayed.output).not.toContain("src/a.ts");
      // And decided from the history alone: nothing opened a checkout, resolved
      // a path or ran `git` to find out.
      expect(`${named}: ${entrySubcommands(counted).join(",")}`).toBe(`${named}: `);
      expect(counted.directories).toBe(0);
    }
  });

  it("admits a completed page whose checkout has been deleted since", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const source = ['<Git.Files as="files" />', "", "<Json value={files} />", ""].join("\n");
    const live = yield* runEntry(place, source, new InMemoryStream(), entryCounters());
    expect(live.refusal).toBe(undefined);

    // The control the route check must not break: a cold reuse whose checkout
    // is gone. The route is authorized by the history's own placement, and
    // nothing consults a filesystem to decide it.
    yield* rm(fixture.root, { recursive: true, force: true });
    yield* repoint(place, place.root);
    const counted = entryCounters();
    const again = yield* runEntry(
      place,
      source,
      new InMemoryStream([...live.events]),
      counted,
    );
    expect(again.refusal).toBe(undefined);
    expect(again.output).toBe(live.output);
    expect(entrySubcommands(counted)).toEqual([]);
  });

  it("refuses a failed envelope under this type, and leaves older histories alone", function* () {
    let refusal: unknown;
    try {
      yield* admitReplRepositoryHistory([
        {
          type: "yield",
          coroutineId: "root",
          description: { type: REPL_REPOSITORY_OBSERVATION, name: "x" },
          result: { status: "err", error: { message: "boom" } },
        },
      ]);
    } catch (error) {
      refusal = error;
    }
    expect(refusal === undefined ? "admitted" : "refused").toBe("refused");

    // A history with none of this type in it is unchanged by the new reader.
    yield* admitReplRepositoryHistory([
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "some_other_feature", name: "y" },
        result: { status: "ok", value: { anything: true } },
      },
    ]);
  });
});

describe("ROB3 — ordinary middleware keeps its ordinary meaning", () => {
  it("creates no record when a replacement answers above the provider", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const counted = entryCounters();
    const answered: string[] = [];

    const run = yield* runEntry(
      place,
      ['<Git.Diff compare="unstaged" as="diff" />', "", "<Json value={diff} />", ""].join("\n"),
      new InMemoryStream(),
      counted,
      {
        *between(): Operation<void> {
          yield* GitQuery.around({
            // deno-lint-ignore require-yield
            *diff([invocation]: [GitDiffInvocation]): Operation<GitDiffResult> {
              answered.push(invocation.request.kind);
              return {
                comparison: { compare: "unstaged" },
                text: "answered above",
                offset: 0,
                length: 14,
                next: null,
              };
            },
          });
        },
      },
    );

    expect(run.refusal).toBe(undefined);
    expect(answered).toEqual(["diff"]);
    expect(run.output).toContain("answered above");
    // Answered entirely above the provider, so no provider was reached: no
    // native read, no scratch directory and no observation record.
    expect(observations(run.events)).toEqual([]);
    // Ambient discovery still happened — the component asks which repository is
    // in scope before it asks anything of it — but not one native *read* ran.
    expect(reads(counted)).toEqual([]);
  });

  it("records the request a delegating replacement actually passed down", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const counted = entryCounters();

    const run = yield* runEntry(
      place,
      ['<Git.Diff compare="unstaged" as="diff" />', ""].join("\n"),
      new InMemoryStream(),
      counted,
      {
        *between(): Operation<void> {
          yield* GitQuery.around({
            diff: ([invocation]: [GitDiffInvocation], next): Operation<GitDiffResult> =>
              next({ ...invocation, request: { ...invocation.request, limit: 7 } }),
          });
        },
      },
    );

    expect(run.refusal).toBe(undefined);
    const recorded = observations(run.events);
    expect(recorded).toHaveLength(1);
    // The request the provider received, not the one the document wrote.
    expect(recorded[0]?.record.request.query).toEqual({
      kind: "diff",
      comparison: { compare: "unstaged" },
      paths: null,
      offset: 0,
      limit: 7,
      cursor: null,
    });
  });
});

describe("ROB4 — a saved refusal replays, and a new read sees today", () => {
  it("retains an ordinary bad-revision refusal and raises it again with no git", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const first = entryCounters();
    const source = [
      "<PrintErrors>",
      '<Git.File commit="no-such-revision" path="src/a.ts" as="source" />',
      "Source: {source}",
      "</PrintErrors>",
      "",
    ].join("\n");

    const live = yield* runEntry(place, source, new InMemoryStream(), first, {});
    expect(live.refusal).toBe(undefined);
    expect(live.output).toContain("names no commit in the selected repository");
    const recorded = observations(live.events);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.record.outcome.ok).toBe(false);

    const replayed = entryCounters();
    const again = yield* runEntry(
      place,
      source,
      new InMemoryStream([...live.events]),
      replayed,
    );
    expect(again.output).toBe(live.output);
    expect(entrySubcommands(replayed)).toEqual([]);
  });

  it("restores a prefix and performs the first unrecorded read against new data", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const first = entryCounters();
    const source = [
      '<Git.Files prefix="src/" as="before" />',
      "",
      "<Json value={before} />",
      "",
      '<Elicit schema={{ type: "object" }} as="answer">Carry on?</Elicit>',
      "",
      '<Git.Files prefix="src/" as="after" />',
      "",
      "<Json value={after} />",
      "",
    ].join("\n");

    const prefix = yield* leftEntry(place, source, first);
    expect(observations(prefix)).toHaveLength(1);

    // New data behind the question: a tracked path the saved page never held.
    yield* writeFixtureFile(fixture.root, "src/late.ts", "export const late = true;\n");
    fixture.run("add", "--", "src/late.ts");

    const resumed = entryCounters();
    const again = yield* runEntry(place, source, new InMemoryStream([...prefix]), resumed, {
      *between(): Operation<void> {
        yield* Elicitation.around({
          // deno-lint-ignore require-yield
          *elicit(): Operation<unknown> {
            return {};
          },
        });
      },
    });

    expect(again.refusal).toBe(undefined);
    const pages = observations(again.events);
    expect(pages).toHaveLength(2);
    // The prefix restored the page it saved, and the suffix read live.
    const before = pages[0]?.record.outcome;
    const after = pages[1]?.record.outcome;
    expect(before?.ok === true && "paths" in before.value ? [...before.value.paths] : []).not
      .toContain("src/late.ts");
    expect(after?.ok === true && "paths" in after.value ? [...after.value.paths] : []).toContain(
      "src/late.ts",
    );
  });
});

describe("ROB5 — cancellation, persistence and ownership", () => {
  it("joins an interrupted read's child and removes its scratch before settling", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const counted = entryCounters();
    yield* writeFixtureFile(fixture.root, "src/a.ts", "export const a = 11;\n");
    const watched = watchChildren();
    const marker = join(place.root, "read-ran");
    const script = join(place.root, "waiting-fsmonitor");
    yield* waitingScript(script, marker);

    // The comparison refreshes the index before it answers, and a file-system
    // monitor is consulted while it does. This one reports that it ran and then
    // waits, holding the pipes the parent inherited — which is what makes the
    // cut land on a real child rather than between commands.
    const intercept = (invocation: GitInvocation): Partial<GitInvocation> | undefined =>
      invocation.args.includes("diff")
        ? {
            args: ["-c", `core.fsmonitor=${script}`, ...invocation.args],
            observe: watched.observe,
          }
        : undefined;

    const events: DurableEvent[] = [];
    const journal = collecting(events);
    yield* scoped(function* () {
      const task = yield* spawn(() =>
        runEntry(
          place,
          [
            '<Git.Diff compare="unstaged" as="diff" />',
            '<File path="sentinel.md">sentinel</File>',
          ].join("\n"),
          journal,
          counted,
          { intercept },
        ),
      );
      // The marker says the descendant really ran and is holding the pipes.
      yield* appears(marker);
      yield* watched.spawned;
      yield* task.halt();
    });

    // The child is gone and both its pipes have ended; the scratch the read
    // owned is gone with it; and nothing after the read ran.
    expect(watched.observed() > 0).toBe(true);
    expect(watched.closed()).toBe(true);
    expect(watched.alive()).toBe(false);
    expect(counted.scratch.length > 0).toBe(true);
    for (const directory of counted.scratch) {
      expect(yield* exists(directory)).toBe(false);
    }
    expect(observations(events)).toEqual([]);
    expect(yield* exists(join(fixture.root, "sentinel.md"))).toBe(false);
  });

  it("leaves no completion when a finished read's append is cancelled", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const counted = entryCounters();
    yield* writeFixtureFile(fixture.root, "src/a.ts", "export const a = 13;\n");
    const events: DurableEvent[] = [];
    const reached = withResolvers<void>();
    const held = withResolvers<void>();

    // A barrier between the native work and its acknowledgement: the read has
    // happened, and the append has not.
    const barrier = collecting(events, function* (event) {
      if (event.type === "yield" && event.description.type === REPL_REPOSITORY_OBSERVATION) {
        reached.resolve();
        yield* held.operation;
      }
    });

    const source = [
      "<PrintErrors>",
      '<Git.Diff compare="unstaged" as="diff" />',
      "Diff: {diff.length}",
      "</PrintErrors>",
      '<File path="sentinel.md">sentinel</File>',
    ].join("\n");

    yield* scoped(function* () {
      const task = yield* spawn(() => runEntry(place, source, barrier, counted, {}));
      yield* reached.operation;
      yield* task.halt();
    });

    // The read ran, and nothing says it did.
    expect(reads(counted)).toContain("diff");
    expect(observations(events)).toEqual([]);
    expect(yield* exists(join(fixture.root, "sentinel.md"))).toBe(false);

    // So a continuation takes the live path, and gets today's answer.
    yield* writeFixtureFile(fixture.root, "src/a.ts", "export const a = 17;\n");
    const again = entryCounters();
    const continued = yield* runEntry(
      place,
      source,
      new InMemoryStream([...events]),
      again,
    );
    expect(continued.refusal).toBe(undefined);
    expect(reads(again)).toContain("diff");
    const recorded = observations(continued.events);
    expect(recorded).toHaveLength(1);
    const outcome = recorded[0]?.record.outcome;
    expect(
      outcome?.ok === true && "text" in outcome.value ? outcome.value.text : "",
    ).toContain("+export const a = 17;");
  });

  it("keeps a failed page append fatal, with no binding and nothing after", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const counted = entryCounters();
    yield* writeFixtureFile(fixture.root, "src/a.ts", "export const a = 19;\n");
    const events: DurableEvent[] = [];
    const rejecting = collecting(events, function* (event) {
      if (event.type === "yield" && event.description.type === REPL_REPOSITORY_OBSERVATION) {
        throw new Error("the journal refused this event");
      }
    });

    const performed = yield* runEntry(
      place,
      [
        "<PrintErrors>",
        '<Git.Diff compare="unstaged" as="diff" />',
        "Diff: {diff.length}",
        "</PrintErrors>",
        '<File path="sentinel.md">sentinel</File>',
      ].join("\n"),
      rejecting,
      counted,
    );

    // The read happened; the durability failure is fatal; no success binding
    // was offered; and nothing after it ran, printing region or not.
    expect(reads(counted)).toContain("diff");
    const reported = performed.refusal ?? performed.output;
    expect(reported).not.toContain("sentinel");
    expect(observations(events)).toEqual([]);
    expect(yield* exists(join(fixture.root, "sentinel.md"))).toBe(false);
  });

  // The two halves of the same ownership rule, in one entry and then across
  // two. Inside one entry a read owns the native turn and a mutation waits;
  // between entries a mutation lease is a different mechanism and a read does
  // not wait for it.
  it("keeps the same entry's mutation out of a held read, then lets it through", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const counted = entryCounters();
    yield* writeFixtureFile(fixture.root, "src/a.ts", "export const a = 123;\n");

    const readHeld = withResolvers<void>();
    const releaseRead = withResolvers<void>();
    const mutationEntered = withResolvers<void>();
    let holding = false;
    let enteredWhileHeld = false;

    const settled = yield* scoped(function* () {
      const task = yield* spawn(() =>
        runEntry(
          place,
          [
            "<All>",
            '<Spawn><Git.Diff compare="unstaged" as="patch" /></Spawn>',
            '<Spawn><WaitsForTheRead /><Git.Add paths="src/a.ts" /></Spawn>',
            "</All>",
            "",
          ].join("\n"),
          new InMemoryStream(),
          counted,
          {
            *between(): Operation<void> {
              // The second branch starts its mutation only once the read is
              // genuinely held, so the race the regression needs is arranged
              // rather than hoped for.
              yield* registerComponents([
                {
                  name: "WaitsForTheRead",
                  origin: "test://waits-for-the-read",
                  props: { type: "object", properties: {}, additionalProperties: false },
                  *fn(): Operation<string> {
                    yield* readHeld.operation;
                    return "";
                  },
                },
              ]);
            },
            *barrier(invocation): Operation<void> {
              if (invocation.args.includes("add")) {
                if (holding) {
                  enteredWhileHeld = true;
                }
                mutationEntered.resolve();
                return;
              }
              if (invocation.args.includes("diff") && !holding) {
                holding = true;
                readHeld.resolve();
                // Long enough that a mutation on a queue of its own would have
                // reached the host by now, and short enough to end the case.
                yield* race([
                  mutationEntered.operation,
                  (function* (): Operation<void> {
                    yield* sleep(2000);
                  })(),
                ]);
                holding = false;
                releaseRead.resolve();
              }
            },
          },
        ),
      );
      yield* releaseRead.operation;
      // The read has finished its own turn; the mutation may now proceed.
      yield* race([
        mutationEntered.operation,
        (function* (): Operation<void> {
          yield* sleep(30_000);
          throw new Error("the mutation never reached native Git");
        })(),
      ]);
      return yield* task;
    });

    // Nothing of this entry's own Git entered while its read held the turn,
    // and the mutation did run once the read released it.
    expect(enteredWhileHeld).toBe(false);
    expect(settled.refusal).toBe(undefined);
    expect(reads(counted)).toContain("diff");
    expect(entrySubcommands(counted)).toContain("add");
  });

  it("answers while another holder has the checkout's mutation lease", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const common = commonDirectoryOf({ root: fixture.root, home: fixture.home, run: fixture.run });
    const counted = entryCounters();
    yield* writeFixtureFile(fixture.root, "src/a.ts", "export const a = 23;\n");

    const source = [
      '<Git.Changes compare="unstaged" as="changes" />',
      "",
      "<Json value={changes} />",
      "",
    ].join("\n");

    // Held for the whole of both runs by somebody else. A read that took one
    // would be refused by the operating system on the second descriptor.
    const live = yield* scoped(function* () {
      yield* useCommonDirectoryLease(common);
      return yield* runEntry(place, source, new InMemoryStream(), counted);
    });
    expect(live.refusal).toBe(undefined);
    expect(reads(counted)).toContain("diff");

    // And a completed replay takes neither the lease nor anything else: it
    // answers with the lease still held and the checkout gone.
    const replayed = entryCounters();
    const again = yield* scoped(function* () {
      yield* useCommonDirectoryLease(common);
      yield* repoint(place, place.root);
      return yield* runEntry(place, source, new InMemoryStream([...live.events]), replayed);
    });
    expect(again.output).toBe(live.output);
    expect(entrySubcommands(replayed)).toEqual([]);
  });
});
