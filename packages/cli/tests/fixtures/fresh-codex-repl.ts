import { exists, ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import { createEmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import { useDenoComponentModuleLoader } from "@executablemd/core/host/deno";
import { Permissions, realpath } from "@executablemd/runtime";
import { expect } from "@executablemd/test-support/expect";
import { main, spawn, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveAgentStack } from "../../src/agent-stack.ts";
import { denoReplEntry } from "../../src/deno-repositories.ts";
import { installPlugins } from "../../src/plugin-host.ts";
import { assembleReplProfile } from "../../src/repl-profile.ts";
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

function* withRepl(body: (root: Parameters<HeadlessReplRoot["ready"]>[0]) => Operation<void>) {
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
        headless: {
          view,
          *ready(root) {
            ready.resolve(root);
          },
        },
      }),
    );
  });
  try {
    yield* body(yield* ready.operation);
  } finally {
    yield* task.halt();
  }
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
  yield* withRepl(function* (repl) {
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
    expect(yield* exists(directory)).toBe(false);
    expect(yield* exists(directory + ".inputs")).toBe(false);

    yield* writeTextFile(join(root, "home", "fixture-auth"), "present");
    const second = value(yield* repl.session.submit(entry));
    value(yield* second.join());
    expect(JSON.parse(value(yield* second.output()).output)).toMatchObject({
      status: "hold",
      publication: "confirmed",
    });
    const after = (yield* events()).slice(before.length);
    const turns = after.filter((event) => event.method === "turn/start");
    if (turns.length === 0) {
      const receipt = yield* readTextFile(join(directory, "calls", "0000", "execution.json"));
      throw new Error(`The role started no turn. ${receipt}`);
    }
    const threads = after.filter((event) => event.method === "thread/start");
    expect(threads).toHaveLength(2);
    expect(turns).toHaveLength(1);
    const [inspection, role] = threads;
    expect(inspection.launch).not.toBe(role.launch);
    expect(turns[0].launch).toBe(role.launch);
    expect(turns[0].params).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
    const inspectionClosed = after.findIndex(
      (event) => event.launch === inspection.launch && ["exit", "eof"].includes(event.event ?? ""),
    );
    const roleOpened = after.findIndex(
      (event) => event.launch === role.launch && event.event === "launch",
    );
    expect(inspectionClosed).toBeGreaterThan(after.indexOf(inspection));
    expect(roleOpened).toBeGreaterThan(inspectionClosed);
    for (const launch of [inspection.launch, role.launch]) {
      expect(
        after.find((event) => event.launch === launch && event.event === "auth"),
      ).toMatchObject({ authenticated: true });
      expect(
        after.find((event) => event.launch === launch && event.event === "launch"),
      ).toMatchObject({ home: process.env.HOME, path: process.env.PATH });
    }
    expect(
      JSON.parse(yield* readTextFile(join(directory, "attempts", "0000", "result.json"))),
    ).toMatchObject({
      phase: "discovery",
      outcome: "needs_decision",
      revision,
      handoff: "ROOT: record the accepted design decision.",
    });
  });
});
