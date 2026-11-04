import { describe, it } from "@executablemd/test-support/bdd";
import { cliCommand, cliRuntime } from "@executablemd/test-support/launch";
import { expect } from "@executablemd/test-support/expect";
import {
  Err,
  Ok,
  ensure,
  race,
  scoped,
  sleep,
  spawn,
  suspend,
  until,
  withResolvers,
} from "effection";
import type { Operation, Result } from "effection";
import { ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import { exec, Stdio } from "@effectionx/process";
import { realpath } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { z } from "zod";
import { Execution } from "@executablemd/core/api";
import { API, Permissions } from "@executablemd/runtime";
import { Elicitation, isJsonObject, registerComponents, retainedSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream, StaleInputError } from "@executablemd/durable-streams";
import { sidekickRequests } from "../src/repl/sidekick/requests.ts";
import {
  sidekickCeilingInstallation,
  sidekickResponseCeiling,
} from "../src/repl/sidekick/profile.ts";
import type { ControlJournal } from "../src/repl/sidekick/controls.ts";
import { GitOperationAdmissionError, gitPlugin } from "@executablemd/git";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { useMountedHost, MOUNTED_AGENT } from "./support/mounted-repl.ts";
import { runGit } from "./support/fixture-git.ts";
import { makeRegistry, makeStore } from "./support/fake-acp.ts";
import { START_CHILD } from "./support/headless-repl.ts";
import { installPlugins } from "../src/plugin-host.ts";
import { replRepositoryPlugin } from "../src/repl/repositories/plugin.ts";
import { replRepositoryInstallation } from "../src/repl/repositories/deno/provider.ts";
import { resolveAgentStack } from "../src/agent-stack.ts";
import { assembleReplProfile } from "../src/repl-profile.ts";
import { runReplProgram } from "../src/repl/program.ts";
import type { HeadlessReplRoot } from "../src/repl/program.ts";
import type { ReplSubmission } from "../src/repl/session.ts";
import { ReplEntryHost } from "../src/repl-entry-installation.ts";
import { useReplLiveScreen } from "../src/repl/live-screen.ts";
import { usePosixSidekickTransport } from "../src/sidekick-acp/posix.ts";
import { childAddressPath } from "../src/headless/host.ts";
import { requestAttachment } from "../src/sidekick-acp/client.ts";
import { runReplSubmit } from "../src/sidekick-acp/submit.ts";
import { readRecords } from "../src/repl/journal.ts";
import { projectRepl } from "../src/repl/model.ts";
import { readEntryJournal } from "../src/repl/sidekick/entry-inspection.ts";
import { useSecretScannerFactory } from "../../core/src/secrets/policy.ts";
import type { SecretFinding } from "../../core/src/secrets/findings.ts";

function value<T>(result: Result<T>): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
function deadline<T>(operation: Operation<T>, milliseconds = 15000): Operation<T> {
  return race([
    operation,
    (function* (): Operation<never> {
      yield* sleep(milliseconds);
      throw new Error("The controlled unfinished-entry boundary did not settle.");
    })(),
  ]);
}
function gate() {
  const entered = withResolvers<void>();
  const released = withResolvers<void>();
  return {
    entered: entered.operation,
    enter: entered.resolve,
    release: released.resolve,
    wait: released.operation,
  };
}
const execution = z
  .object({
    joined: z.boolean().nullable(),
    outcome: z.enum(["completed", "failed", "interrupted"]).nullable(),
    error: z.object({ name: z.string(), message: z.string() }).strict().nullable(),
  })
  .strict();
const page = z
  .object({
    value: z.unknown(),
    next: z.string().nullable(),
    prev: z.string().nullable(),
    last: z.string().nullable(),
  })
  .strict();
const unknownExecution = { joined: null, outcome: null, error: null };
const pendingExecution = { joined: false, outcome: null, error: null };
const withheld = {
  name: "Error",
  message: "Execution error details were withheld because disclosure checks could not complete.",
};
const QUESTION =
  '<Elicit as="answer" schema={{type:"object",properties:{decision:{type:"string"}},required:["decision"],additionalProperties:false}}>Continue?</Elicit>';
type Root = Parameters<HeadlessReplRoot["ready"]>[0];

function* fixture() {
  const directory = yield* until(realpath(yield* useTemporary("xmd-unfinished-entry-")));
  const A = `${directory}/A`;
  const B = `${directory}/B`;
  for (const repository of [A, B]) {
    yield* ensureDir(`${repository}/sub`);
    yield* runGit(repository, ["init", "-b", "main"]);
    yield* writeTextFile(`${repository}/tracked.txt`, "baseline");
    yield* runGit(repository, ["add", "tracked.txt"]);
    yield* runGit(repository, ["commit", "-m", "baseline"]);
  }
  const baseline = yield* repositories(A, B);
  yield* Permissions.around({
    files: ([operation], next) => (operation === "absolute" ? true : next(operation)),
  });
  const plugins = yield* installPlugins([replRepositoryPlugin(gitPlugin)], {
    command: "repl",
    args: [],
  });
  const original = yield* ReplEntryHost.get();
  const host = yield* useMountedHost({
    projectCwd: A,
    hostFiles: true,
    entryInstallation: (owner, placement) =>
      replRepositoryInstallation(owner, {
        ...placement,
        projectCwd: A,
        root: `${directory}/managed`,
        helper: { runtime: "source", platform: "unix", execPath: "/unused-credential-helper" },
      }),
  });
  const repositoryInstallation = yield* ReplEntryHost.get();
  if (repositoryInstallation === undefined) {
    throw new Error("The repository installation is absent.");
  }
  if (original !== undefined) {
    yield* ReplEntryHost.set(function* (owner, placement) {
      const extra = yield* original(owner, placement);
      const repository = yield* repositoryInstallation(owner, placement);
      return {
        ...repository,
        *install() {
          if (repository.install !== undefined) {
            yield* repository.install();
          }
          if (extra.install !== undefined) {
            yield* extra.install();
          }
        },
      };
    });
  }
  yield* API.Env.around({
    *command([args = []]) {
      const launch = cliCommand(args);
      return [launch.command, ...launch.arguments];
    },
  });
  yield* usePosixSidekickTransport(process.platform);
  const stack = value(
    yield* resolveAgentStack(
      {
        agentProvider: "acpx",
        defaultAgent: MOUNTED_AGENT,
        approveAll: false,
        approveReads: false,
        denyAll: false,
      },
      undefined,
    ),
  );
  const children: Root[] = [];
  const ready = withResolvers<Root>();
  const view = yield* useReplLiveScreen();
  const task = yield* spawn(function* () {
    const profile = yield* assembleReplProfile(stack, plugins, {
      includes: [
        fileURLToPath(
          new URL("../../../examples/adversarial-implementation/components", import.meta.url),
        ),
      ],
      sidekickAgent: MOUNTED_AGENT,
      observeChildRoot: (root) => children.push(root),
      acp: {
        sessionStore: makeStore(),
        agentRegistry: makeRegistry({ [MOUNTED_AGENT]: "inert-no-agent" }),
        createRuntime: host.fake.create,
      },
    });
    return yield* runReplProgram({
      profile,
      root: host.root,
      headless: {
        view,
        *ready(root) {
          ready.resolve(root);
        },
      },
    });
  });
  const parent = yield* ready.operation;
  const admitted = value(yield* parent.session.submit(START_CHILD));
  value(yield* admitted.join());
  const reference = z
    .object({ sessionId: z.string() })
    .parse(value(yield* parent.session.bindings()).child);
  const path = yield* childAddressPath(reference.sessionId);
  const root = children[0];
  if (root === undefined) {
    throw new Error("The real child root was not published.");
  }
  return { directory, A, B, baseline, host, task, root, path, reference };
}
type Fixture = ReturnType<typeof fixture> extends Operation<infer T> ? T : never;
function* repositories(A: string, B: string) {
  const result: { head: string; tracked: string }[] = [];
  for (const repository of [A, B]) {
    result.push({
      head: yield* runGit(repository, ["rev-parse", "HEAD"]),
      tracked: yield* runGit(repository, ["status", "--porcelain", "--untracked-files=no"]),
    });
  }
  return result;
}
function journal(f: Fixture, entry: number, yq = ".") {
  return requestAttachment(f.path, { method: "entry", entry, view: "journal", yq });
}
function* observed(f: Fixture, entry: number) {
  return execution.parse(page.parse(yield* journal(f, entry, ".execution")).value);
}
function* settled(f: Fixture, entry: number) {
  // The join observer and this reader are siblings; the wake carries no verdict.
  const changes = yield* f.root.session.changes;
  while (true) {
    const read = yield* observed(f, entry);
    if (read.joined === true) {
      return read;
    }
    yield* changes.next();
  }
}
function* submit(f: Fixture, source: string) {
  const exact = withResolvers<ReplSubmission>();
  const original = f.root.direct.submit;
  f.root.direct.submit = (source, admitted) =>
    original(source, (one) => {
      exact.resolve(one);
      admitted?.(one);
    });
  const records: unknown[] = [];
  const task = yield* spawn(() =>
    runReplSubmit(
      ["repl", "submit", "--attach", f.reference.sessionId, "-"],
      function* () {
        return Ok(source);
      },
      suspend(),
      function* (record) {
        records.push(record);
      },
      (message) => {
        console.log(message);
      },
    ),
  );
  const submission = yield* exact.operation;
  return { task, submission, records };
}
function checkout(repository: string) {
  return `<Ticket.Checkout repository=${JSON.stringify(repository)} as="checked" />`;
}
function* history(f: Fixture) {
  const path = `${f.root.workspace}/entries.jsonl`;
  return { path, bytes: yield* readTextFile(path) };
}

function control(root: Root, source: string) {
  return scoped(function* () {
    const observations: unknown[] = [];
    const journal: ControlJournal = {
      *began() {
        return observations.length;
      },
      *settled(_order, _outcome, observed) {
        observations.push(observed);
      },
    };
    const requests = sidekickRequests(root.reads, function* () {
      throw new Error("Inspection submitted an entry.");
    });
    const ceiling = sidekickResponseCeiling(requests, journal);
    const entered = withResolvers<void>();
    const released = withResolvers<void>();
    const host = yield* executeInstalled(
      {
        ...retainedSource("observation-host", "<ObservationHost />"),
        stream: new InMemoryStream(),
      },
      [
        sidekickCeilingInstallation(ceiling),
        {
          components: [
            {
              name: "ObservationHost",
              origin: "test://observation",
              props: { type: "object" },
              factory: () =>
                function* () {
                  entered.resolve();
                  yield* released.operation;
                  return "";
                },
            },
          ],
        },
      ],
    );
    const running = yield* spawn(() => host);
    yield* entered.operation;
    const response = value(
      yield* host.evaluateGeneratedXmdRoot({ id: "inspection", source, allow: [...ceiling.allow] }),
    );
    released.resolve();
    value(yield* running);
    return { observations, response };
  });
}

function* repositorySubdirectoryControl() {
  const f = yield* fixture();
  expect(f.directory).toBe(yield* until(realpath(f.directory)));
  const source = `<Dir path=${JSON.stringify(`${f.A}/sub`)}>${checkout(`${f.A}/sub`)}</Dir>`;
  const call = yield* submit(f, source);
  value(yield* deadline(call.submission.join()));
  expect(yield* deadline(call.task)).toBe(0);
  const observation = yield* deadline(settled(f, 1));
  expect(observation).toEqual({ joined: true, outcome: "completed", error: null });
  expect(page.parse(yield* journal(f, 1)).value).toMatchObject({
    status: "completed",
    failure: null,
  });
  expect(f.host.fake.prompts).toHaveLength(0);
  expect(yield* repositories(f.A, f.B)).toEqual(f.baseline);
  console.log(
    JSON.stringify({
      witness: "E3 canonical A/sub",
      directory: f.directory,
      source,
      observation,
      prompts: 0,
    }),
  );
  yield* f.task.halt();
}

function* repositoryOwnerWitness() {
  const f = yield* fixture();
  let writes = 0;
  yield* API.Files.around({
    *writeTextFile([input], next) {
      writes += 1;
      return yield* next(input);
    },
  });
  const source = `<File path="probe.txt">performed once</File><Dir path=${JSON.stringify(f.B)}>${checkout(f.B)}</Dir>`;
  const call = yield* submit(f, source);
  const joined = yield* deadline(call.submission.join());
  expect(joined.ok).toBe(false);
  if (joined.ok) {
    throw new Error("The cross-repository admission unexpectedly succeeded.");
  }
  expect(joined.error).toBeInstanceOf(GitOperationAdmissionError);
  expect(yield* deadline(call.task)).toBe(1);
  const observation = yield* deadline(settled(f, 1));
  expect(observation).toEqual({
    joined: true,
    outcome: "failed",
    error: { name: joined.error.name, message: joined.error.message },
  });
  const whole = page.parse(yield* journal(f, 1));
  expect(whole.value).toMatchObject({
    entry: 1,
    status: "unfinished",
    failure: null,
    execution: observation,
    prompts: { completed: 0, failed: 0, cancelled: 0 },
  });
  expect((yield* control(f.root, "<REPL.Entry.Journal entry={1} />")).observations).toEqual([
    whole,
  ]);
  const saved = yield* history(f);
  yield* writeTextFile(`${f.A}/probe.txt`, "external edit");
  for (let i = 0; i < 2; i += 1) {
    expect(yield* journal(f, 1)).toEqual(whole);
    expect(
      yield* requestAttachment(f.path, { method: "entry", entry: 1, view: "source" }),
    ).toMatchObject({ text: source });
    expect((yield* f.root.session.stopEntry(call.submission.entry)).ok).toBe(false);
    expect((yield* f.root.session.submit("A successor must refuse.")).ok).toBe(false);
  }
  expect(f.root.session.live).toBe(false);
  expect(yield* readTextFile(`${f.A}/probe.txt`)).toBe("external edit");
  expect((yield* history(f)).bytes).toBe(saved.bytes);
  expect(f.root.session.model.entries).toHaveLength(1);
  expect(writes).toBe(1);
  expect(f.host.fake.prompts).toHaveLength(0);
  expect(yield* repositories(f.A, f.B)).toEqual(f.baseline);
  const cold = value(projectRepl(yield* readRecords(saved.path)));
  const coldPage = value(
    yield* readEntryJournal({ entry: 1 }, { entries: cold.entries, printing: undefined }),
  );
  expect(coldPage.value).toMatchObject({
    status: "unfinished",
    failure: null,
    execution: unknownExecution,
  });
  expect((yield* history(f)).bytes).toBe(saved.bytes);
  console.log(
    JSON.stringify({
      witness: "E1/E2/E5",
      source,
      join: { name: joined.error.name, message: joined.error.message },
      public: whole,
      journalBytes: saved.bytes,
      cold: coldPage,
      prompts: f.host.fake.prompts.length,
      writes,
    }),
  );
  yield* f.task.halt();
  let refused = false;
  try {
    yield* requestAttachment(f.path, { method: "status" });
  } catch {
    refused = true;
  }
  expect(refused).toBe(true);
}

const REPOSITORY_SUITE = "joined entry repository-owner witness";
const REPOSITORY_TEST =
  "E1/E2/E5: a later connection explains a fatal checkout refusal without replay or a fabricated Close";

function* delegatedRepositoryWitness() {
  const stdout = new TextDecoder();
  const stderr = new TextDecoder();
  let output = "";
  let errors = "";
  const began = Date.now();
  try {
    const result = yield* deadline(
      scoped(function* () {
        yield* Stdio.around({
          *stdout([bytes]) {
            output += stdout.decode(bytes, { stream: true });
          },
          *stderr([bytes]) {
            errors += stderr.decode(bytes, { stream: true });
          },
        });
        return yield* exec("deno", {
          arguments: [
            "test",
            "--allow-all",
            "--frozen",
            "--node-modules-dir=manual",
            `--filter=${REPOSITORY_SUITE}`,
            fileURLToPath(import.meta.url),
          ],
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        }).expect();
      }),
      240000,
    );
    expect(result.code).toBe(0);
    expect(result.signal).toBeFalsy();
    const lines = stripVTControlCharacters(output).replace(/\r\n?/g, "\n").trimEnd().split("\n");
    expect(lines.filter((line) => /^running 1 test from .+$/.test(line))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith(`${REPOSITORY_SUITE} ... ok `))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith(`  ${REPOSITORY_TEST} ... ok `))).toHaveLength(1);
    expect(lines.at(-1)).toMatch(
      /^ok \| 1 passed \(1 step\) \| 0 failed(?: \| \d+ filtered out)? \([^\n)]+\)$/,
    );
    console.log(
      JSON.stringify({
        witness: "joined Deno child",
        elapsedMs: Date.now() - began,
        code: result.code,
        summary: lines.at(-1),
      }),
    );
  } finally {
    output += stdout.decode();
    errors += stderr.decode();
    console.log(`REPOSITORY_CHILD_STDOUT_BEGIN\n${output}\nREPOSITORY_CHILD_STDOUT_END`);
    console.error(`REPOSITORY_CHILD_STDERR_BEGIN\n${errors}\nREPOSITORY_CHILD_STDERR_END`);
  }
}

describe(REPOSITORY_SUITE, () => {
  it(REPOSITORY_TEST, function* () {
    if (cliRuntime() === "deno") {
      // E3's real subdirectory control and the fatal witness own separate roots.
      yield* scoped(repositorySubdirectoryControl);
      console.log("E3 repository fixture teardown joined.");
      yield* scoped(repositoryOwnerWitness);
    } else {
      yield* delegatedRepositoryWitness();
    }
  });
});

describe("joined entry diagnostics", () => {
  it("E3/E4/E5: exact earlier outcomes coexist with a live idle entry and joined Stop cleanup", function* () {
    const cleanup = gate();
    yield* ensure(cleanup.release);
    let hold = false;
    yield* ReplEntryHost.set(function* () {
      const active = hold;
      return {
        *install() {
          if (active) {
            yield* ensure(function* () {
              cleanup.enter();
              yield* cleanup.wait;
            });
          }
        },
      };
    });
    const f = yield* fixture();
    const sources = [
      checkout(f.A),
      "A completed native entry.",
      `${checkout(f.A)}<If condition={checked.head !== "0000000000000000000000000000000000000000"}><Fail message="deliberate revision mismatch" /></If>`,
    ];
    for (const [index, source] of sources.entries()) {
      const call = yield* submit(f, source);
      yield* deadline(call.task);
      const observed = yield* deadline(settled(f, index + 1));
      if (observed.outcome !== (index === 2 ? "failed" : "completed")) {
        console.error("Unexpected native entry outcome", {
          index,
          observed,
          joined: yield* call.submission.join(),
        });
      }
      expect(observed.outcome).toBe(index === 2 ? "failed" : "completed");
      if (index === 2) {
        expect(page.parse(yield* journal(f, 3)).value).toMatchObject({
          status: "failed",
          failure: "deliberate revision mismatch",
        });
        expect(observed.error?.message).toBe("deliberate revision mismatch");
      }
    }
    const saved = yield* history(f);
    const cold = value(projectRepl(yield* readRecords(saved.path)));
    expect(
      value(yield* readEntryJournal({ entry: 1 }, { entries: cold.entries, printing: undefined }))
        .value,
    ).toMatchObject({ status: "completed", execution: unknownExecution });
    hold = true;
    const call = yield* submit(f, QUESTION);
    const changes = yield* f.root.session.elicitation.changes;
    while (f.root.session.elicitation.pending === undefined) {
      yield* changes.next();
    }
    const pending = f.root.session.elicitation.pending;
    const before = yield* history(f);
    for (let i = 0; i < 2; i += 1) {
      expect(yield* requestAttachment(f.path, { method: "status" })).toMatchObject({ busy: false });
      expect(yield* observed(f, 1)).toEqual({ joined: true, outcome: "completed", error: null });
      expect(yield* observed(f, 4)).toEqual(pendingExecution);
      expect(f.root.session.elicitation.pending).toBe(pending);
      expect(f.root.session.live).toBe(true);
    }
    expect((yield* history(f)).bytes).toBe(before.bytes);
    const stopping = yield* spawn(() => f.root.session.stopEntry(call.submission.entry));
    yield* deadline(cleanup.entered);
    expect(page.parse(yield* journal(f, 4)).value).toMatchObject({
      status: "cancelled",
      execution: pendingExecution,
    });
    expect((yield* f.root.session.submit("No successor during cleanup.")).ok).toBe(false);
    cleanup.release();
    expect((yield* deadline(stopping)).ok).toBe(true);
    expect(yield* deadline(call.task)).toBe(1);
    expect(yield* deadline(settled(f, 4))).toEqual({
      joined: true,
      outcome: "interrupted",
      error: null,
    });
    const after = yield* history(f);
    expect((yield* f.root.session.stopEntry(call.submission.entry)).ok).toBe(false);
    expect((yield* history(f)).bytes).toBe(after.bytes);
    expect(yield* repositories(f.A, f.B)).toEqual(f.baseline);
    expect(f.host.fake.prompts).toHaveLength(0);
  });

  it("E4: retained success remains success when entry-owned cleanup fails", function* () {
    let armed = false;
    const failure = new Error("Controlled owned cleanup failure.");
    yield* ReplEntryHost.set(function* () {
      const fail = armed;
      return {
        *install() {
          if (fail) {
            yield* ensure(() => {
              throw failure;
            });
          }
        },
      };
    });
    const f = yield* fixture();
    armed = true;
    const call = yield* submit(f, "A successful body.");
    const joined = yield* deadline(call.submission.join());
    expect(joined).toEqual(Err(failure));
    yield* deadline(call.task);
    expect(yield* deadline(settled(f, 1))).toEqual({
      joined: true,
      outcome: "failed",
      error: withheld,
    });
    expect(page.parse(yield* journal(f, 1)).value).toMatchObject({
      status: "completed",
      failure: null,
    });
  });

  it("E6: both Journal consumers query the same detached complete data before Unicode paging", function* () {
    const message = "permitted 😀 diagnostic\n".repeat(400);
    yield* registerComponents([
      {
        name: "LongDiagnostic",
        origin: "test://long-diagnostic",
        props: { type: "object" },
        *fn(): Operation<string> {
          throw new Error(message);
        },
      },
    ]);
    const f = yield* fixture();
    const call = yield* submit(f, "<LongDiagnostic />");
    expect(yield* deadline(call.task)).toBe(1);
    yield* deadline(settled(f, 1));
    const selected = page.parse(yield* journal(f, 1, ".execution"));
    const response = yield* control(f.root, '<REPL.Entry.Journal entry={1} yq=".execution" />');
    expect(response.observations).toEqual([selected]);
    const keys = page.parse(yield* journal(f, 1, "keys"));
    expect(z.array(z.string()).parse(keys.value).sort()).toEqual([
      "entry",
      "execution",
      "failure",
      "prompts",
      "records",
      "status",
    ]);
    const whole = value(yield* f.root.reads.inspectJournal({ entry: 1, yq: ".execution" }));
    const detached = execution.parse(whole.value);
    expect(Object.keys(detached).sort()).toEqual(["error", "joined", "outcome"]);
    expect(Object.keys(detached.error ?? {}).sort()).toEqual(["message", "name"]);
    if (isJsonObject(whole.value) && isJsonObject(whole.value.error)) {
      whole.value.error.message = "edited by reader";
    }
    expect(yield* journal(f, 1, ".execution")).toEqual(selected);
    let query: string | null = ".execution.error.message";
    let restored = "";
    let pages = 0;
    while (query !== null) {
      const result = page.parse(yield* journal(f, 1, query));
      const viaControl = yield* control(
        f.root,
        `<REPL.Entry.Journal entry={1} yq={${JSON.stringify(query)}} />`,
      );
      expect(viaControl.observations).toEqual([result]);
      const text = z.string().parse(result.value);
      expect([...text].length).toBeLessThanOrEqual(4096);
      restored += text;
      query = result.next;
      pages += 1;
    }
    expect(pages).toBeGreaterThan(1);
    expect(restored).toBe(message);
    expect(f.host.fake.prompts).toHaveLength(0);
  });

  it("E8: Guide.Recovery teaches the supported disposition through the real normalized control", function* () {
    const f = yield* fixture();
    const rendered = yield* control(
      f.root,
      '<Guide.Recovery as="guide" /><Output>{guide}</Output>',
    );
    const text = rendered.response.output;
    expect(text).toContain("<REPL.Entry.Source entry={2} />");
    expect(text).toContain('outcome: "failed"');
    expect(text).toContain("Entry Stop refuses because no task remains");
    expect(text).toContain("unfinished segment permits");
    expect(text).toContain("it can run unrecorded work");
    expect(text).toContain("Passive Sidekick conversation reconstruction sends no turn");
    expect(text).toContain("all three execution members are");
    expect(text).toContain("Do not blindly resend or reopen");
    expect(f.host.fake.prompts).toHaveLength(0);
    console.log("RECOVERY_GUIDE_RENDER_BEGIN\n" + text + "\nRECOVERY_GUIDE_RENDER_END");
  });

  for (const composed of [false, true]) {
    it(`E7: protected backend diagnostics cross original disclosure with contextual composition=${composed}`, function* () {
      const secret = "249731";
      const failure = new StaleInputError(`Backend rejected ${secret}; contact support.`);
      failure.name = "BackendFailure";
      let replacements = 0;
      let transforms = 0;
      yield* Elicitation.around({
        *elicit() {
          return { code: secret };
        },
      });
      yield* useSecretScannerFactory(() => ({
        *scan() {
          return [];
        },
      }));
      if (composed) {
        yield* Execution.around(
          {
            *disclose() {
              replacements += 1;
              return Ok({ name: "SupportFailure", message: `Replacement for ${secret}` });
            },
          },
          { at: "min" },
        );
        yield* Execution.around({
          *disclose([data], next) {
            const proposed = yield* next(data);
            if (!proposed.ok) {
              return proposed;
            }
            transforms += 1;
            return Ok({
              ...proposed.value,
              message: `${proposed.value.message}; outer support advice.`,
            });
          },
        });
      }
      yield* registerComponents([
        {
          name: "CrashAfterSecret",
          origin: "test://protected-diagnostic",
          props: { type: "object" },
          *fn(): Operation<string> {
            throw failure;
          },
        },
      ]);
      const f = yield* fixture();
      const source =
        '<Elicit as="answer" schema={{type:"object",properties:{code:{type:"string",writeOnly:true}},required:["code"],additionalProperties:false}}>Code?</Elicit><CrashAfterSecret />';
      const call = yield* submit(f, source);
      const joined = yield* deadline(call.submission.join());
      expect(joined.ok).toBe(false);
      if (!joined.ok) {
        expect(joined.error).toBe(failure);
      }
      expect(failure.message).toBe(`Backend rejected ${secret}; contact support.`);
      yield* deadline(call.task);
      const expected = composed
        ? { name: "SupportFailure", message: "Replacement for [redacted]; outer support advice." }
        : { name: "BackendFailure", message: "Backend rejected [redacted]; contact support." };
      expect(yield* deadline(settled(f, 1))).toEqual({
        joined: true,
        outcome: "failed",
        error: expected,
      });
      const whole = page.parse(yield* journal(f, 1));
      const selected = page.parse(yield* journal(f, 1, ".execution.error"));
      expect(whole.value).toMatchObject({ status: "unfinished", failure: null });
      expect(selected.value).toEqual(expected);
      expect((yield* control(f.root, "<REPL.Entry.Journal entry={1} />")).observations).toEqual([
        whole,
      ]);
      expect(
        (yield* control(f.root, '<REPL.Entry.Journal entry={1} yq=".execution.error" />'))
          .observations,
      ).toEqual([selected]);
      expect(JSON.stringify(whole.value)).not.toContain(secret);
      expect(JSON.stringify(selected.value)).not.toContain(secret);
      expect((yield* history(f)).bytes).not.toContain(secret);
      expect(f.root.session.model.entries[0]?.terminal).toBeUndefined();
      expect(f.host.fake.prompts).toHaveLength(0);
      if (composed) {
        expect(replacements).toBeGreaterThan(0);
        expect(transforms).toBe(replacements);
      }
    });
  }

  for (const mode of ["permitted", "secret", "scanner-failure"]) {
    it(`E7: original entry disclosure is ${mode} despite a later permissive reader`, function* () {
      let armed = false;
      let scans = 0;
      const secret = "identified-diagnostic-secret";
      const failure =
        mode === "permitted"
          ? new Error("Useful ordinary diagnostic.")
          : new StaleInputError(secret);
      failure.name = "ControlledFailure";
      yield* useSecretScannerFactory(() => ({
        *scan(content): Operation<SecretFinding[]> {
          if (armed && content.includes(secret)) {
            scans += 1;
            if (mode === "scanner-failure") {
              throw new Error("Scanner unavailable.");
            }
            return [
              {
                ruleId: "controlled",
                messageId: "identified secret",
                location: { line: 1, column: 1 },
                fingerprint: "controlled",
              },
            ];
          }
          return [];
        },
      }));
      yield* registerComponents([
        {
          name: "DiagnosticFailure",
          origin: "test://diagnostic",
          props: { type: "object" },
          fn: function* (): Operation<string> {
            throw failure;
          },
        },
      ]);
      const f = yield* fixture();
      armed = true;
      const call = yield* submit(f, "<DiagnosticFailure />");
      const joined = yield* deadline(call.submission.join());
      expect(joined.ok).toBe(false);
      if (!joined.ok) {
        expect(joined.error).toBe(failure);
      }
      yield* deadline(call.task);
      // This policy applies only to later executions, never to the saved observation.
      yield* useSecretScannerFactory(() => ({
        *scan() {
          return [];
        },
      }));
      const actual = yield* deadline(settled(f, 1));
      expect(actual).toEqual({
        joined: true,
        outcome: "failed",
        error: mode === "permitted" ? { name: failure.name, message: failure.message } : withheld,
      });
      const whole = page.parse(yield* journal(f, 1));
      const selected = page.parse(yield* journal(f, 1, ".execution.error"));
      expect(selected.value).toEqual(actual.error);
      expect(
        (yield* control(f.root, '<REPL.Entry.Journal entry={1} yq=".execution.error" />'))
          .observations,
      ).toEqual([selected]);
      if (mode !== "permitted") {
        expect(JSON.stringify(whole.value)).not.toContain(secret);
        expect(JSON.stringify(selected.value)).not.toContain(secret);
        expect(scans).toBeGreaterThan(0);
      }
      expect(f.host.fake.prompts).toHaveLength(0);
    });
  }
});
