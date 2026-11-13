import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { useComponentModuleLoader } from "@executablemd/test-support/host";
import { scoped, spawn } from "effection";
import type { Operation } from "effection";
import { join, resolve } from "node:path";
import { readTextFile, writeTextFile } from "@effectionx/fs";
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
import { git } from "../../git/tests/support/git-remotes.ts";
import { createFakeAcp, makeStore } from "./support/fake-acp.ts";

const components = resolve("examples/adversarial-implementation/components");

function* fixture() {
  const temp = yield* useTempDirectory("xmd-diagnosis-");
  const root = (yield* realpath(temp)) ?? temp;
  const repository = join(root, "repo");
  git(["init", repository], root, root);
  yield* writeTextFile(join(repository, "tracked"), "unchanged\n");
  git(["add", "tracked"], repository, root);
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
  function run(attempt: string, previous?: string, inputPaths = [evidence]) {
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
        ]);
      };
      const request = {
        role: "problem-solver",
        session: "diagnosis",
        attempt,
        ...(previous === undefined ? {} : { previous }),
        inputPaths,
        assignment: { repository, revision, work: "test", request: "Find the cause." },
      };
      const path = join(root, "request.json");
      yield* writeTextFile(path, JSON.stringify(request));
      const source = `<Entry.Phase request=${JSON.stringify(path)} as="result" /><Json value={result} />`;
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
  it("records a cause, continues its original conversation, and refuses changed identity", function* () {
    const test = yield* fixture();
    const first = join(test.root, "first");
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
    expect(JSON.parse(yield* test.run(first))).toMatchObject({ status: "cause" });
    const original = JSON.parse(yield* readTextFile(join(first, "fable/result.json")));
    expect(original).toMatchObject({ model: "fable", assignment: { solver: { model: "fable" } } });
    expect(original.identity.identity).not.toBeNull();

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
      test.run(join(test.root, "new"), join(next, "fable")),
      "Reconcile the original diagnostic turn",
    );
    expect(test.fake.prompts).toHaveLength(2);
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
