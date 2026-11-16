import { Writable } from "node:stream";
import { mkdtemp, chmod, realpath } from "node:fs/promises";
import { cliBase } from "@executablemd/test-support/launch";
import { fileURLToPath } from "node:url";
/**
 * Tier AE — embedded adapters on the run and plan paths
 * (specs/acp-client-spec.md §Command-line configuration, §The `xmd plan`
 * Plan writer profile).
 *
 * What a provider was built from is not observable through a provider: an agent
 * command reaches the disk only when something spawns it, and a case that
 * watched a turn fail would be reading whichever Codex or Claude the machine
 * running the suite happens to have. So these read the dependencies each path
 * hands `createAcpxProvider`, which is the decision this host makes and the one
 * that was missing (#672).
 *
 * Nothing here materializes anything. Every root is a temporary path, and the
 * resolutions asked for are settled by the bytes this build carries.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exists, readdir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, exec, useQuietProcessOutput } from "@executablemd/runtime";
import { createEmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import type { EmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import { useScope, scoped, ensure, lift, until } from "effection";
import type { Operation } from "effection";

import {
  DEFAULT_ADAPTER_ROOT,
  hostAcpDependencies,
  resolveAgentStack,
} from "../src/agent-stack.ts";
import type { AgentStack } from "../src/agent-stack.ts";
import { planWriterDependencies } from "../src/plan-writer-profile.ts";
import type { PlanWriterProviderInputs } from "../src/plan-writer-profile.ts";
import { runPlan } from "../src/plan.ts";
import { AGENT, createPlanHarness, useWorkingDirectory } from "./support/plan-harness.ts";
import { ASSEMBLY_PROFILES, ASSEMBLY_SOURCE } from "./support/assembly-profiles.ts";
import {
  checkSubprocessJournals,
  parseSubprocessJournal,
  readSubprocessSnapshot,
} from "../../test-support/subprocess-journal.ts";
import type { SubprocessJournal } from "../../test-support/subprocess-journal.ts";

/** The two agents this build carries a patched snapshot for. */
const EMBEDDED = ["codex", "claude"] as const;

/** A root under this machine's temporary tree, never written to. */
function adapterRoot(): string {
  return join(tmpdir(), `xmd-adapters-${randomUUID()}`);
}

function stackWith(adapters: EmbeddedAdapters): AgentStack {
  return { provider: "acpx", defaultAgent: "codex", permissionMode: "deny-all", adapters };
}

/** A Plan the profile's validator accepts and the command writes out. */
const PLAN = ["# Writes a file", "", '<File path="drafted.txt">the draft ran</File>', ""].join(
  "\n",
);

const REQUEST = "write a greeting";

/**
 * Adapters that carry the scripted agent and install it the way the real ones
 * do: by running a command.
 *
 * The bytes are not the point — the capability is. A real snapshot install runs
 * `npm install` in a private directory, and this stands in for it so a case can
 * observe which scope that command was reached from.
 */
function installingAdapters(prepared: string[]): EmbeddedAdapters {
  return {
    providers: [AGENT],
    identity: () => `test-embedded:${AGENT}`,
    executablePath: () => join(tmpdir(), "never-written", "index.js"),
    command: () => `${AGENT}-cmd`,
    *materialize(provider: string): Operation<void> {
      prepared.push(provider);
      yield* exec({ command: ["npm", "install"] });
    },
  };
}

/**
 * What the ceiling is built from, and nothing else.
 *
 * The Agent stack is the whole of it. Everything a Plan invocation also needs —
 * the request, the catalog, the session, who checks a draft — belongs to the
 * Component rather than to the provider this case is about, so naming it here would
 * be describing an arrangement the ceiling never reads.
 */
function dependenciesFrom(stack: AgentStack): PlanWriterProviderInputs {
  return { stack };
}

describe("Tier AE — embedded adapters on the run and plan paths", () => {
  it("AE1: the run path resolves an embedded agent to this build's own adapter", function* () {
    const root = adapterRoot();
    const adapters = createEmbeddedAdapters(root);
    const registry = hostAcpDependencies(stackWith(adapters)).agentRegistry;
    if (registry === undefined) {
      throw new Error("the run path handed its provider no agent registry");
    }

    for (const agent of EMBEDDED) {
      const command = registry.resolve(agent);
      expect(command).toBe(adapters.command(agent));
      // The failure this replaces: ACPX's own table resolves both of these to
      // an `npx` of a published adapter, pinned by the version range that build
      // recorded rather than by the snapshot this one carries.
      expect(command).not.toContain("npx");
      expect(command).toContain(root);
    }
  });

  it("AE2: an agent this build carries no snapshot for resolves as it always did", function* () {
    const root = adapterRoot();
    const registry = hostAcpDependencies(stackWith(createEmbeddedAdapters(root))).agentRegistry;
    if (registry === undefined) {
      throw new Error("the run path handed its provider no agent registry");
    }

    // An overlay, not a replacement: carrying a Codex adapter is no reason to
    // stop a run from using Gemini, and ACPX's command for it is still the one
    // this host runs.
    expect(registry.resolve("gemini")).not.toContain(root);
    expect(registry.list()).toContain("gemini");
    for (const agent of EMBEDDED) {
      expect(registry.list()).toContain(agent);
    }
  });

  it("AE3: the plan path's ceiling hands its provider the same registry", function* () {
    const root = adapterRoot();
    const adapters = createEmbeddedAdapters(root);
    const stack = stackWith(adapters);
    const ceiling = planWriterDependencies(
      dependenciesFrom(stack),
      join(root, "workdir"),
      yield* useScope(),
    );
    const registry = ceiling.agentRegistry;
    if (registry === undefined) {
      throw new Error("the plan path handed its provider no agent registry");
    }

    for (const agent of EMBEDDED) {
      expect(registry.resolve(agent)).toBe(adapters.command(agent));
      expect(registry.resolve(agent)).not.toContain("npx");
    }
    // Beside the clauses that make it a ceiling, not instead of them.
    expect(ceiling.mcpServers).toEqual([]);
    expect(ceiling.permissions).toBe("strict");
    expect(ceiling.newSessionOptions?.allowedTools).toEqual([]);
  });

  it("AE4: preparing an agent this build carries nothing for writes nothing", function* () {
    const root = adapterRoot();
    const prepare = hostAcpDependencies(stackWith(createEmbeddedAdapters(root))).prepareAgent;
    if (prepare === undefined) {
      throw new Error("the run path handed its provider no preparation");
    }

    yield* prepare("gemini");

    // Materialization is for an agent this build carries a snapshot for. Every
    // other name is already a command on this machine, and asking about one
    // creates no directory to install into.
    expect(yield* exists(root)).toBe(false);
  });

  it("AE6: the plan profile prepares its adapter through the host, not the document", function* () {
    yield* useWorkingDirectory(function* (dir, planWriterRoot) {
      // The command an install runs, answered here rather than spawned. What the
      // case is about is which capability the preparation reaches, and a real
      // `npm install` would answer that question with a subprocess.
      //
      // At `min`, so it is the weakest thing in the chain: the profile's own
      // refusal is installed at the default strength and still wins wherever it
      // applies. A recorder that outranked it would answer for the refused call
      // too, and the case would pass against the defect.
      const commands: string[][] = [];
      yield* API.Process.around(
        {
          // deno-lint-ignore require-yield
          *exec([options]) {
            commands.push([...options.command]);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
        { at: "min" },
      );

      const prepared: string[] = [];
      const harness = createPlanHarness({ planWriterRoot });
      harness.fake.script({ reply: PLAN });
      harness.script({ decision: "Approve" });

      const code = yield* runPlan(
        {
          request: REQUEST,
          include: [dir],
          output: join(dir, "plan.md"),
          verbose: false,
          stack: { ...stackWith(installingAdapters(prepared)), defaultAgent: AGENT },
        },
        harness.deps,
      );

      // The profile refuses a command to everything inside it, and putting this
      // build's adapter on disk runs one. Preparation therefore happens in the
      // scope the command was called in — the defect that made a real
      // `xmd plan` end with "asked for a command, which the Plan writer profile
      // grants to nothing" before any turn.
      // Once per agent resolution — the document resolves one several times, and
      // preparing an agent already prepared is defined to be harmless.
      expect(prepared.length).toBeGreaterThan(0);
      expect([...new Set(prepared)]).toEqual([AGENT]);
      expect(commands).toEqual(prepared.map(() => ["npm", "install"]));
      expect(code).toBe(0);
      expect(yield* exists(join(dir, "plan.md"))).toBe(true);
    });
  });

  it("AE5: a settled stack carries this host's own adapter root", function* () {
    yield* API.Env.around({
      // deno-lint-ignore require-yield
      *env(): Operation<string | undefined> {
        return undefined;
      },
    });
    const settled = yield* resolveAgentStack(
      {
        agentProvider: "acpx",
        defaultAgent: undefined,
        approveAll: false,
        approveReads: false,
        denyAll: false,
      },
      undefined,
    );
    if (!settled.ok) {
      throw settled.error;
    }

    // The resolution supplies them, so no consumer of the settled answer has a
    // registry to fall back to.
    for (const agent of EMBEDDED) {
      expect(settled.value.adapters.executablePath(agent)).toContain(DEFAULT_ADAPTER_ROOT);
    }
  });
});

const ASSEMBLY_OWNER = "packages/cli/tests/agent-adapters.test.ts";
const ASSEMBLY_SUITE = "HC host selection across command assemblies";

function checkEnvironment(environmentPreserved: unknown): void {
  expect(environmentPreserved).toBe(true);
}

function assemblyJournals(value: unknown): SubprocessJournal[] {
  return ASSEMBLY_PROFILES.map((profile, index) => ({
    source: ASSEMBLY_SOURCE,
    profile,
    snapshot: readSubprocessSnapshot(value, index),
  }));
}

function* assemblyInputs(
  agent: "claude" | "codex",
  name: string,
  verify = checkEnvironment,
  inspect?: (journals: readonly SubprocessJournal[]) => void,
  options: { oversizedPlan?: boolean; sink?: Writable } = {},
): Operation<void> {
  const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "xmd assemblies ")))));
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  const host = join(root, agent);
  const variable = agent === "codex" ? "CODEX_PATH" : "CLAUDE_CODE_EXECUTABLE";
  yield* writeTextFile(host, "#!/bin/sh\nexit 0\n");
  yield* until(chmod(host, 0o755));
  const result = yield* scoped(function* () {
    yield* useQuietProcessOutput();
    return yield* exec({
      command: [
        ...cliBase().slice(0, -1),
        fileURLToPath(new URL("./fixtures/agent-assemblies.ts", import.meta.url)),
        root,
        agent,
        "--capture-journal",
        ...(options.oversizedPlan ? ["--oversized-plan"] : []),
      ],
      env: { [variable]: host },
    });
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr);
  }
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    throw new Error("the assembly fixture result is invalid JSON");
  }
  const { results: rows, environmentPreserved, journals: rawJournals } = output;
  const journals = assemblyJournals(rawJournals);
  yield* checkSubprocessJournals(
    { owner: ASSEMBLY_OWNER, suite: ASSEMBLY_SUITE, name },
    journals,
    lift(() => {
      inspect?.(journals);
      verify(environmentPreserved);
      expect(rows.map((row: { profile: string }) => row.profile)).toEqual(ASSEMBLY_PROFILES);
      for (const row of rows) {
        expect(row.inputs).toHaveLength(2);
        for (const input of row.inputs) {
          if (["custom", "other"].includes(row.profile)) {
            expect(input.environment).toBeUndefined();
          } else {
            expect(input.environment).toEqual({ [variable]: host });
            expect(input.command).toContain(root);
            expect(input.command).not.toContain("npx");
          }
        }
      }
    }),
    options.sink,
  );
}

describe(ASSEMBLY_SUITE, () => {
  const claude =
    "HC3/HC4: run, Plan and REPL deliver the host selection to probe and live runtimes";
  const codex =
    "H3: run, Plan and REPL deliver the host Codex selection to probe and live runtimes";
  it(claude, () => assemblyInputs("claude", claude));
  it(codex, () => assemblyInputs("codex", codex));

  for (const oversizedPlan of [false, true]) {
    const witness = oversizedPlan
      ? "keeps sibling journals when one joined assembly profile exceeds its budget"
      : "attributes each assembly profile when the joined parent assertion fails";
    it(witness, function* () {
      const messages: string[] = [];
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          messages.push(String(chunk));
          callback();
        },
      });
      const root = yield* useTempDirectory("xmd-assembly-journals-");
      function run(
        artifacts: string,
        verify: typeof checkEnvironment,
        inspect?: Parameters<typeof assemblyInputs>[3],
      ) {
        return scoped(function* () {
          yield* API.Env.around({
            *env([name], next) {
              return name === "XMD_TEST_ARTIFACTS" ? artifacts : yield* next(name);
            },
          });
          yield* assemblyInputs("claude", witness, verify, inspect, { oversizedPlan, sink });
        });
      }

      const passed = join(root, "passed", ".xmd", "test-artifacts");
      yield* run(passed, checkEnvironment, (journals) => {
        expect(journals).toHaveLength(ASSEMBLY_PROFILES.length);
      });
      expect(yield* exists(passed)).toBe(false);
      expect(messages).toEqual([]);

      const failed = join(root, "failed", ".xmd", "test-artifacts");
      let assertion: unknown;
      let caught: unknown;
      let received: readonly SubprocessJournal[] = [];
      try {
        yield* run(
          failed,
          (value) => {
            checkEnvironment(value);
            try {
              checkEnvironment(false);
            } catch (error) {
              assertion = error;
              throw error;
            }
          },
          (journals) => {
            received = journals;
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(assertion).toBeInstanceOf(Error);
      expect(caught).toBe(assertion);
      expect(received).toHaveLength(ASSEMBLY_PROFILES.length);
      const invocations = yield* readdir(failed);
      expect(invocations).toHaveLength(1);
      const directory = join(failed, invocations[0]);
      const saved = received.flatMap(({ profile, snapshot }, index) =>
        typeof snapshot === "string" ? [] : [{ profile, events: snapshot, ordinal: index + 1 }],
      );
      expect(saved.map(({ profile }) => profile)).toEqual(
        ASSEMBLY_PROFILES.filter((profile) => !oversizedPlan || profile !== "plan"),
      );
      const omissions = messages.filter((message) => message.includes("journal not saved"));
      expect(omissions).toEqual(
        oversizedPlan
          ? [
              "[xmd test] journal not saved for child 2 assembly.md (plan): snapshot exceeds journal budget\n",
            ]
          : [],
      );
      const expectedFiles = saved.flatMap(({ ordinal }) => [
        `child-${ordinal}.case.json`,
        `child-${ordinal}.jsonl`,
      ]);
      expect((yield* readdir(directory)).sort()).toEqual(expectedFiles.sort());
      for (const journal of saved) {
        const { ordinal, profile } = journal;
        const stem = join(directory, `child-${ordinal}`);
        expect(JSON.parse(yield* readTextFile(`${stem}.case.json`))).toEqual({
          owner: ASSEMBLY_OWNER,
          suite: ASSEMBLY_SUITE,
          name: witness,
          kind: "child",
          ordinal,
          source: ASSEMBLY_SOURCE,
          profile,
        });
        const events = parseSubprocessJournal(
          (yield* readTextFile(`${stem}.jsonl`)).trimEnd().split("\n"),
        );
        expect(events).toEqual(journal.events);
        expect(events.at(-1)).toMatchObject({ type: "close", coroutineId: "root" });
      }
    });
  }
});
