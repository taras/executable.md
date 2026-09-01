/**
 * Tier XP — cross-package resolution (issue #202 acceptance).
 *
 * Agent, Testing and TestAgent register their components into one scope. All
 * three are ordinary non-reserved registrations, so what a name means has to be
 * decided by the resolution tiers alone (spec §5.3) — never by which installer
 * ran first.
 *
 * **The runtime path is the evidence.** XP1 and XP2 execute documents and read
 * what was rendered, because that is what a resolution defect cannot hide from:
 * the retired expansion hook could claim a name and preempt execution while
 * `inspectComponent` went on reporting the repository file it had overridden,
 * so an inspection-only suite would have passed against exactly the arrangement
 * it appeared to be testing. XP3 and XP4 add inspection on top, for origins
 * execution does not reveal.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { executeInstalled } from "@executablemd/core/host";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InMemoryStream } from "@executablemd/durable-streams";
import {
  agentIdentityComponents,
  collect,
  Component,
  execute,
  inspectComponent,
  installAgentComponents,
  useTempFileCompiler,
} from "@executablemd/core";
import type { ComponentInfo } from "@executablemd/core";
import { installTestingComponents } from "@executablemd/testing";
import { installTestAgentComponents } from "../src/components.ts";

/**
 * Every name the three packages register. All are non-reserved defaults.
 *
 * Written out rather than derived, so the coverage each test claims is visible
 * in the file — and checked against the live registry by XP0, which is what
 * keeps the two from drifting apart as packages gain components.
 */
const AGENT = [
  "AgentProvider",
  "Agent",
  // The dotted name addresses a subdirectory, so a repository override for it
  // is components/Session/Launch.md.
  "Session.Launch",
  "Prompt",
  "ApproveAll",
  "AskPermission",
];
/**
 * `<Session>` is not on that list.
 *
 * Its implementation names durable work after its own invocation, so the
 * execution is told about it rather than the installation registering it, and
 * it exists only inside a document a host declared it to.
 */
const TESTING = [
  "Testing",
  "AssertThrows",
  // The nested-execution harness. `<Execution>` and `<WorkflowRun>` are
  // registered here as the definitions that refuse: the ones that can run a
  // child are registered inside a canonical `<Test>` invocation by the
  // installer its host attached, and shadow these for that test's body alone.
  "Execution",
  "WorkflowRun",
  "DiagnosticJournal",
  "CollectOutput",
  "CollectJournal",
  // The fourteen entries of the assertion table, each registered from it.
  "Assert",
  "AssertFalse",
  "AssertExists",
  "AssertEquals",
  "AssertNotEquals",
  "AssertStrictEquals",
  "AssertNotStrictEquals",
  "AssertStringIncludes",
  "AssertMatch",
  "AssertNotMatch",
  "AssertGreater",
  "AssertGreaterOrEqual",
  "AssertLess",
  "AssertLessOrEqual",
];
const TEST_AGENT = ["TestAgent", "TestAgent.Scenario"];

/**
 * `<Test>` is core's, not the testing package's (#441).
 *
 * Core owns the construct because core owns what an invocation of it means for
 * the run — a checked command failure inside one is that test's outcome — and
 * the testing package supplies what a test does. It is still an ordinary
 * default, which is what the cases below check: a repository file replaces it
 * exactly as it replaces the three packages' own registrations.
 */
const CORE = ["Test"];
const REGISTERED = [...AGENT, ...TESTING, ...TEST_AGENT, ...CORE];

type Order = "agent-first" | "test-agent-first";

function* installAll(order: Order): Operation<void> {
  if (order === "agent-first") {
    yield* installAgentComponents();
    yield* installTestingComponents();
    yield* installTestAgentComponents();
    return;
  }
  yield* installTestAgentComponents();
  yield* installTestingComponents();
  yield* installAgentComponents();
}

function useWorkspace(): Operation<string> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "xp-test-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* provide(root);
  });
}

/**
 * A dotted component name is a path, not a filename: `TestAgent.Scenario` is
 * looked for at `TestAgent/Scenario.md`.
 */
function fileFor(workspace: string, name: string): string {
  return join(workspace, `${name.replaceAll(".", "/")}.md`);
}

/** The marker a repository stand-in renders when it is the one that ran. */
function marker(name: string): string {
  return `LOCAL<${name}>`;
}

/**
 * A repository stand-in for every registered name.
 *
 * Each renders only its marker, so none of them elicits, opens a session, or
 * needs an active testing boundary the way the real component would. A marker
 * in the output therefore means that file ran, and nothing else could have
 * produced it.
 */
function* writeStandIns(workspace: string): Operation<void> {
  for (const name of REGISTERED) {
    const path = fileFor(workspace, name);
    yield* ensureDir(dirname(path));
    yield* writeTextFile(path, `${marker(name)}\n`);
  }
}

/** Execute a document invoking every registered name, and return its text. */
function runDocument(workspace: string, order: Order): Operation<string> {
  return scoped(function* () {
    const path = join(workspace, "doc.md");
    // Self-closing, so nothing is handed content to expand.
    yield* writeTextFile(path, `${REGISTERED.map((name) => `<${name} />`).join("\n\n")}\n`);
    yield* useTempFileCompiler();
    yield* installAll(order);
    const output = yield* collect(
      yield* executeInstalled({ path, stream: new InMemoryStream(), includes: [workspace] }, [
        { components: agentIdentityComponents() },
      ]),
    );
    return String(output);
  });
}

/** What every registered name resolves to, under one installation order. */
function resolveAll(order: Order, includes: string[] = []): Operation<Map<string, string>> {
  return scoped(function* () {
    yield* installAll(order);
    const resolved = new Map<string, string>();
    for (const name of REGISTERED) {
      resolved.set(name, describeOrigin(yield* inspectComponent({ name, includes })));
    }
    return resolved;
  });
}

/**
 * A resolution as one comparable string: the tier, and where it came from.
 *
 * `unresolved` is spelled out rather than filtered away — a name that stopped
 * resolving would otherwise read as an ordinary difference between two runs
 * instead of the regression it is.
 */
function describeOrigin(info: ComponentInfo): string {
  if (info.kind === "unresolved") {
    return `unresolved (searched ${info.searched.length})`;
  }
  switch (info.origin.kind) {
    case "structural":
      return `structural:${info.origin.construct}`;
    case "registered":
      return `registered:${info.origin.origin}${info.origin.reserved ? " (reserved)" : ""}`;
    case "repository":
      return `repository:${info.origin.path}`;
    case "declared-markdown":
      return `declared-markdown:${info.origin.origin}`;
  }
}

describe("Tier XP — cross-package resolution", () => {
  /**
   * The inventory below is what every other case iterates, so a name missing
   * from it is coverage silently not taken. Comparing against the live registry
   * is what makes "every registered name" a checked claim rather than a comment.
   */
  it("XP0: the names under test are exactly the ones the three packages register", function* () {
    const installed = yield* scoped(function* () {
      yield* installAll("agent-first");
      return [...(yield* Component.operations.registry).keys()].sort();
    });

    // Core's own defaults are not in a scope's registrations: they are the
    // terminal `selectComponent()` resolves against, so `<Test>` is covered by
    // the resolution cases rather than by this inventory.
    expect(installed).toEqual([...AGENT, ...TESTING, ...TEST_AGENT].sort());
  });

  it("XP1: a repository component runs in place of every registered default", function* () {
    const workspace = yield* useWorkspace();
    yield* writeStandIns(workspace);

    const output = yield* runDocument(workspace, "agent-first");

    // Rendered output, not a resolver answer: each marker is evidence that the
    // repository file is what executed for that name.
    for (const name of REGISTERED) {
      expect(output).toContain(marker(name));
    }
  });

  it("XP2: which installer ran first changes nothing about what executed", function* () {
    const workspace = yield* useWorkspace();
    yield* writeStandIns(workspace);

    const first = yield* runDocument(workspace, "agent-first");
    const second = yield* runDocument(workspace, "test-agent-first");

    // Installation order is not a resolution mechanism, so the two runs produce
    // the same document — not merely the same set of resolved origins.
    expect(second).toBe(first);
    for (const name of REGISTERED) {
      expect(second).toContain(marker(name));
    }
  });

  it("XP3: each package's names carry that package's origin, and none is reserved", function* () {
    const resolved = yield* resolveAll("agent-first");

    // Inspection, because an origin is not observable from rendered output.
    for (const name of AGENT) {
      expect(resolved.get(name)).toBe("registered:@executablemd/core");
    }
    for (const name of TESTING) {
      expect(resolved.get(name)).toBe("registered:@executablemd/testing");
    }
    for (const name of TEST_AGENT) {
      expect(resolved.get(name)).toBe("registered:@executablemd/test-agent");
    }
    for (const name of CORE) {
      expect(resolved.get(name)).toBe("registered:@executablemd/core");
    }
    expect([...(yield* resolveAll("test-agent-first")).entries()]).toEqual([...resolved.entries()]);
  });

  it("XP4: a structural name still outranks all three installers", function* () {
    const workspace = yield* useWorkspace();
    yield* writeTextFile(join(workspace, "Each.md"), "SHOULD NOT RENDER\n");
    const path = join(workspace, "doc.md");
    yield* writeTextFile(path, '<Each in={[1, 2]} let="n">[{n}]</Each>\n');

    const observed = yield* scoped(function* () {
      yield* useTempFileCompiler();
      yield* installAll("test-agent-first");
      return {
        info: yield* inspectComponent({ name: "Each", includes: [workspace] }),
        output: String(
          yield* collect(
            yield* executeInstalled({ path, stream: new InMemoryStream(), includes: [workspace] }, [
              { components: agentIdentityComponents() },
            ]),
          ),
        ),
      };
    });

    expect(describeOrigin(observed.info)).toBe("structural:Each");
    // The construct ran, not the file named after it.
    expect(observed.output).toContain("[1][2]");
    expect(observed.output).not.toContain("SHOULD NOT RENDER");
  });
});
