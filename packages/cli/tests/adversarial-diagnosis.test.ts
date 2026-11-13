import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { useComponentModuleLoader } from "@executablemd/test-support/host";
import { scoped, spawn } from "effection";
import type { Operation } from "effection";
import { join, resolve } from "node:path";
import { ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import {
  collect,
  agentIdentityComponents,
  registerComponents,
  useNormalizedOutput,
} from "@executablemd/core";
import { API, cwd, Permissions, realpath, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import { z } from "zod";
import { createEmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import { executeInstalled } from "@executablemd/core/host";
import { installAgentProviderStack } from "../src/agent-stack.ts";
import { git, gitOutput } from "../../git/tests/support/git-remotes.ts";
import { createFakeAcp, makeStore } from "./support/fake-acp.ts";

const components = resolve("examples/adversarial-implementation/components");
interface SolverProfile {
  key: string;
  provider: string;
  models: string[];
  effort: string;
  quotaNotice?: string;
}

const specPath = "specs/test-agent-spec.md";
const specSection = [
  "## Controller and *worker*",
  "",
  "The assigned worker owns its startup.",
  "",
  "~~~md",
  "## Controller and worker",
  "~~~",
  "",
  "### Cancellation",
  "",
  "Join the worker after cancellation.",
  "",
].join("\n");

function* fixture() {
  const temp = yield* useTempDirectory("xmd-diagnosis-");
  const root = (yield* realpath(temp)) ?? temp;
  const repository = join(root, "repo");
  git(["init", repository], root, root);
  yield* writeTextFile(join(repository, "tracked"), "unchanged\n");
  yield* ensureDir(join(repository, "specs"));
  yield* writeTextFile(
    join(repository, specPath),
    "# Test Agent\n\nUnrelated preamble.\n\n" +
      specSection +
      "\n## Replay\n\nUnrelated replay section.\n",
  );
  git(["add", "tracked", specPath], repository, root);
  git(
    ["-c", "user.name=Fixture", "-c", "user.email=f@example.test", "commit", "-qm", "fixture"],
    repository,
    root,
  );
  const revision = git(["rev-parse", "HEAD"], repository, root).trim();
  const evidence = join(root, "first.log");
  yield* writeTextFile(evidence, "failure witness\n");
  const fake = createFakeAcp();
  const store = makeStore();
  let expectedRevision = revision;
  function run(
    attempt: string,
    previous?: string,
    inputPaths = [evidence],
    context: {
      spec?: string;
      failingRevision?: string;
      probes?: { command: string; setup?: string; artifacts?: string[] }[];
    } = {},
    solvers?: { primary: SolverProfile; fallback?: SolverProfile },
  ) {
    return scoped(function* () {
      yield* useHostFiles();
      yield* useComponentModuleLoader();
      yield* Permissions.around({ files: () => true });
      yield* useNormalizedOutput();
      yield* API.Process.around({
        *exec([options], next) {
          if (options.command.includes("/usr/bin/true")) {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return yield* next(options);
        },
      });
      yield* installAgentProviderStack(
        {
          provider: "acpx",
          defaultAgent: "claude",
          permissionMode: "approve-all",
          adapters: createEmbeddedAdapters(join(root, "adapters")),
        },
        {
          createRuntime: fake.create,
          sessionStore: store,
        },
      );
      const doc = join(root, "phase.md");
      const install = function* () {
        yield* registerComponents([
          {
            name: "Git.Changes",
            origin: "test://checkout",
            props: { type: "object" },
            *fn() {
              expect(yield* cwd()).toBe(repository);
              return { comparison: { base: expectedRevision }, changes: [], next: null };
            },
          },
          {
            name: "Git.File",
            origin: "test://checkout",
            props: {
              type: "object",
              properties: {
                commit: { type: "string" },
                path: { type: "string" },
                limit: { type: "number" },
              },
            },
            *fn(props) {
              expect(yield* cwd()).toBe(repository);
              const selected = z.object({ commit: z.string(), path: z.string() }).parse(props);
              expect(selected.commit).toBe(revision);
              return {
                text: gitOutput(["show", selected.commit + ":" + selected.path], repository, root),
                next: null,
              };
            },
          },
        ]);
      };
      const request = {
        role: "problem-solver",
        session: "diagnosis",
        attempt,
        ...(previous === undefined ? {} : { previous }),
        inputPaths,
        assignment: { repository, revision, work: "test", request: "Find the cause.", ...context },
      };
      const path = join(root, "request.json");
      yield* writeTextFile(path, JSON.stringify(request));
      const entry =
        solvers === undefined
          ? `<Entry.Phase request=${JSON.stringify(path)} as="result" />`
          : `<Diagnosis.Run request={${JSON.stringify(request)}} solvers={${JSON.stringify(solvers)}} as="result" />`;
      const source = entry + "<Json value={result} />";
      yield* writeTextFile(doc, source);
      const result = yield* collect(
        yield* executeInstalled(
          { path: doc, stream: new InMemoryStream(), includes: [components] },
          [{ components: agentIdentityComponents(), install }],
        ),
      );
      return z.string().parse(result);
    });
  }
  return {
    root,
    repository,
    evidence,
    revision,
    fake,
    run,
    changeRevision() {
      expectedRevision = "f".repeat(40);
    },
  };
}

function offer(fake: ReturnType<typeof createFakeAcp>, models: string[]) {
  fake.configuration({
    model: { selected: models[0]!, choices: models.map((id) => ({ id })) },
    effort: Object.fromEntries(
      models.map((model) => [model, { selected: "high", choices: [{ id: "high" }] }]),
    ),
  });
}

describe("adversarial problem-solver phase", () => {
  it("accepts one diagnosis after progress text and holds an ambiguous reply", function* () {
    const test = yield* fixture();
    offer(test.fake, ["fable", "gpt-6-astra"]);
    const result = {
      outcome: "missing_witness",
      revision: test.revision,
      witness: "Reservation result",
      howToObtain: "Capture one journal per child.",
    };
    const json = JSON.stringify(result);
    const reply = `Recording one overlap pair.\n${json}`;
    const first = join(test.root, "progress");
    test.fake.script({ reply });
    expect(JSON.parse(yield* test.run(first))).toMatchObject({ status: "missing_witness" });
    expect((yield* readTextFile(join(first, "fable/raw.txt"))).trim()).toBe(reply);
    expect(JSON.parse(yield* readTextFile(join(first, "fable/result.json"))).result).toEqual(
      result,
    );

    const second = join(test.root, "ambiguous");
    test.fake.script({ reply: `${reply}\n${json}` });
    expect(JSON.parse(yield* test.run(second))).toMatchObject({
      status: "hold",
      reason: expect.stringContaining("exactly one unambiguous JSON result"),
    });
    expect(yield* API.Fs.operations.stat(join(second, "fable/result.json"))).toMatchObject({
      exists: false,
    });
    expect(test.fake.prompts).toHaveLength(2);
  });

  it("uses supplied solver profiles for fresh runs and recorded profiles for continuations", function* () {
    const test = yield* fixture();
    const models = ["preferred-model", "advertised-model"];
    test.fake.configuration({
      model: { selected: models[1]!, choices: [{ id: models[1]! }] },
      effort: { [models[1]!]: { selected: "medium", choices: [{ id: "medium" }] } },
    });
    const profile = { key: "custom", provider: "codex", models, effort: "medium" };
    const reply = JSON.stringify({
      outcome: "missing_witness",
      revision: test.revision,
      witness: "Worker trace",
      howToObtain: "Capture it.",
    });
    const first = join(test.root, "configured");
    test.fake.script({ reply });
    expect(
      JSON.parse(yield* test.run(first, undefined, [test.evidence], {}, { primary: profile })),
    ).toMatchObject({ status: "missing_witness", attempt: join(first, "custom") });
    const original = JSON.parse(yield* readTextFile(join(first, "custom/result.json")));
    expect(original).toMatchObject({
      model: models[1],
      assignment: {
        solverKey: "custom",
        solver: { provider: "codex", model: models[0], effort: "medium" },
      },
    });
    const next = join(test.root, "continued");
    test.fake.script({ reply });
    const replacement = { ...profile, key: "new", models: ["unavailable"], effort: "high" };
    expect(
      JSON.parse(yield* test.run(next, join(first, "custom"), [], {}, { primary: replacement })),
    ).toMatchObject({ status: "missing_witness", attempt: join(next, "custom") });
    const continued = JSON.parse(yield* readTextFile(join(next, "custom/result.json")));
    expect(continued.assignment.solver).toEqual(original.assignment.solver);
    expect(continued.identity.identity).toEqual(original.identity.identity);
    expect(test.fake.prompts).toHaveLength(2);
  });

  it("uses the supplied fallback after the primary's configured quota refusal", function* () {
    const test = yield* fixture();
    offer(test.fake, ["custom-primary", "custom-fallback"]);
    const quotaNotice = "The fixture provider has reached its quota.";
    const failure = "Internal error: " + quotaNotice;
    test.fake.script({
      reply: quotaNotice,
      failure,
      failureFacts: { code: "RUNTIME", origin: "runtime", acp: { code: -32603, message: failure } },
    });
    test.fake.script({
      reply: JSON.stringify({
        outcome: "missing_witness",
        revision: test.revision,
        witness: "Worker trace",
        howToObtain: "Capture it.",
      }),
    });
    const attempt = join(test.root, "quota");
    const solvers = {
      primary: {
        key: "first",
        provider: "codex",
        models: ["custom-primary"],
        effort: "high",
        quotaNotice,
      },
      fallback: { key: "second", provider: "claude", models: ["custom-fallback"], effort: "high" },
    };
    const result = JSON.parse(yield* test.run(attempt, undefined, [test.evidence], {}, solvers));
    expect(result).toMatchObject({ status: "missing_witness", attempt: join(attempt, "second") });
    expect(JSON.parse(yield* readTextFile(result.result))).toMatchObject({
      model: "custom-fallback",
      assignment: { solver: { provider: "claude" } },
    });
    expect(test.fake.prompts).toHaveLength(2);
  });

  it("holds an unresolved spec section before dispatch", function* () {
    const test = yield* fixture();
    offer(test.fake, ["fable", "gpt-6-astra"]);
    const result = JSON.parse(
      yield* test.run(join(test.root, "missing-spec"), undefined, [test.evidence], {
        spec: specPath + "#unknown-section",
      }),
    );
    expect(result).toMatchObject({
      status: "hold",
      reason: expect.stringContaining("Select a unique spec section"),
    });
    expect(test.fake.prompts).toHaveLength(0);
  });

  it("links oversized evidence without discarding captured content", function* () {
    const test = yield* fixture();
    offer(test.fake, ["fable"]);
    const secondEvidence = join(test.root, "second.log");
    const firstText = "first witness\n" + "a".repeat(40_000);
    const secondText = "second witness\n" + "b".repeat(40_000);
    yield* writeTextFile(test.evidence, firstText);
    yield* writeTextFile(secondEvidence, secondText);
    const attempt = join(test.root, "oversized-evidence");
    const directory = join(attempt, "fable");
    test.fake.script({
      reply: JSON.stringify({
        outcome: "cause",
        revision: test.revision,
        cause: "The captured witnesses distinguish the cause.",
        evidence: [test.evidence, secondEvidence],
        regression: { command: "test case", expected: "pass", observed: "fail" },
        handoff: "Repair the case and run the regression.",
      }),
    });
    const output = JSON.parse(
      yield* test.run(attempt, undefined, [test.evidence, secondEvidence], {
        spec: specPath + "#controller-and-worker",
      }),
    );
    expect(output).toMatchObject({ status: "cause" });
    expect(test.fake.prompts).toHaveLength(1);
    const prompt = test.fake.prompts[0];
    const snapshot = join(directory, "inputs.json");
    expect(prompt).toContain("Read the captured evidence in " + snapshot);
    expect(prompt).not.toContain("first witness");
    expect(prompt).not.toContain("second witness");
    expect(prompt).toContain(specSection.trimEnd());
    expect(prompt.length).toBeLessThanOrEqual(64_000);
    expect(JSON.parse(yield* readTextFile(snapshot))).toEqual([
      { path: test.evidence, content: firstText },
      { path: secondEvidence, content: secondText },
    ]);
  });

  it("holds a reply if the submission guide changed during the turn", function* () {
    const test = yield* fixture();
    offer(test.fake, ["fable", "gpt-6-astra"]);
    const attempt = join(test.root, "changed-guide");
    const directory = join(attempt, "fable");
    test.fake.script({
      held: true,
      reply: JSON.stringify({
        outcome: "missing_witness",
        revision: test.revision,
        witness: "Worker trace",
        howToObtain: "Capture it.",
      }),
    });
    const running = yield* spawn(() => test.run(attempt));
    yield* test.fake.holdingTurns(1);
    yield* writeTextFile(join(directory, "submission-guide.md"), "Changed during the turn.");
    test.fake.releaseTurn();
    expect(JSON.parse(yield* running)).toMatchObject({
      status: "hold",
      reason: expect.stringContaining("frozen submission guide changed"),
    });
    expect(yield* readTextFile(join(directory, "raw.txt"))).toContain("missing_witness");
    expect(yield* API.Fs.operations.stat(join(directory, "result.json"))).toMatchObject({
      exists: false,
    });
    expect(test.fake.prompts).toHaveLength(1);
  });

  it("records a cause, continues its original conversation, and refuses changed identity", function* () {
    const test = yield* fixture();
    const first = join(test.root, "first");
    const context = {
      spec: "specs/test-agent-spec.md#controller-and-worker",
      failingRevision: "a".repeat(40),
      probes: [
        {
          command: "node /tmp/fixture-probe.mjs",
          setup: "/tmp/probe-setup.md",
          artifacts: ["/tmp/prior-run.log"],
        },
      ],
    };
    offer(test.fake, ["fable", "gpt-6-astra"]);
    test.fake.script({
      reply: JSON.stringify({
        outcome: "cause",
        revision: test.revision,
        cause: "The witness distinguishes this cause.",
        evidence: [test.evidence],
        regression: { command: "test case", expected: "pass", observed: "fail" },
        handoff: "Repair the case and run the regression.",
      }),
    });
    expect(JSON.parse(yield* test.run(first, undefined, [test.evidence], context))).toMatchObject({
      status: "cause",
    });
    const guidePath = join(first, "fable/submission-guide.md");
    const prompt = test.fake.prompts[0];
    expect(prompt).toContain("Owning spec section from " + context.spec);
    expect(prompt).toContain(specSection.trimEnd());
    expect(prompt).not.toContain("Unrelated preamble.");
    expect(prompt).not.toContain("Unrelated replay section.");
    expect(prompt).toContain("Failing CI revision: " + context.failingRevision);
    expect(prompt).toContain(context.probes[0].command);
    expect(prompt).toContain(context.probes[0].setup);
    expect(prompt).toContain(context.probes[0].artifacts[0]);
    expect(prompt).toContain(guidePath);
    expect(prompt).not.toContain('"oneOf"');
    expect(prompt).toContain("failure witness");
    const guide = yield* readTextFile(guidePath);
    expect(guide).toContain('"oneOf"');
    expect(guide).toContain('"howToObtain"');
    const original = JSON.parse(yield* readTextFile(join(first, "fable/result.json")));
    expect(original).toMatchObject({ model: "fable", assignment: { solver: { model: "fable" } } });
    expect(original.identity.identity).not.toBeNull();
    expect(original.assignment.assignment).toMatchObject(context);
    yield* expectRefusal(
      test.run(join(test.root, "wrong-failure"), join(first, "fable"), [test.evidence], {
        failingRevision: "b".repeat(40),
      }),
      "failing revision differs",
    );
    expect(test.fake.prompts).toHaveLength(1);

    const originalPath = join(first, "fable");
    const legacy = JSON.parse(yield* readTextFile(join(originalPath, "assignment.json")));
    delete legacy.solverKey;
    yield* writeTextFile(join(originalPath, "assignment.json"), JSON.stringify(legacy));
    yield* writeTextFile(
      join(originalPath, "result.json"),
      JSON.stringify({ ...original, assignment: legacy }),
    );

    const second = join(test.root, "second");
    const newEvidence = join(test.root, "later.log");
    yield* writeTextFile(test.evidence, "replacement on disk\n");
    yield* writeTextFile(newEvidence, "fresh witness\n");
    test.fake.script({
      reply: JSON.stringify({
        outcome: "missing_witness",
        revision: test.revision,
        witness: "Worker trace",
        howToObtain: "Capture the active operation.",
      }),
    });
    expect(
      JSON.parse(yield* test.run(second, join(first, "fable"), [test.evidence, newEvidence])),
    ).toMatchObject({
      status: "missing_witness",
    });
    const next = JSON.parse(yield* readTextFile(join(second, "fable/result.json")));
    expect(next.identity.identity).toEqual(original.identity.identity);
    expect(next.assignment.assignment).toMatchObject(context);
    expect(test.fake.prompts[1]).toContain("Failing CI revision: " + context.failingRevision);
    expect(test.fake.prompts[1]).toContain("failure witness");
    expect(test.fake.prompts[1]).toContain("fresh witness");
    expect(test.fake.prompts[1]).not.toContain("replacement on disk");

    test.fake.identity("different");
    const calls = test.fake.prompts.length;
    expect(
      JSON.parse(yield* test.run(join(test.root, "third"), join(second, "fable"))),
    ).toMatchObject({ status: "hold", reason: expect.stringContaining("identity changed") });
    expect(test.fake.prompts).toHaveLength(calls);
  });

  it("retains an interrupted continuation without prompting it twice", function* () {
    const test = yield* fixture();
    offer(test.fake, ["fable", "gpt-6-astra"]);
    const first = join(test.root, "first");
    test.fake.script({
      reply: JSON.stringify({
        outcome: "missing_witness",
        revision: test.revision,
        witness: "Worker trace",
        howToObtain: "Capture the active operation.",
      }),
    });
    expect(JSON.parse(yield* test.run(first))).toMatchObject({ status: "missing_witness" });
    const previous = join(first, "fable");
    const result = yield* readTextFile(join(previous, "result.json"));
    const relocated = join(test.repository, "prior-receipt");
    yield* ensureDir(relocated);
    for (const name of ["assignment.json", "inputs.json", "result.json"]) {
      yield* writeTextFile(join(relocated, name), yield* readTextFile(join(previous, name)));
    }
    yield* expectRefusal(test.run(join(test.root, "relocated"), relocated), "outside the checkout");
    expect(yield* API.Fs.operations.stat(join(relocated, "continuation"))).toMatchObject({
      exists: false,
    });
    const next = join(test.root, "interrupted");
    test.fake.script({ manual: true });
    const running = yield* spawn(() => test.run(next, previous));
    yield* test.fake.startedTurns(2);
    yield* running.halt();
    expect(test.fake.cancels).toBe(1);
    expect(yield* readTextFile(join(previous, "result.json"))).toBe(result);
    expect(JSON.parse(yield* readTextFile(join(next, "fable", "assignment.json")))).toMatchObject({
      previous,
    });
    yield* expectRefusal(test.run(next, previous), "already reserved");
    yield* expectRefusal(
      test.run(join(test.root, "duplicate"), previous),
      "already has a reserved continuation",
    );
    expect(JSON.parse(yield* readTextFile(join(previous, "continuation", "next.json")))).toEqual({
      attempt: next,
    });
    yield* expectRefusal(
      test.run(join(test.root, "new"), join(next, "fable")),
      "Reconcile the original diagnostic turn",
    );
    expect(test.fake.prompts).toHaveLength(2);
  });

  it("preserves a reply when the provider fails to close", function* () {
    const test = yield* fixture();
    offer(test.fake, ["fable", "gpt-6-astra"]);
    const reply = JSON.stringify({
      outcome: "missing_witness",
      revision: test.revision,
      witness: "Worker trace",
      howToObtain: "Capture it.",
    });
    test.fake.script({ reply });
    test.fake.closeFailure = new Error("the diagnostic provider would not close");
    const attempt = join(test.root, "failed-close");
    yield* expectRefusal(test.run(attempt), "agent provider teardown failed");
    expect(test.fake.prompts).toHaveLength(1);
    const raw = yield* readTextFile(join(attempt, "fable", "raw.txt"));
    expect(raw.trim()).toBe(reply);
    expect(JSON.parse(yield* readTextFile(join(attempt, "fable", "outcome.json"))).turn).toEqual({
      state: "reply",
      reply: raw,
    });
    expect(yield* API.Fs.operations.stat(join(attempt, "fable", "result.json"))).toMatchObject({
      exists: false,
    });
  });

  it("uses Astra once when Fable is absent and records its own identity", function* () {
    const test = yield* fixture();
    const attempt = join(test.root, "fallback");
    offer(test.fake, ["gpt-6-astra"]);
    test.fake.script({
      reply: JSON.stringify({
        outcome: "missing_witness",
        revision: test.revision,
        witness: "Worker trace",
        howToObtain: "Capture it.",
      }),
    });
    expect(JSON.parse(yield* test.run(attempt))).toMatchObject({ status: "missing_witness" });
    expect(JSON.parse(yield* readTextFile(join(attempt, "fable/outcome.json")))).toMatchObject({
      catalog: { state: "unavailable" },
    });
    expect(JSON.parse(yield* readTextFile(join(attempt, "astra/result.json")))).toMatchObject({
      model: "gpt-6-astra",
      assignment: {
        solver: { provider: "codex", session: expect.stringMatching(/^diagnosis-.+-astra$/) },
      },
    });
    expect(test.fake.prompts).toHaveLength(1);
    expect(test.fake.prompts[0]).toContain(join(attempt, "astra/submission-guide.md"));
    expect(
      test.fake.created.some(
        ({ agentProcessEnv }) => agentProcessEnv?.INITIAL_AGENT_MODE === "agent-full-access",
      ),
    ).toBe(true);
    expect(
      test.fake.ensured
        .map(({ agent }) => agent)
        .filter((agent) => agent !== "claude" && agent !== "codex"),
    ).toEqual([]);
    yield* expectRefusal(test.run(join(test.repository, "inside")), "outside the checkout");
    test.changeRevision();
    yield* expectRefusal(test.run(join(test.root, "stale")), "exact assigned revision");
    expect(test.fake.prompts).toHaveLength(1);
  });
});

function* expectRefusal(operation: Operation<string>, message: string) {
  try {
    yield* operation;
  } catch (error) {
    expect(String(error)).toContain(message);
    return;
  }
  throw new Error("Expected diagnosis to refuse.");
}
