/**
 * The Git Plugin: which commands it declares for, and what each execution
 * under it can see of another execution's history.
 *
 * Installing the Plugin is one act per command, and a command may execute more
 * than one document. What a Git-host record needs in order to replay is the run
 * it was written under, and that answer is one execution's — so it is carried
 * by journal admissions, which canonical core applies inside each execution's
 * own journal read. These cases hold the Plugin to both halves of that: it
 * declares only where a document is executed or described, and the value its
 * admissions install is derived from the snapshot that execution was handed and
 * from no other.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { collect, inlineSource, registerComponents } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { ExecutionInstallation } from "@executablemd/core/host";
import type { PluginInstallRequest } from "@executablemd/core/api";
import { retainedWorkflowInstallation } from "../../workflow/src/run.ts";
import type { WorkflowRun } from "../../workflow/src/run.ts";
import { declaresFor, gitPlugin } from "../src/plugin.ts";
import { retainedGitHostIdentitiesHere, retainedIssueIdentitiesHere } from "../src/identities.ts";
import {
  GIT_HOST_EFFECT,
  reconcileGitHostEffect,
  withGitHostProvider,
} from "../src/git-host/effect.ts";
import type { GitHostProvider } from "../src/git-host/api.ts";
import type {
  CompleteGitHostEffectRequest,
  GitHostCompletion,
  GitHostEffectRequest,
  GitHostObservation,
} from "../src/git-host/records.ts";

const SOURCE = "<Effect />\n";

const PUSH: GitHostEffectRequest = Object.freeze({
  kind: "git-push",
  inputs: { remote: "origin", branch: "release-1.4", commit: "9fceb02" },
  naturalKey: { ref: "refs/heads/release-1.4" },
});

const ABSENT: GitHostObservation = Object.freeze({ state: "absent", preState: { ref: null } });

const PERFORMED: GitHostCompletion = Object.freeze({
  observations: { ref: "refs/heads/release-1.4", commit: "9fceb02" },
  result: { ref: "refs/heads/release-1.4", commit: "9fceb02", updated: true },
});

function run(runId: string): WorkflowRun {
  return Object.freeze({
    runId,
    base: "main",
    pinnedCommit: "9fceb02d0ae598e95dc970b74767f19372d61af8",
  });
}

/** The two runs whose histories these cases keep apart. */
const SOURCE_A = run("run-plugin-source-a");
const SOURCE_B = run("run-plugin-source-b");

/** What one execution saw, at the boundaries a claim can be made about. */
interface Seen {
  readonly gitHost: (readonly { runId: string; claimed: boolean }[] | undefined)[];
  readonly issue: (readonly unknown[] | undefined)[];
  readonly failures: unknown[];
}

function seen(): Seen {
  return { gitHost: [], issue: [], failures: [] };
}

/** A provider that fails the test if any phase reaches it. */
const FORBIDDEN: GitHostProvider = {
  // deno-lint-ignore require-yield
  *observe(): Operation<Result<GitHostObservation>> {
    throw new Error("the Git host was observed where nothing may be observed");
  },
  // deno-lint-ignore require-yield
  *perform(): Operation<Result<GitHostCompletion>> {
    throw new Error("the Git host performed where nothing may be performed");
  },
};

/** A provider that answers absent and performs, for the recording pass only. */
const LIVE: GitHostProvider = {
  // deno-lint-ignore require-yield
  *observe(_request: CompleteGitHostEffectRequest): Operation<Result<GitHostObservation>> {
    return Ok(ABSENT);
  },
  // deno-lint-ignore require-yield
  *perform(): Operation<Result<GitHostCompletion>> {
    return Ok(PERFORMED);
  },
};

/**
 * One `<Effect />` that reports what its execution admitted before it
 * reconciles.
 *
 * Reading a context journals nothing, so the recording pass and every replay
 * expand the same document and retain the same events.
 */
function useEffectComponent(observed: Seen): Operation<void> {
  return registerComponents([
    {
      name: "Effect",
      origin: "git-plugin-tests",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        // Copied at the moment of reading. The list is a copy but its entries
        // are not, and the reconciliation below claims one of them — so an
        // entry held onto here would report what this execution did rather
        // than what it was handed.
        observed.gitHost.push(
          (yield* retainedGitHostIdentitiesHere())?.map((identity) => ({
            runId: identity.runId,
            claimed: identity.claimed,
          })),
        );
        observed.issue.push(yield* retainedIssueIdentitiesHere());
        yield* reconcileGitHostEffect(PUSH);
        return "";
      },
    },
  ]);
}

/** The history a run leaves behind when its root has not closed. */
function partial(events: DurableEvent[]): DurableEvent[] {
  return events.filter((event) => !(event.type === "close" && event.coroutineId === "root"));
}

function gitHostYields(events: DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === GIT_HOST_EFFECT,
  );
}

/**
 * One document execution, under one retained run and one Plugin contribution.
 *
 * `installation` is the same value in every call a case makes, because that is
 * the question: a host installs this Plugin once and may run many documents.
 */
function* execute(options: {
  readonly stream: InMemoryStream;
  readonly run: WorkflowRun;
  readonly installation: ExecutionInstallation;
  readonly provider: GitHostProvider;
  readonly observed: Seen;
}): Operation<void> {
  yield* scoped(function* () {
    yield* useEffectComponent(options.observed);
    try {
      yield* withGitHostProvider(options.provider, document(options));
    } catch (error) {
      // A failed document is one of the outcomes under test. What each case
      // measures is what the execution saw and what the journal holds, and both
      // outlive the failure.
      options.observed.failures.push(error);
    }
  });
}

/**
 * The document itself, as an operation the provider scope encloses.
 *
 * Deferred rather than started here: an execution built before
 * {@link withGitHostProvider} runs would look for a provider that is not
 * installed yet.
 */
function* document(options: {
  readonly stream: InMemoryStream;
  readonly run: WorkflowRun;
  readonly installation: ExecutionInstallation;
}): Operation<unknown> {
  return yield* collect(
    yield* executeInstalled({ ...inlineSource(SOURCE), stream: options.stream }, [
      retainedWorkflowInstallation(options.run),
      options.installation,
    ]),
  );
}

/** The Plugin's contribution, asked of the Plugin value exactly once. */
function* installed(request: PluginInstallRequest): Operation<ExecutionInstallation> {
  const install = gitPlugin.install;
  if (install === undefined) {
    throw new Error("the Git Plugin installed nothing");
  }
  const contribution = yield* install.call(gitPlugin, request);
  if (contribution === undefined) {
    throw new Error("the Git Plugin declared for no command");
  }
  return { admissions: [...(contribution.admissions ?? [])] };
}

/** A history holding one settled Git-host record, written under `source`. */
function* record(
  source: WorkflowRun,
  installation: ExecutionInstallation,
): Operation<DurableEvent[]> {
  const stream = new InMemoryStream();
  const observed = seen();
  yield* execute({ stream, run: source, installation, provider: LIVE, observed });
  expect(observed.failures).toEqual([]);
  // The recording pass admitted an empty history, so it saw no identity at all
  // and named itself. That is also what makes the replays below meaningful.
  expect(observed.gitHost[0]).toEqual([]);
  const events = partial(stream.snapshot());
  expect(gitHostYields(events)).toHaveLength(1);
  return events;
}

describe("the Git Plugin's command profile", () => {
  it("declares for the commands that execute or describe a document", function* () {
    for (const command of ["run", "plan", "syntax"]) {
      expect(declaresFor({ command, args: [command] })).toBe(true);
    }
  });

  it("declares for the workflow actions that execute a document, and no others", function* () {
    for (const action of ["start", "resume", "fork"]) {
      expect(declaresFor({ command: "workflow", args: ["workflow", action, "flow.md"] })).toBe(
        true,
      );
    }
    // Management and read-only actions expand nothing, and a vocabulary
    // declared into them would advertise components nothing there can run.
    for (const action of ["list", "status", "history", "cancel", "delete", "export", "answer"]) {
      expect(`${action}: ${declaresFor({ command: "workflow", args: ["workflow", action] })}`).toBe(
        `${action}: false`,
      );
    }
    // `workflow` with no action at all is the command's own help.
    expect(declaresFor({ command: "workflow", args: ["workflow"] })).toBe(false);
    // And a command this Plugin knows nothing about stays untouched, even when
    // its argv contains a word that would be an executing action elsewhere.
    for (const command of ["test", "upgrade", "init", "agent"]) {
      expect(declaresFor({ command, args: [command, "start"] })).toBe(false);
    }
  });

  it("reads an option's value as a value, never as the action", function* () {
    // Every option the command defines that takes a separated value, each with
    // an executing action's own name as that value and a management action
    // after it. Reading the first recognized word would have declared this
    // vocabulary for a command that executes no document.
    const valued: readonly (readonly [string, readonly string[]])[] = [
      ["--plugin", ["workflow", "--plugin", "start", "list"]],
      ["--output", ["workflow", "--output", "start", "export", "run-1"]],
      ["--status", ["workflow", "--status", "resume", "list"]],
      ["--id", ["workflow", "--id", "fork", "list"]],
      ["--at", ["workflow", "--at", "start", "history", "run-1"]],
      ["--artifact", ["workflow", "--artifact", "start", "status"]],
      ["--props", ["workflow", "--props", "start", "list"]],
      ["--props-name", ["workflow", "--props-name", "start", "list"]],
    ];
    for (const [option, args] of valued) {
      expect(`${option}: ${declaresFor({ command: "workflow", args })}`).toBe(`${option}: false`);
    }

    // The assigned spelling is one token. A scan that special-cased the
    // separated form would step over the action written after it.
    expect(
      declaresFor({ command: "workflow", args: ["workflow", "--output=start.xmd", "export", "r"] }),
    ).toBe(false);
    expect(
      declaresFor({
        command: "workflow",
        args: ["workflow", "--props-name=alice", "start", "flow.md"],
      }),
    ).toBe(true);

    // And the same reading still finds a real action written after an option.
    const executing: readonly (readonly string[])[] = [
      ["workflow", "--plugin", "list", "start", "flow.md"],
      ["workflow", "--id", "release-1", "start", "flow.md"],
      ["workflow", "--at", "event-4", "fork", "run-1", "flow.md"],
      ["workflow", "--verbose", "resume", "run-1"],
      ["workflow", "--json", "--props", "list", "start", "flow.md"],
    ];
    for (const args of executing) {
      expect(`${args.join(" ")}: ${declaresFor({ command: "workflow", args })}`).toBe(
        `${args.join(" ")}: true`,
      );
    }
  });

  it("finds the command past the Plugin selection, not by searching for it", function* () {
    // `--plugin` is answered before every other scanner, so the command is the
    // first token left once the selection is gone.
    const selected: readonly (readonly [readonly string[], boolean])[] = [
      [["--plugin", "extra", "workflow", "start", "flow.md"], true],
      [["--plugin", "extra", "workflow", "list"], false],
      // The specifier is a module name, and a module may be named anything —
      // including the name of a command. Searching the raw argv for the word
      // would find this specifier and read the command itself as the action.
      [["--plugin", "workflow", "workflow", "start", "flow.md"], true],
      [["--plugin", "workflow", "workflow", "list"], false],
      // The assigned spelling is one token and is removed the same way.
      [["--plugin=workflow", "workflow", "start", "flow.md"], true],
      [["--plugin=workflow", "workflow", "list"], false],
      [["--plugin=extra", "--plugin", "workflow", "workflow", "resume", "run-1"], true],
    ];
    for (const [args, declares] of selected) {
      expect(`${args.join(" ")}: ${declaresFor({ command: "workflow", args })}`).toBe(
        `${args.join(" ")}: ${declares}`,
      );
    }

    // A command line the host refuses selects nothing and installs nothing, so
    // there is no command here to declare for.
    expect(declaresFor({ command: "workflow", args: ["--plugin"] })).toBe(false);
    expect(
      declaresFor({ command: "workflow", args: ["--plugin", "--json", "workflow", "start"] }),
    ).toBe(false);

    // And a first token that is not this command is not this command: a token
    // naming no command at all is a document reference to `xmd run`.
    expect(declaresFor({ command: "workflow", args: ["start", "flow.md"] })).toBe(false);
    expect(declaresFor({ command: "workflow", args: ["flow.md", "workflow", "start"] })).toBe(
      false,
    );
  });

  it("stops scanning for an action at the end of options", function* () {
    // Everything after `--` is positional by definition, so it is not searched
    // for an action at all.
    expect(declaresFor({ command: "workflow", args: ["workflow", "--", "start"] })).toBe(false);
    expect(declaresFor({ command: "workflow", args: ["workflow", "--", "list"] })).toBe(false);
    // But a valued option takes the token after it whatever that token is, so
    // this `--` is the id and `start` is still the action.
    expect(declaresFor({ command: "workflow", args: ["workflow", "--id", "--", "start"] })).toBe(
      true,
    );
    expect(declaresFor({ command: "workflow", args: ["workflow", "--id", "--", "list"] })).toBe(
      false,
    );
    expect(declaresFor({ command: "workflow", args: ["workflow", "--"] })).toBe(false);
  });

  it("installs nothing for a command it does not declare for", function* () {
    const install = gitPlugin.install;
    if (install === undefined) {
      throw new Error("the Git Plugin installed nothing");
    }
    expect(
      yield* install.call(gitPlugin, { command: "workflow", args: ["workflow", "list"] }),
    ).toBe(undefined);
    const contribution = yield* install.call(gitPlugin, { command: "run", args: ["run"] });
    expect(contribution?.admissions).toHaveLength(2);
  });
});

describe("one Plugin value, one execution's retained identities", () => {
  it("derives each execution's identities from its own history and no other", function* () {
    // One installation, asked of the Plugin once, and used by every execution
    // below — which is what a host running several documents under one command
    // actually holds.
    const installation = yield* installed({ command: "run", args: ["run"] });

    const historyA = yield* record(SOURCE_A, installation);
    const historyB = yield* record(SOURCE_B, installation);

    // Every replay below runs provider-free, so what it consumes is the
    // retained record and nothing else, and what it reports is the value its
    // own execution's journal read installed.
    const first = seen();
    yield* execute({
      stream: new InMemoryStream(historyA),
      run: SOURCE_A,
      installation,
      provider: FORBIDDEN,
      observed: first,
    });
    expect(first.failures).toEqual([]);
    expect(first.gitHost[0]?.map((identity) => identity.runId)).toEqual([SOURCE_A.runId]);
    expect(first.gitHost[0]?.every((identity) => !identity.claimed)).toBe(true);

    const second = seen();
    yield* execute({
      stream: new InMemoryStream(historyB),
      run: SOURCE_B,
      installation,
      provider: FORBIDDEN,
      observed: second,
    });
    expect(second.failures).toEqual([]);
    // Nothing of the first execution's history is here: not its run, and not
    // an identity it had already consumed.
    expect(second.gitHost[0]?.map((identity) => identity.runId)).toEqual([SOURCE_B.runId]);
    expect(second.gitHost[0]?.every((identity) => !identity.claimed)).toBe(true);

    // And the first history is still its own after both of those ran. A queue
    // shared between executions would be consumed by now.
    const again = seen();
    yield* execute({
      stream: new InMemoryStream(historyA),
      run: SOURCE_A,
      installation,
      provider: FORBIDDEN,
      observed: again,
    });
    expect(again.failures).toEqual([]);
    expect(again.gitHost[0]?.map((identity) => identity.runId)).toEqual([SOURCE_A.runId]);
    expect(again.gitHost[0]?.every((identity) => !identity.claimed)).toBe(true);

    // The Issue admission installed its own value on the same terms: a list
    // this history holds nothing in, rather than the absence that means no
    // admission ran.
    for (const observed of [first, second, again]) {
      expect(observed.issue[0]).toEqual([]);
    }
  });
});
