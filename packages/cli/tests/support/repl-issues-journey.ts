/**
 * The one real-terminal journey an entry's issues rest on.
 *
 * Shared by two rows that differ in exactly one thing: which `xmd` runs. The
 * Deno source row proves the entry host this repository builds; the compiled
 * row proves the binary carries it. Writing the journey twice would let the two
 * drift, and a compiled row asserting something slightly weaker than the source
 * row is how a packaging defect survives.
 *
 * Every other row of this feature's evidence installs its own host, which is
 * what makes those rows portable and deterministic. None of them can show the
 * thing a person actually does: type an entry that files an issue, read it
 * back, walk away at a question, and come back to the printed location. So this
 * launches the production entrypoint on a pty against a tracker listening on
 * loopback, and reads the answer off the screen and off the tracker.
 *
 * The credential and the endpoint arrive as the two environment variables an
 * operator would write. Nothing else is substituted: the adapter, the entry
 * host, the identity and the journal are the shipped ones.
 */

import { expect } from "@executablemd/test-support/expect";
import { cliRuntime, shellQuote } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { scoped, sleep, withResolvers } from "effection";
import { exists, readTextFile } from "@effectionx/fs";
import { join } from "node:path";
import type { Operation } from "effection";
import { useIssueTrackerServer } from "../../../git/tests/support/issue-tracker-server.ts";
import type { IssueTrackerServer } from "../../../git/tests/support/issue-tracker-server.ts";
import { credential } from "../../../git/tests/support/issue-tracker-server.ts";
import { allocate, showing } from "./pty.ts";
import type { Pty } from "./pty.ts";

/**
 * How long reaching the screen may take, and how long one interaction may take.
 *
 * Reaching the screen compiles or loads an entrypoint, which is slow and
 * uninteresting. Everything after that is the subject.
 */
const REACH_MS = 180_000;
const ACT_MS = 60_000;

/** How this row's `xmd` is invoked, as one shell command. */
export type ReplCommand = (args: readonly string[]) => string;

/** The tracker a document writes, which is a github.com name and not the socket. */
const TRACKER = "https://github.com/octo/project";

/**
 * The entry this journey types.
 *
 * One upsert, one read of what the upsert produced, the two facts a person came
 * for, a question nobody has answered yet, and a write after it. The read is
 * what makes the reopen observable: its binding is a record, and the tracker
 * is not asked again for it.
 */
const ENTRY = [
  `<IssueTracker url="${TRACKER}">`,
  '<Issue title="A journey issue" as="filed">what this journey asked for</Issue>',
  '<Issue url={filed.url} as="found" />',
  "</IssueTracker>",
  "filed at {found.url}",
  "titled {found.title}",
  '<Elicit schema={{ type: "object", properties: { decision: { type: "string", enum: ["continue"] } }, required: ["decision"], additionalProperties: false }} as="answer">Recorded issue: {found.url}. Continue?</Elicit>',
  '<File path="after.md">continued</File>',
].join("\n");

/** Wait until this file holds this exact text. */
function* holding(path: string, content: string): Operation<void> {
  const deadline = Date.now() + ACT_MS;
  while (true) {
    if ((yield* exists(path)) && (yield* readTextFile(path)) === content) {
      return;
    }
    if (Date.now() > deadline) {
      const found = (yield* exists(path)) ? yield* readTextFile(path) : "<absent>";
      throw new Error(
        `${path} never held ${JSON.stringify(content)}; it holds ${JSON.stringify(found)}`,
      );
    }
    yield* sleep(200);
  }
}

/** Walk the focus ring until this control is the marked one. */
function* reach(pty: Pty, label: string): Operation<void> {
  const deadline = Date.now() + ACT_MS;
  while (!(yield* pty.shows()).some((line) => line.includes(`> ${label}`))) {
    if (Date.now() > deadline) {
      throw new Error(
        `focus never reached ${label} under ${cliRuntime()}. screen=` +
          JSON.stringify((yield* pty.shows()).map((one) => one.trimEnd())),
      );
    }
    yield* pty.type("\t");
    yield* sleep(250);
  }
}

/**
 * Activate the control holding this text with a pointer.
 *
 * The focus ring inside the question drawer does not stop on an enum's offered
 * values: they are drawn and pointable, and a pointer is how a keyboard-only
 * harness reaches one.
 */
function* click(pty: Pty, text: string): Operation<void> {
  const screen = yield* pty.shows();
  const row = screen.findIndex((line) => line.includes(text));
  if (row < 0) {
    throw new Error(
      `nothing on this screen holds ${JSON.stringify(text)} to click. screen=` +
        JSON.stringify(screen.map((one) => one.trimEnd())),
    );
  }
  const column = (screen[row] ?? "").indexOf(text) + 1;
  yield* pty.type(`\u001b[<0;${column};${row + 1}M`);
  yield* pty.type(`\u001b[<0;${column};${row + 1}m`);
  yield* sleep(300);
}

/** Wait for the command to end, and answer with its status. */
function* ended(pty: Pty): Operation<number> {
  const deadline = Date.now() + ACT_MS;
  while (true) {
    const status = yield* pty.status();
    if (status !== undefined) {
      return status;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the command never finished under ${cliRuntime()}. screen=` +
          JSON.stringify((yield* pty.shows()).map((one) => one.trimEnd())),
      );
    }
    yield* sleep(150);
  }
}

/** The one location this command printed for a caller to come back with. */
function printedLocation(screen: string): string {
  const found = screen.match(/xmd repl '(xmd:\/\/repl\/[^']+)'/);
  if (found === null || found[1] === undefined) {
    throw new Error(
      `this command printed no reopenable location. screen=${JSON.stringify(screen)}`,
    );
  }
  return found[1];
}

/** How a process reaches this tracker: the operator's two variables. */
function configured(server: IssueTrackerServer, token: string): readonly string[] {
  return [
    `export XMD_WORKFLOW_GITHUB_ISSUES=${shellQuote(
      JSON.stringify({ ceiling: [TRACKER], endpoint: server.url }),
    )}`,
    `export GH_TOKEN=${shellQuote(token)}`,
  ];
}

/** Every POST this tracker received, which is where a second issue would show. */
function creates(server: IssueTrackerServer): number {
  return server.requests.filter((request) => request.method === "POST").length;
}

/**
 * File an issue, leave at a question, and come back to the printed location.
 *
 * The reopened process carries a credential this tracker rejects, so any live
 * request it made would fail where the screen can see it. What it shows instead
 * is the issue it already filed and the snapshot it already read.
 */
export function replIssuesJourney(repl: ReplCommand): Operation<void> {
  return scoped(function* (): Operation<void> {
    const home = yield* useTempDirectory("xmd-repl-issues-pty-");
    const server = yield* useIssueTrackerServer();
    const inside = (args: readonly string[], token: string): string =>
      [...configured(server, token), `cd ${shellQuote(home)}`, repl(args)].join("; ");

    const first = yield* allocate(inside(["repl", "--deny-all"], credential()), home);
    yield* showing(first, "[exit]", REACH_MS);

    // Typed as a person types it: one paste carrying newlines, then Enter.
    yield* first.type(ENTRY);
    yield* sleep(500);
    yield* first.type("\r");

    // The prefix ran: one issue was filed, and the two facts the document
    // asked for are on the screen.
    yield* showing(first, `filed at ${TRACKER}/issues/1`, ACT_MS);
    yield* showing(first, "titled A journey issue", ACT_MS);
    expect(server.issues.length).toBe(1);
    expect(creates(server)).toBe(1);
    const mark = server.issues[0]?.body ?? "";

    // And the write after the question has not happened.
    yield* showing(first, "waiting for an answer", ACT_MS);

    yield* reach(first, "[exit]");
    yield* first.type("\r");
    expect(yield* ended(first)).toBe(0);
    const location = printedLocation((yield* first.shows()).join("\n"));

    // Reopened with a credential this tracker refuses. A replayed upsert or
    // read would reach it and fail; what the entry holds is already retained.
    const second = yield* allocate(
      inside(["repl", "--deny-all", location], "a-credential-this-tracker-does-not-accept"),
      home,
    );
    yield* showing(second, "[exit]", REACH_MS);
    yield* showing(second, "waiting for an answer", ACT_MS);
    expect(creates(server)).toBe(1);
    expect(yield* exists(join(home, "after.md"))).toBe(false);

    // Answered through the real drawer, which is where the prompt is rendered.
    // What it carries is the URL the completed read bound — from a record, in a
    // process whose credential this tracker rejects.
    yield* reach(second, "[answer]");
    yield* second.type("\r");
    yield* showing(second, `Recorded issue: ${TRACKER}/issues/1`, ACT_MS);
    yield* click(second, "( ) continue");
    yield* showing(second, "[ok] entry-1", ACT_MS);

    // One new suffix effect, executed on the answer and nothing before it: the
    // issue is the one issue, with the mark it was filed under untouched.
    yield* holding(join(home, "after.md"), "continued");
    expect(server.issues.length).toBe(1);
    expect(server.issues[0]?.body ?? "").toBe(mark);
    expect(creates(server)).toBe(1);

    yield* reach(second, "[exit]");
    yield* second.type("\r");
    expect(yield* ended(second)).toBe(0);
  });
}

/**
 * Leave while the tracker is holding an accepted create, and come back.
 *
 * The one state a reconciliation key exists for: the issue is filed and this
 * end never learned of it, so the next attempt has to recognize its own mark
 * rather than file a second one.
 */
export function replIssuesAdoptionJourney(repl: ReplCommand): Operation<void> {
  return scoped(function* (): Operation<void> {
    const home = yield* useTempDirectory("xmd-repl-issues-adopt-");
    const accepted = withResolvers<void>();
    const release = withResolvers<void>();
    let held = false;
    const server = yield* useIssueTrackerServer({
      *settle(answer): Operation<void> {
        // Only the create, and only once: the reopened attempt has to be able
        // to observe and adopt without being held as well.
        if (answer.status !== 201 || held) {
          return;
        }
        held = true;
        accepted.resolve();
        yield* release.operation;
      },
    });
    const inside = (args: readonly string[]): string =>
      [...configured(server, credential()), `cd ${shellQuote(home)}`, repl(args)].join("; ");

    const first = yield* allocate(inside(["repl", "--deny-all"]), home);
    yield* showing(first, "[exit]", REACH_MS);
    yield* first.type(ENTRY);
    yield* sleep(500);
    yield* first.type("\r");

    // The tracker has the issue, and the answer is still on this side of the
    // wire. Nothing about it is retained.
    yield* accepted.operation;
    expect(server.issues.length).toBe(1);
    const mark = server.issues[0]?.body ?? "";

    // Left while the request is in flight: the entry is cancelled and the
    // command still prints the location it ended at.
    yield* reach(first, "[exit]");
    yield* first.type("\r");
    expect(yield* ended(first)).toBe(0);
    const location = printedLocation((yield* first.shows()).join("\n"));
    release.resolve();

    const second = yield* allocate(inside(["repl", "--deny-all", location]), home);
    yield* showing(second, "[exit]", REACH_MS);
    // The same owner and the same site, so the same key: the adapter finds its
    // own mark on the issue that is already there and adopts it.
    yield* showing(second, `filed at ${TRACKER}/issues/1`, ACT_MS);
    expect(server.issues.length).toBe(1);
    expect(server.issues[0]?.body ?? "").toBe(mark);

    yield* reach(second, "[exit]");
    yield* second.type("\r");
    expect(yield* ended(second)).toBe(0);
  });
}

/**
 * What a runtime with no entry issue host does instead.
 *
 * Node and Bun assemble none — the Deno adapter's module graph reaches
 * `node:sqlite`, which Bun has not — so their branch runs the behavior that
 * matters there: `<Issue>` is still a name the REPL resolves, and reaching it
 * says there is no provider rather than reaching a transport nobody configured.
 * Neither branch silently skips its own behavior.
 */
export function replIssuesUnsupported(repl: ReplCommand): Operation<void> {
  return scoped(function* (): Operation<void> {
    const home = yield* useTempDirectory("xmd-repl-issues-absent-");
    const server = yield* useIssueTrackerServer();
    const line = [
      ...configured(server, credential()),
      `cd ${shellQuote(home)}`,
      repl(["repl", "--deny-all"]),
    ].join("; ");

    const pty = yield* allocate(line, home);
    yield* showing(pty, "[exit]", REACH_MS);
    yield* pty.type(ENTRY);
    yield* sleep(500);
    yield* pty.type("\r");

    yield* showing(pty, "no Issue provider is installed", ACT_MS);
    // Configured and reachable, and never reached: what is absent is the host
    // that would have installed a lifecycle, not the operator's configuration.
    expect(server.requests).toEqual([]);

    yield* reach(pty, "[exit]");
    yield* pty.type("\r");
    expect(yield* ended(pty)).toBe(0);
  });
}
