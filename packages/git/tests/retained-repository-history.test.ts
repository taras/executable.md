/**
 * Seven histories the merged implementation wrote, continued through the shared
 * components that replaced it.
 *
 * The fixtures beside this file were emitted by old `main`
 * `7ee526665dcadd9ec79dca9f8b6a4726903d9a4f` before the component-boundary
 * repair touched production, and their receipt records the revision, the
 * command, the owner, the paths each record addresses, where each history was
 * cut and what service state the capture left behind. Nothing here regenerates
 * one: a fixture a verification rewrote would prove only that the new code
 * agrees with itself.
 *
 * Every history is cut while its root is unfinished, so a continuation has to
 * re-enter the component rather than replay a settled root. Every recorded path
 * is used exactly as captured; where a continuation reaches a host or a service
 * at all, it reaches a deterministic substitute addressing those same paths,
 * which is what the receipt's `continuation` note says.
 *
 * These rows carry A3 of the component-boundary repair matrix.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
import type { FilePathInput, FilesHandler, FileWriteInput } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { collect, Elicitation } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { gitPlugin } from "../src/plugin.ts";
import { replRepositoryInstallation } from "../src/deno/retained-repository/provider.ts";
import { replIssueInstallation } from "../src/deno/retained-repository/issues.ts";
import { UNAUTHENTICATED } from "../src/deno/composition/authentication.ts";
import type { GitAuthenticationSession } from "../src/deno/composition/authentication.ts";
import type { GitInvocation, GitOutcome, RepositoryHost } from "../src/deno/composition/host.ts";
import { GIT_HOST_EFFECT } from "../src/git-host/effect-type.ts";
import { ISSUE_EFFECT } from "../src/issue/effect-type.ts";
import {
  parseReplPushRequestRecord,
  REPL_REPOSITORY_PUSH_REQUEST,
} from "../src/retained-repository/push-records.ts";
import type { ReplPushRequestRecord } from "../src/retained-repository/push-records.ts";
import { parseGitHostReconciliationRecord } from "../src/git-host/records.ts";
import { gitHubSource } from "../src/deno/composition/github.ts";
import { useIssueTrackerServer } from "./support/issue-tracker-server.ts";
import type { ServedIssue } from "./support/issue-tracker-server.ts";
import { gitHubAccessFor } from "./support/issue-providers.ts";

/** Where the immutable fixtures live, relative to this file. */
const FIXTURES = new URL("./fixtures/retained-repository-history/", import.meta.url);

/** The tracker every captured Issue history filed in. */
const TRACKER = "https://github.com/octo/project";

/** One captured history, as its receipt records it. */
interface Recorded {
  readonly fixture: string;
  readonly cut: string;
  readonly owner: string;
  readonly events: number;
  readonly journalSha256: string;
  readonly sourceSha256: string;
  readonly documentPath: string;
  readonly paths: {
    readonly root: string;
    readonly origin: string;
    readonly checkout: string;
    readonly managedRoot: string;
    readonly enteredThrough: string;
  };
  readonly service: Json;
  readonly nativeSubcommands: readonly string[];
}

interface Receipt {
  readonly capturedFrom: { readonly commit: string; readonly tree: string };
  readonly command: string;
  readonly scenarios: readonly Recorded[];
}

/** The receipt, parsed rather than asserted: it is a file on disk. */
function* receipt(): Operation<Receipt> {
  const text = yield* readTextFile(new URL("receipt.json", FIXTURES).pathname);
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || !("scenarios" in value)) {
    throw new Error("the history receipt does not describe its scenarios");
  }
  const scenarios = (value as { scenarios: unknown }).scenarios;
  if (!Array.isArray(scenarios)) {
    throw new Error("the history receipt's scenarios are not a list");
  }
  const parsed: Recorded[] = [];
  for (const scenario of scenarios) {
    parsed.push(scenario as Recorded);
  }
  const captured = (value as { capturedFrom?: unknown }).capturedFrom;
  const command = (value as { command?: unknown }).command;
  if (typeof command !== "string" || typeof captured !== "object" || captured === null) {
    throw new Error("the history receipt records no provenance");
  }
  return {
    capturedFrom: captured as Receipt["capturedFrom"],
    command,
    scenarios: parsed,
  };
}

/** One scenario's recorded facts, by fixture name. */
function* recorded(fixture: string): Operation<Recorded> {
  const found = (yield* receipt()).scenarios.find((scenario) => scenario.fixture === fixture);
  if (found === undefined) {
    throw new Error(`the history receipt records no ${fixture}`);
  }
  return found;
}

/** The exact source bytes that history ran. */
function* source(fixture: string): Operation<string> {
  return yield* readTextFile(new URL(`${fixture}/source.md`, FIXTURES).pathname);
}

/** The exact journal bytes that history left behind. */
function* journal(fixture: string): Operation<readonly DurableEvent[]> {
  const text = yield* readTextFile(new URL(`${fixture}/journal.json`, FIXTURES).pathname);
  const events: unknown = JSON.parse(text);
  if (!Array.isArray(events)) {
    throw new Error(`${fixture} holds no journal`);
  }
  const parsed: DurableEvent[] = [];
  for (const event of events) {
    parsed.push(event as DurableEvent);
  }
  return parsed;
}

/**
 * The document, written back at the path its own history records.
 *
 * Recreated rather than relocated. A root import holds the path and the content
 * it was read from, so a continuation standing somewhere else would be a
 * different run of a different document — and the point of these rows is that
 * it is the same one.
 */
function placeDocument(scenario: Recorded, text: string): Operation<void> {
  return resource<void>(function* (provide) {
    yield* until(mkdir(dirname(scenario.documentPath), { recursive: true }));
    yield* writeTextFile(scenario.documentPath, text);
    yield* provide();
  });
}

/** The host filesystem, as production reads it. */
function hostFiles(): FilesHandler {
  const host = hostFilesHandler();
  return {
    checkFilePath: (input: FilePathInput) => host.checkFilePath(input),
    readTextFile: (input: FilePathInput) => host.readTextFile(input),
    globFiles: (input) => host.globFiles(input),
    temporaryDirectory: () => host.temporaryDirectory(),
    writeTextFile: (input: FileWriteInput) => host.writeTextFile(input),
    deleteFile: (input) => host.deleteFile(input),
    ensureDirectory: (input) => host.ensureDirectory(input),
  };
}

/** What a continuation asked of its substituted leaves. */
interface Asked {
  /** Every native invocation, in order, as its argument list. */
  readonly commands: string[][];
  /** Every isolation directory acquired. */
  directories: number;
  /** Every authentication session opened, by locator. */
  readonly sessions: string[];
}

function asked(): Asked {
  return { commands: [], directories: 0, sessions: [] };
}

/** The subcommand of each native invocation, in order. */
function subcommands(seen: Asked): string[] {
  return seen.commands.map((args) => args.find((arg) => !arg.startsWith("-")) ?? "");
}

/**
 * A native host that answers nothing and records everything.
 *
 * What the four provider-free rows below need: any invocation at all defeats
 * what those rows assert, so the refusal says so rather than pretending to be
 * `git`.
 */
function refusingHost(seen: Asked): RepositoryHost {
  return {
    // deno-lint-ignore require-yield
    *git(invocation: GitInvocation): Operation<GitOutcome> {
      seen.commands.push([...invocation.args]);
      throw new Error(`a restored history ran git ${invocation.args.join(" ")}`);
    },
    // deno-lint-ignore require-yield
    *useDirectory(): Operation<string> {
      seen.directories += 1;
      throw new Error("a restored history acquired an isolation directory");
    },
    // deno-lint-ignore require-yield
    *useAuthentication(locator: string): Operation<GitAuthenticationSession> {
      seen.sessions.push(locator);
      throw new Error("a restored history opened an authentication session");
    },
  };
}

interface Continued {
  readonly output: string;
  readonly refusal: string | undefined;
  readonly events: readonly DurableEvent[];
}

/**
 * Continue one captured history through the shared components.
 *
 * The production entry assembly, for the owner the capture recorded, over the
 * exact journal bytes it left behind and the exact document it ran.
 */
function continuePush(
  scenario: Recorded,
  text: string,
  stream: DurableStream,
  host: RepositoryHost,
  options: { readonly answer?: Json } = {},
): Operation<Continued> {
  return scoped(function* (): Operation<Continued> {
    yield* placeDocument(scenario, text);
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd(): Operation<string> {
          return scenario.paths.enteredThrough;
        },
      },
      { at: "min" },
    );
    const files = hostFiles();
    yield* API.Files.around(
      {
        checkFilePath: ([input]) => files.checkFilePath(input),
        readTextFile: ([input]) => files.readTextFile(input),
        globFiles: ([input]) => files.globFiles(input),
        temporaryDirectory: () => files.temporaryDirectory(),
        writeTextFile: ([input]) => files.writeTextFile(input),
        deleteFile: ([input]) => files.deleteFile(input),
        ensureDirectory: ([input]) => files.ensureDirectory(input),
      },
      { at: "min" },
    );
    if (options.answer !== undefined) {
      const answer = options.answer;
      yield* Elicitation.around(
        {
          // deno-lint-ignore require-yield
          *elicit(): Operation<unknown> {
            return answer;
          },
        },
        { at: "min" },
      );
    }
    const contributed = yield* replContribution();
    const installation = yield* replRepositoryInstallation(scenario.owner, {
      host,
      identity: statedIdentity,
      root: scenario.paths.managedRoot,
    });
    let refusal: string | undefined;
    let output = "";
    try {
      output = String(
        yield* collect(
          yield* executeInstalled(
            { path: scenario.documentPath, stream, includes: [scenario.paths.root] },
            [contributed, installation],
          ),
        ),
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    return { output, refusal, events: yield* stream.readAll() };
  });
}

/** The same, for the histories whose capability was issues alone. */
function continueIssue(
  scenario: Recorded,
  text: string,
  stream: DurableStream,
  issues: readonly ServedIssue[],
  options: { readonly answer?: Json; readonly endpoint?: string } = {},
): Operation<Continued> {
  return scoped(function* (): Operation<Continued> {
    yield* placeDocument(scenario, text);
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd(): Operation<string> {
          return scenario.paths.checkout;
        },
      },
      { at: "min" },
    );
    const files = hostFiles();
    yield* API.Files.around(
      {
        checkFilePath: ([input]) => files.checkFilePath(input),
        readTextFile: ([input]) => files.readTextFile(input),
        globFiles: ([input]) => files.globFiles(input),
        temporaryDirectory: () => files.temporaryDirectory(),
        writeTextFile: ([input]) => files.writeTextFile(input),
        deleteFile: ([input]) => files.deleteFile(input),
        ensureDirectory: ([input]) => files.ensureDirectory(input),
      },
      { at: "min" },
    );
    if (options.answer !== undefined) {
      const answer = options.answer;
      yield* Elicitation.around(
        {
          // deno-lint-ignore require-yield
          *elicit(): Operation<unknown> {
            return answer;
          },
        },
        { at: "min" },
      );
    }
    const endpoint = options.endpoint;
    const contributed = yield* replContribution();
    const installation = replIssueInstallation(scenario.owner, {
      ...(endpoint === undefined
        ? {}
        : { access: gitHubSource(gitHubAccessFor(endpoint, { credential: "valid" })) }),
      configuration: { ceiling: [TRACKER] },
    });
    let refusal: string | undefined;
    let output = "";
    try {
      output = String(
        yield* collect(
          yield* executeInstalled(
            { path: scenario.documentPath, stream, includes: [scenario.paths.root] },
            [contributed, installation],
          ),
        ),
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    return { output, refusal, events: yield* stream.readAll() };
  });
}

/** What the Git Plugin contributes to a `repl` entry's execution. */
function* replContribution(): Operation<{
  readonly admissions: readonly ((retained: readonly DurableEvent[]) => Operation<void>)[];
}> {
  const install = gitPlugin.install;
  if (install === undefined) {
    throw new Error("the Git Plugin installs nothing");
  }
  const installed = yield* install.call(gitPlugin, { command: "repl", args: [] });
  if (installed === undefined) {
    throw new Error("the Git Plugin declared nothing for the repl command");
  }
  return { admissions: [...(installed.admissions ?? [])] };
}

/** The identity the capture stated, restated here so a replay matches it. */
const STATED_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_IDENT: "Entry Author <author@example.test> 1700000000 +0000",
  GIT_COMMITTER_IDENT: "Entry Committer <committer@example.test> 1700000000 +0000",
};

// deno-lint-ignore require-yield
function* statedIdentity(variable: string): Operation<string | undefined> {
  return STATED_IDENTITY[variable];
}

/** Every saved publication request this history holds, parsed. */
function requests(events: readonly DurableEvent[]): ReplPushRequestRecord[] {
  const found: ReplPushRequestRecord[] = [];
  for (const event of events) {
    if (event.type !== "yield" || event.description.type !== REPL_REPOSITORY_PUSH_REQUEST) {
      continue;
    }
    if (event.result.status !== "ok") {
      continue;
    }
    const record = parseReplPushRequestRecord(event.result.value);
    if (record !== undefined) {
      found.push(record);
    }
  }
  return found;
}

/** Every Git-host outcome this history holds, as the journal holds it. */
function outcomes(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === GIT_HOST_EFFECT,
  );
}

/** Every Issue effect this history holds, in order. */
function issues(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === ISSUE_EFFECT,
  );
}

/** The prefix a continuation inherited, which it may not rewrite. */
function prefix(events: readonly DurableEvent[], length: number): readonly DurableEvent[] {
  return events.slice(0, length);
}

/** A scratch directory a substituted host hands out as its isolation root. */
function useScratch(): Operation<string> {
  return resource<string>(function* (provide) {
    const root = yield* until(mkdtemp(join(tmpdir(), "retained-history-")));
    yield* ensure(() => until(rm(root, { recursive: true, force: true })));
    yield* provide(root);
  });
}

describe("histories the merged implementation wrote, continued through the shared components", () => {
  it("A3: the fixtures are the ones old main emitted, and verification rewrites none", function* (): Operation<void> {
    const record = yield* receipt();
    expect(record.capturedFrom.commit).toBe("7ee526665dcadd9ec79dca9f8b6a4726903d9a4f");
    expect(record.capturedFrom.tree).toBe("942739ff98195a0113ad6508da48b05874deaf97");
    expect(record.scenarios).toHaveLength(7);
    for (const scenario of record.scenarios) {
      const events = yield* journal(scenario.fixture);
      expect(events).toHaveLength(scenario.events);
      // No root close: every one of these was cut while its root was
      // unfinished, so a continuation re-enters the component rather than
      // replaying a settled root.
      expect(events.some((event) => event.type === "close" && event.coroutineId === "root")).toBe(
        false,
      );
      // The owner every record in it was written under is the one the receipt
      // names, which is what a continuation presents again.
      expect(scenario.owner).toContain("executablemd.repl.issue-owner");
    }
  });

  it("H1: a completed publication restores with no native work at all", function* (): Operation<void> {
    const scenario = yield* recorded("h1-push-completed");
    const text = yield* source("h1-push-completed");
    const inherited = yield* journal("h1-push-completed");
    const seen = asked();
    const stream = new InMemoryStream([...inherited]);

    const again = yield* continuePush(scenario, text, stream, refusingHost(seen), {
      answer: { choice: "continue" },
    });

    expect(again.refusal).toBe(undefined);
    // Nothing native, no provider, no configuration and no credential.
    expect(seen.commands).toEqual([]);
    expect(seen.directories).toBe(0);
    expect(seen.sessions).toEqual([]);
    // The prefix is untouched, and the publication is still one request and one
    // outcome at the positions the old implementation wrote them at.
    expect(prefix(again.events, inherited.length)).toEqual(inherited);
    expect(requests(again.events)).toHaveLength(1);
    expect(outcomes(again.events)).toHaveLength(1);
    expect(requests(again.events)[0]?.owner).toBe(scenario.owner);
  });

  it("H4: a definitive publication failure restores as itself, provider-free", function* (): Operation<void> {
    const scenario = yield* recorded("h4-push-failed");
    const text = yield* source("h4-push-failed");
    const inherited = yield* journal("h4-push-failed");
    const seen = asked();
    const stream = new InMemoryStream([...inherited]);

    const again = yield* continuePush(scenario, text, stream, refusingHost(seen), {
      answer: { choice: "continue" },
    });

    // The failure the old implementation acknowledged is the failure this run
    // reports, and it reaches no provider to find that out.
    expect(again.refusal).not.toBe(undefined);
    expect(seen.commands).toEqual([]);
    expect(seen.directories).toBe(0);
    expect(seen.sessions).toEqual([]);
    expect(prefix(again.events, inherited.length)).toEqual(inherited);
    const failed = outcomes(again.events);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.type === "yield" ? failed[0].result.status : undefined).toBe("err");
  });

  it("H5: a completed read and upsert restore their bindings past both chains", function* (): Operation<void> {
    const scenario = yield* recorded("h5-issue-completed");
    const text = yield* source("h5-issue-completed");
    const inherited = yield* journal("h5-issue-completed");
    const stream = new InMemoryStream([...inherited]);

    // No endpoint at all: a transport reached on this continuation has nowhere
    // to go, so reaching one would fail rather than quietly succeed.
    const again = yield* continueIssue(scenario, text, stream, [], {
      answer: { choice: "continue" },
    });

    expect(again.refusal).toBe(undefined);
    expect(prefix(again.events, inherited.length)).toEqual(inherited);
    const records = issues(again.events);
    expect(records).toHaveLength(2);
    // The composed answer the old run retained for its read is the binding this
    // one restores, including the middleware answer that never reached a tracker.
    const restored = records.map((event) =>
      event.type === "yield" && event.result.status === "ok" ? event.result.value : undefined,
    );
    const original = issues(inherited).map((event) =>
      event.type === "yield" && event.result.status === "ok" ? event.result.value : undefined,
    );
    expect(restored).toEqual(original);
  });

  it("H7: a definitive issue failure restores without a transport", function* (): Operation<void> {
    const scenario = yield* recorded("h7-issue-failed");
    const text = yield* source("h7-issue-failed");
    const inherited = yield* journal("h7-issue-failed");
    const stream = new InMemoryStream([...inherited]);

    const again = yield* continueIssue(scenario, text, stream, [], {
      answer: { choice: "continue" },
    });

    expect(again.refusal).not.toBe(undefined);
    expect(prefix(again.events, inherited.length)).toEqual(inherited);
    const failed = issues(again.events);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.type === "yield" ? failed[0].result.status : undefined).toBe("err");
  });

  it("H6: an unacknowledged upsert presents its original key and adopts one issue", function* (): Operation<void> {
    const scenario = yield* recorded("h6-issue-unacknowledged");
    const text = yield* source("h6-issue-unacknowledged");
    const inherited = yield* journal("h6-issue-unacknowledged");
    const stream = new InMemoryStream([...inherited]);

    // The service state the capture left behind: the tracker already holds the
    // issue this entry filed, carrying the mark the adapter wrote under the
    // original key. A deterministic substitute addressing the same tracker.
    const served = seededIssues(scenario);
    expect(served).toHaveLength(1);
    const server = yield* useIssueTrackerServer({ issues: served.map((issue) => ({ ...issue })) });

    const again = yield* continueIssue(scenario, text, stream, served, {
      answer: { choice: "continue" },
      endpoint: server.url,
    });

    expect(again.refusal).toBe(undefined);
    expect(prefix(again.events, inherited.length)).toEqual(inherited);
    // One issue at the tracker, not two: the continuation presented the key the
    // interrupted attempt presented, and the adapter found its own mark.
    expect(server.issues).toHaveLength(1);
    expect(server.requests.some((request) => request.method === "POST")).toBe(false);
    const records = issues(again.events);
    expect(records).toHaveLength(1);
  });
});

/** The issues the capture's receipt says its tracker was left holding. */
function seededIssues(scenario: Recorded): ServedIssue[] {
  const service = scenario.service;
  if (typeof service !== "object" || service === null || Array.isArray(service)) {
    throw new Error(`${scenario.fixture} records no service state`);
  }
  const held = (service as Record<string, Json>)["issues"];
  if (!Array.isArray(held)) {
    throw new Error(`${scenario.fixture} records no served issues`);
  }
  const parsed: ServedIssue[] = [];
  for (const issue of held) {
    parsed.push(issue as unknown as ServedIssue);
  }
  return parsed;
}

/**
 * What a substituted remote holds at the destination a saved request names.
 *
 * The one fact a pending continuation observes about the outside world. A row
 * states it, because that is what distinguishes the two pending histories: a
 * destination that never received the branch, and one that received it before
 * the journal could record so.
 */
interface Destination {
  /** The commit the destination ref holds, or absence. */
  readonly commit: string | undefined;
}

/**
 * A native host that answers only the four questions a pending continuation
 * asks, addressing the paths the captured request recorded.
 *
 * Deterministic and leaf-level: the objects a captured checkout held are not
 * reproducible from a fixture, so what stands in for them is an answer about
 * the one object the saved request names. Everything else — the destination,
 * the control repository, the push — is answered from the row's stated
 * destination, and every argument list is recorded so a row can show which
 * facts were used.
 */
function savedObjectHost(
  seen: Asked,
  scratch: string,
  saved: ReplPushRequestRecord,
  destination: Destination,
): RepositoryHost {
  const inputs = saved.resolved.inputs;
  return {
    // deno-lint-ignore require-yield
    *git(invocation: GitInvocation): Operation<GitOutcome> {
      seen.commands.push([...invocation.args]);
      const args = invocation.args;
      if (args[0] === "rev-parse") {
        // The exact object the saved request published, which has to still be
        // readable. Anything else is absent rather than invented.
        const asked = (args[args.length - 1] ?? "").replace("^{commit}", "");
        return asked === inputs.sourceCommit
          ? { code: 0, stdout: `${inputs.sourceCommit}\n`, stderr: "" }
          : { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "init") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return {
          code: 0,
          stdout:
            destination.commit === undefined
              ? ""
              : `${destination.commit}\t${inputs.destinationRef}\n`,
          stderr: "",
        };
      }
      if (args[0] === "push") {
        return {
          code: 0,
          stdout:
            `To ${inputs.repository.name}\n` +
            `*\t${inputs.sourceCommit}:${inputs.destinationRef}\t[new branch]\nDone\n`,
          stderr: "",
        };
      }
      throw new Error(`a pending continuation ran git ${args.join(" ")}`);
    },
    // deno-lint-ignore require-yield
    *useDirectory(): Operation<string> {
      seen.directories += 1;
      return scratch;
    },
    // deno-lint-ignore require-yield
    *useAuthentication(locator: string): Operation<GitAuthenticationSession> {
      seen.sessions.push(locator);
      return UNAUTHENTICATED;
    },
  };
}

/** The commit a push invocation named as its source, and the ref it named. */
function pushed(seen: Asked): { source: string; ref: string } | undefined {
  const invocation = seen.commands.find((args) => args[0] === "push");
  const refspec = invocation?.[invocation.length - 1];
  if (refspec === undefined) {
    return undefined;
  }
  const [source, ref] = refspec.split(":");
  return source === undefined || ref === undefined ? undefined : { source, ref };
}

/** The decision one retained Git-host outcome records. */
function decisionOf(event: DurableEvent | undefined): string | undefined {
  if (event?.type !== "yield" || event.result.status !== "ok") {
    return undefined;
  }
  return parseGitHostReconciliationRecord(event.result.value)?.decision;
}

describe("pending publications the merged implementation left behind", () => {
  it("H2: continues with the saved branch, commit, ref and origin after HEAD moved", function* (): Operation<void> {
    const scenario = yield* recorded("h2-push-pending");
    const text = yield* source("h2-push-pending");
    const inherited = yield* journal("h2-push-pending");
    const saved = requests(inherited)[0];
    expect(saved).toBeDefined();
    if (saved === undefined) {
      throw new Error("h2 holds no saved publication request");
    }
    // The capture advanced that checkout's branch after cutting the entry, so
    // today's HEAD and the saved commit are different objects.
    const moved = movedHead(scenario);
    expect(moved).not.toBe(saved.resolved.inputs.sourceCommit);

    const seen = asked();
    const scratch = yield* useScratch();
    const stream = new InMemoryStream([...inherited]);
    const again = yield* continuePush(
      scenario,
      text,
      stream,
      savedObjectHost(seen, scratch, saved, { commit: undefined }),
      { answer: { choice: "continue" } },
    );

    expect(again.refusal).toBe(undefined);
    expect(prefix(again.events, inherited.length)).toEqual(inherited);
    // One request still, written once by the old implementation and consumed
    // rather than rewritten.
    expect(requests(again.events)).toHaveLength(1);
    expect(requests(again.events)[0]).toEqual(saved);
    // The destination it observed and the refspec it published are the saved
    // ones. The moved HEAD was never read: no live routing happens here.
    expect(seen.commands.filter((args) => args[0] === "ls-remote")).toEqual([
      ["ls-remote", "--", saved.resolved.origin, saved.resolved.inputs.destinationRef],
    ]);
    expect(pushed(seen)).toEqual({
      source: saved.resolved.inputs.sourceCommit,
      ref: saved.resolved.inputs.destinationRef,
    });
    expect(subcommands(seen)).not.toContain("symbolic-ref");
    // And one outcome, at the position the old history left empty.
    expect(outcomes(again.events)).toHaveLength(1);
    expect(decisionOf(outcomes(again.events)[0])).toBe("performed");
  });

  it("H3: adopts a destination the remote already holds, without mutating it again", function* (): Operation<void> {
    const scenario = yield* recorded("h3-push-unacknowledged");
    const text = yield* source("h3-push-unacknowledged");
    const inherited = yield* journal("h3-push-unacknowledged");
    const saved = requests(inherited)[0];
    expect(saved).toBeDefined();
    if (saved === undefined) {
      throw new Error("h3 holds no saved publication request");
    }
    // The capture's remote accepted this exact commit and the journal refused
    // to record it, which is the window this protocol exists for.
    expect(remoteCommitOf(scenario)).toBe(saved.resolved.inputs.sourceCommit);

    const seen = asked();
    const scratch = yield* useScratch();
    const stream = new InMemoryStream([...inherited]);
    const again = yield* continuePush(
      scenario,
      text,
      stream,
      savedObjectHost(seen, scratch, saved, {
        commit: saved.resolved.inputs.sourceCommit,
      }),
      { answer: { choice: "continue" } },
    );

    expect(again.refusal).toBe(undefined);
    expect(prefix(again.events, inherited.length)).toEqual(inherited);
    expect(requests(again.events)).toHaveLength(1);
    // Observed, recognized and adopted. Nothing was published a second time.
    expect(subcommands(seen)).toContain("ls-remote");
    expect(subcommands(seen)).not.toContain("push");
    expect(outcomes(again.events)).toHaveLength(1);
    expect(decisionOf(outcomes(again.events)[0])).toBe("adopted");
  });
});

/** The commit the capture advanced that checkout to after cutting the entry. */
function movedHead(scenario: Recorded): string | undefined {
  return stringField(scenario, "movedCheckoutHead");
}

/** The commit the capture's remote was left holding at the destination. */
function remoteCommitOf(scenario: Recorded): string | undefined {
  return stringField(scenario, "remoteCommit");
}

function stringField(scenario: Recorded, name: string): string | undefined {
  const service = scenario.service;
  if (typeof service !== "object" || service === null || Array.isArray(service)) {
    return undefined;
  }
  const value = (service as Record<string, Json>)[name];
  return typeof value === "string" ? value : undefined;
}
