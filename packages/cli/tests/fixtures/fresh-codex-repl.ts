import { exists, ensureDir, readTextFile, readdir, rm, writeTextFile } from "@effectionx/fs";
import { createEmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import { Component } from "@executablemd/core/api";
import { parseDurableEvent } from "@executablemd/durable-streams";
import { GitQuery } from "@executablemd/git/api";
import { useDenoComponentModuleLoader } from "@executablemd/core/host/deno";
import { Permissions, realpath } from "@executablemd/runtime";
import { expect } from "@executablemd/test-support/expect";
import { ensure, main, race, scoped, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveAgentStack } from "../../src/agent-stack.ts";
import { denoReplEntry } from "../../src/deno-repositories.ts";
import { installPlugins } from "../../src/plugin-host.ts";
import { assembleReplProfile } from "../../src/repl-profile.ts";
import { initialState } from "../../src/repl/application.ts";
import { encodeLocation } from "../../src/repl/route.ts";
import { useReplLiveScreen } from "../../src/repl/live-screen.ts";
import { runReplProgram } from "../../src/repl/program.ts";
import type { HeadlessReplRoot } from "../../src/repl/program.ts";
import { BUNDLED_PLUGIN } from "../../src/run-profile.ts";
import { useMachineSessions } from "../../src/session-coordinator.ts";
import { usePosixSidekickTransport } from "../../src/sidekick-acp/posix.ts";
import { runGit } from "../support/fixture-git.ts";
import { useMountedHost } from "../support/mounted-repl.ts";

const root = z.string().min(1).parse(process.argv[2]);
const example = fileURLToPath(
  new URL("../../../../examples/adversarial-implementation/", import.meta.url),
);
const repository = join(root, "repository");
const evidence = join(repository, "accepted.md");

function value<T>(result: Result<T>): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

const eventSchema = z.object({
  launch: z.string(),
  event: z.string().optional(),
  method: z.string().optional(),
  home: z.string().optional(),
  path: z.string().optional(),
  authenticated: z.boolean().optional(),
  params: z.unknown().optional(),
});

function* events() {
  const log = yield* readTextFile(join(root, "app-server.jsonl"));
  return log
    .trim()
    .split("\n")
    .map((line) => eventSchema.parse(JSON.parse(line)));
}

type ReplRoot = Parameters<HeadlessReplRoot["ready"]>[0];

function* within<T>(operation: Operation<T>): Operation<T> {
  return yield* race([
    operation,
    (function* () {
      yield* sleep(30000);
      throw new Error("The unfinished launch did not reach its expected boundary.");
    })(),
  ]);
}

function withRepl<T>(body: (root: ReplRoot) => Operation<T>, location?: string) {
  return scoped(function* () {
    const host = yield* useMountedHost({
      projectCwd: repository,
      dataRoot: join(root, "repl"),
      entryInstallation: denoReplEntry(
        { runtime: "source", platform: "unix", execPath: process.execPath },
        join(root, "managed"),
      ),
    });
    yield* Permissions.around({
      files: ([operation], next) => operation === "absolute" || next(operation),
    });
    yield* usePosixSidekickTransport(process.platform);
    const stack = value(
      yield* resolveAgentStack(
        {
          agentProvider: "acpx",
          defaultAgent: "codex",
          approveAll: false,
          approveReads: false,
          denyAll: false,
        },
        useMachineSessions(),
      ),
    );
    const plugins = yield* installPlugins([BUNDLED_PLUGIN], { command: "repl", args: [] });
    const view = yield* useReplLiveScreen();
    const ready = withResolvers<Parameters<HeadlessReplRoot["ready"]>[0]>();
    const task = yield* spawn(function* () {
      const profile = yield* assembleReplProfile(
        { ...stack, adapters: createEmbeddedAdapters(join(root, "adapters")) },
        plugins,
        { includes: [join(example, "components")] },
      );
      value(
        yield* runReplProgram({
          profile,
          root: host.root,
          location,
          headless: {
            view,
            *ready(opened) {
              ready.resolve(opened);
            },
          },
        }),
      );
    });
    yield* ensure(() => task.halt());
    return yield* body(yield* within(ready.operation));
  });
}

function* entryJournal(workspace: string) {
  const text = yield* readTextFile(join(workspace, "entries.jsonl"));
  const journal = text
    .trimEnd()
    .split("\n")
    .map((line) => value(parseDurableEvent(line)));
  const start = journal.findLastIndex(
    (event) =>
      event.type === "yield" &&
      event.coroutineId === "root" &&
      event.description.name === "__root__",
  );
  expect(start).toBeGreaterThanOrEqual(0);
  return journal.slice(start);
}

function* verdicts(workspace: string, settled: boolean) {
  const journal = yield* entryJournal(workspace);
  expect(journal.some((event) => event.type === "close" && event.coroutineId === "root")).toBe(
    settled,
  );
  expect(
    journal.flatMap((event) =>
      event.type === "yield" &&
      ["entry-checkout-verdict", "entry-codex-verdict"].includes(event.description.name)
        ? [[event.description.name, event.result]]
        : [],
    ),
  ).toEqual([
    ["entry-checkout-verdict", { status: "ok", value: null }],
    ["entry-codex-verdict", { status: "ok", value: true }],
  ]);
}

function* noManagedOutput(directory: string) {
  expect(yield* exists(directory)).toBe(false);
  expect(yield* exists(directory + ".inputs")).toBe(false);
}

main(function* () {
  yield* useDenoComponentModuleLoader();
  yield* ensureDir(join(repository, ".agents"));
  yield* writeTextFile(join(repository, "AGENTS.md"), "Follow the accepted fixture assignment.");
  for (const file of ["planner.md", "implementor.md"]) {
    yield* writeTextFile(join(repository, ".agents", file), "Follow the accepted assignment.");
  }
  yield* writeTextFile(evidence, "Accepted scope and focused checks.");
  yield* runGit(repository, ["init", "-b", "main"]);
  yield* runGit(repository, ["add", "."]);
  yield* runGit(repository, ["commit", "-m", "fixture"]);
  const revision = yield* runGit(repository, ["rev-parse", "HEAD"]);
  const assessment = {
    mechanical: false,
    architecture: false,
    acceptance: true,
    risk: null,
    reason: "Inspect the accepted behavior.",
    evidence: [evidence],
  };
  const work = "fresh-codex-repl";
  yield* writeTextFile(
    join(root, "role-reply.json"),
    JSON.stringify({
      schema: "phase-result.v2",
      phase: "discovery",
      work,
      outcome: "needs_decision",
      revision,
      summary: "A material choice needs a recorded decision before planning completes.",
      handoff: "ROOT: record the accepted design decision.",
      artifacts: [],
      evidence: [],
      findings: [],
      assessment,
      next: { phase: "hold", role: null },
      discoveryRequests: [],
      discoveryGaps: [],
    }),
  );
  const marker = join(root, "home", "fixture-auth");
  const paused = withResolvers<void>();
  let checkoutReads = 0;
  let documentsVisits = 0;
  let roleVisits = 0;
  yield* GitQuery.around({
    *root(_, next) {
      checkoutReads += 1;
      return yield* next();
    },
  });
  const initial = yield* scoped(function* () {
    yield* Component.around({
      *expand([request], next) {
        const { name, position } = request.expansion;
        if (
          name === "Ticket.Documents" &&
          position?.path === join(example, "components/Entry/Run.md")
        ) {
          documentsVisits += 1;
          paused.resolve();
          yield* suspend();
        }
        return yield* next(request);
      },
    });
    return yield* firstLaunch();
  });
  yield* noManagedOutput(initial.directory);
  const frontier = yield* events();
  expect(frontier.slice(0, initial.log.length)).toEqual(initial.log);
  expect(
    frontier.slice(initial.log.length).every(({ event }) => event === "eof" || event === "exit"),
  ).toBe(true);
  yield* rm(marker);

  yield* scoped(function* () {
    function* beforeRole() {
      expect(yield* exists(marker)).toBe(false);
      expect(checkoutReads).toBe(initial.checkoutReads);
      expect(yield* events()).toEqual(frontier);
    }
    yield* Component.around({
      *expand([request], next) {
        const { name, position } = request.expansion;
        if (
          name === "Ticket.Documents" &&
          position?.path === join(example, "components/Entry/Run.md")
        ) {
          documentsVisits += 1;
          yield* beforeRole();
          yield* noManagedOutput(initial.directory);
        }
        if (name === "Phase.Role" && position?.path === join(example, "components/Phase/Run.md")) {
          roleVisits += 1;
          yield* beforeRole();
          yield* writeTextFile(marker, "present");
        }
        return yield* next(request);
      },
    });
    yield* withRepl(
      function* (reopened) {
        expect(reopened.execution).toBe(initial.execution);
        value(yield* within(reopened.session.join()));
        const entries = reopened.session.model.entries;
        expect(entries.map(({ key }) => key)).toEqual(initial.entries);
        const terminal = entries.at(-1)?.terminal;
        expect(terminal?.status).toBe("ok");
        expect(JSON.parse(terminal?.output ?? "")).toMatchObject({
          status: "hold",
          publication: "confirmed",
        });
        yield* verdicts(reopened.workspace, true);
        expect(documentsVisits).toBe(2);
        expect(roleVisits).toBe(1);
        expect(checkoutReads).toBe(initial.checkoutReads);

        const logged = yield* events();
        const resumed = logged.slice(frontier.length);
        const threads = resumed.filter(({ method }) => method === "thread/start");
        const turns = resumed.filter(({ method }) => method === "turn/start");
        expect(threads).toHaveLength(1);
        expect(turns).toHaveLength(1);
        const [role] = threads;
        expect(role.launch).not.toBe(initial.inspection);
        expect(turns[0].launch).toBe(role.launch);
        expect(turns[0].params).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
        expect(
          resumed.find(({ event, launch }) => event === "auth" && launch === role.launch),
        ).toMatchObject({ authenticated: true });
        const launched = resumed.find(
          ({ event, launch }) => event === "launch" && launch === role.launch,
        );
        expect(launched).toMatchObject({ home: process.env.HOME, path: process.env.PATH });
        const inspectionClosed = logged.findIndex(
          ({ event, launch }) =>
            launch === initial.inspection && (event === "eof" || event === "exit"),
        );
        expect(inspectionClosed).toBeGreaterThan(
          logged.findIndex(
            ({ event, launch }) => event === "launch" && launch === initial.inspection,
          ),
        );
        expect(logged.findIndex((event) => event === launched)).toBeGreaterThan(inspectionClosed);
        expect(yield* readdir(join(initial.directory, "calls"))).toEqual(["0000"]);
        const result = yield* readTextFile(
          join(initial.directory, "attempts", "0000", "result.json"),
        );
        expect(JSON.parse(result)).toMatchObject({
          phase: "discovery",
          outcome: "needs_decision",
          revision,
          handoff: "ROOT: record the accepted design decision.",
        });
      },
      encodeLocation(initialState(initial.execution).route),
    );
  });

  const legacyPaused = withResolvers<void>();
  const legacyBefore = yield* events();
  const legacy = yield* scoped(function* () {
    yield* Component.around({
      *expand([request], next) {
        if (request.expansion.name === "Entry.CodexAdmission") {
          legacyPaused.resolve();
          yield* suspend();
        }
        return yield* next(request);
      },
    });
    return yield* withRepl(function* (repl) {
      const source = `\`\`\`bash exec as="legacyPrefix"\nprintf "%s" legacy\n\`\`\`
<Entry.CodexAdmission repository={${JSON.stringify(repository)}} model="gpt-6.1-sol" effort="medium" as="legacyVerdict" />
<Output><Json value={legacyVerdict} /></Output>`;
      const submitted = value(yield* repl.session.submit(source));
      yield* within(legacyPaused.operation);
      expect(repl.session.model.entries.at(-1)).toMatchObject({
        key: submitted.entry,
        settled: false,
      });
      const journal = yield* entryJournal(repl.workspace);
      expect(
        journal.some(
          (event) => event.type === "yield" && event.description.name === "Entry.CodexAdmission",
        ),
      ).toBe(false);
      expect(yield* events()).toEqual(legacyBefore);
      return { execution: repl.execution, entry: submitted.entry };
    });
  });
  yield* withRepl(
    function* (reopened) {
      expect(reopened.execution).toBe(legacy.execution);
      value(yield* within(reopened.session.join()));
      expect(reopened.session.model.entries.at(-1)).toMatchObject({
        key: legacy.entry,
        terminal: { status: "ok", output: "true" },
      });
      const journal = yield* entryJournal(reopened.workspace);
      const retained = journal.filter((event) => event.type === "yield");
      const imported = retained.findIndex(
        ({ description }) =>
          description.type === "import_component" && description.name === "Entry.CodexAdmission",
      );
      expect(imported).toBeGreaterThanOrEqual(0);
      expect(retained[imported + 1]).toMatchObject({
        description: { type: "delivery_review_observation", name: "entry-codex-verdict" },
        result: { status: "ok", value: true },
      });
      const resumed = (yield* events()).slice(legacyBefore.length);
      expect(resumed.filter(({ method }) => method === "thread/start")).toHaveLength(1);
      expect(resumed.filter(({ method }) => method === "turn/start")).toEqual([]);
    },
    encodeLocation(initialState(legacy.execution).route),
  );

  function* firstLaunch() {
    return yield* withRepl(function* (repl) {
      // The REPL permits its session components directory outside the source checkout.
      const components = yield* realpath(join(repl.workspace, "components"));
      if (components === undefined) {
        throw new Error("The REPL did not prepare its session components directory.");
      }
      const directory = join(components, "work");
      const task = join(root, "task.json");
      yield* writeTextFile(
        task,
        JSON.stringify({
          work,
          repository,
          directory,
          revision,
          request: "Plan the accepted scope.",
          inputs: [evidence],
          sessions: {
            planner: "fixture-planner",
            implementor: "fixture-implementor",
            architect: "fixture-architect",
          },
          providers: { architect: "codex", planner: "codex", implementor: "codex" },
          maxCorrections: 3,
          maxApiRepairs: 3,
          maxResponseCorrections: 0,
          assessment,
          scope: {
            decisions: { evidence: [evidence], openQuestions: [] },
            implementation: { ready: false, evidence: [evidence] },
            sharedApi: { needed: false, evidence: [evidence] },
            migration: null,
          },
          delivery: {
            repository: "taras/executable.md",
            reviewer: {
              provider: "claude",
              model: "fixture",
              effort: null,
              session: "fixture-review",
            },
            acceptance: [
              { id: "accepted", source: evidence, requirement: "Preserve accepted scope." },
            ],
          },
        }),
      );
      const entry = `<Entry.Run task={${JSON.stringify(task)}} as="launch" /><Output><Json value={launch} /></Output>`;
      const first = value(yield* repl.session.submit(entry));
      value(yield* first.join());
      const output = value(yield* first.output()).output;
      expect(JSON.parse(output)).toEqual({
        status: "hold",
        reason:
          "Codex could not verify model gpt-6.1-sol with effort medium. Correct the Codex profile or launch environment and explicitly submit the same fresh task again.",
        history: [],
      });
      const before = yield* events();
      expect(before.some((event) => event.method === "account/read")).toBe(true);
      expect(before.some((event) => event.authenticated === false)).toBe(true);
      expect(
        before.filter((event) => ["thread/start", "turn/start"].includes(event.method ?? "")),
      ).toEqual([]);
      yield* noManagedOutput(directory);

      yield* writeTextFile(marker, "present");
      const second = value(yield* repl.session.submit(entry));
      yield* within(paused.operation);
      expect(repl.session.model.entries.at(-1)).toMatchObject({
        key: second.entry,
        settled: false,
      });
      yield* verdicts(repl.workspace, false);
      yield* noManagedOutput(directory);

      const log = yield* events();
      const after = log.slice(before.length);
      const threads = after.filter(({ method }) => method === "thread/start");
      expect(threads).toHaveLength(1);
      expect(after.filter(({ method }) => method === "turn/start")).toEqual([]);
      const inspection = threads[0].launch;
      expect(
        after.find(({ event, launch }) => event === "auth" && launch === inspection),
      ).toMatchObject({ authenticated: true });
      const opened = after.findIndex(
        ({ event, launch }) => event === "launch" && launch === inspection,
      );
      expect(opened).toBeGreaterThanOrEqual(0);
      expect(after[opened]).toMatchObject({ home: process.env.HOME, path: process.env.PATH });
      expect(
        after.findIndex(
          ({ event, launch }) => launch === inspection && (event === "eof" || event === "exit"),
        ),
      ).toBeGreaterThan(opened);
      expect(checkoutReads).toBe(2);
      return {
        log,
        execution: repl.execution,
        entries: repl.session.model.entries.map(({ key }) => key),
        checkoutReads,
        directory,
        inspection,
      };
    });
  }
});
