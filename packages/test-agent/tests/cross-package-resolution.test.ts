/**
 * Tier XP — cross-package resolution (issue #202 acceptance).
 *
 * Agent, Testing and TestAgent register their components into one scope. All
 * three are ordinary non-reserved defaults now, so what a name means has to be
 * decided by the resolution tiers alone (spec §5.3) — never by which installer
 * ran first, and never by a leftover claim on an expansion hook.
 *
 * This is the test that would have caught the old arrangement: a name claimed
 * through `Component.expand` preempted resolution entirely, so it beat a
 * repository file *and* changed meaning depending on install order. Both
 * properties are asserted here against the registered path.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectComponent, installAgentComponents } from "@executablemd/core";
import type { ComponentInfo } from "@executablemd/core";
import { installTestingComponents } from "@executablemd/testing";
import { installTestAgentComponents } from "../src/components.ts";

/** One name from each package, plus a structural name that outranks them all. */
const AGENT = ["AgentProvider", "Agent", "Session", "Prompt", "ApproveAll", "AskPermission"];
const TESTING = ["Testing", "Test", "AssertEquals", "AssertThrows"];
const TEST_AGENT = ["TestAgent", "TestAgent.Scenario"];
const REGISTERED = [...AGENT, ...TESTING, ...TEST_AGENT];

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
  return scoped(function* () {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "xp-test-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    return root;
  });
}

/** What every registered name resolves to, under one installation order. */
function resolveAll(order: Order, componentDirs: string[] = []): Operation<Map<string, string>> {
  return scoped(function* () {
    yield* installAll(order);
    const resolved = new Map<string, string>();
    for (const name of REGISTERED) {
      resolved.set(name, describeOrigin(yield* inspectComponent({ name, componentDirs })));
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
  }
}

describe("Tier XP — cross-package resolution", () => {
  it("XP1: every registered name resolves the same way in either installation order", function* () {
    const first = yield* resolveAll("agent-first");
    const second = yield* resolveAll("test-agent-first");

    // Reversing the order changes nothing: installation is not a resolution
    // mechanism, so the two maps are equal name for name.
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it("XP2: each package's names carry that package's origin, and none is reserved", function* () {
    const resolved = yield* resolveAll("agent-first");

    for (const name of AGENT) {
      expect(resolved.get(name)).toBe("registered:@executablemd/core");
    }
    for (const name of TESTING) {
      expect(resolved.get(name)).toBe("registered:@executablemd/testing");
    }
    for (const name of TEST_AGENT) {
      expect(resolved.get(name)).toBe("registered:@executablemd/test-agent");
    }
  });

  it("XP3: a repository file overrides every one of them", function* () {
    const workspace = yield* useWorkspace();
    // A dotted name is a path, not a filename: `TestAgent.Scenario` is looked
    // for at `TestAgent/Scenario.md`.
    const fileFor = (name: string) => join(workspace, `${name.replaceAll(".", "/")}.md`);

    for (const name of REGISTERED) {
      const path = fileFor(name);
      yield* ensureDir(dirname(path));
      yield* writeTextFile(path, `local ${name}\n`);
    }

    const resolved = yield* resolveAll("agent-first", [workspace]);

    // The tier above a default registration, for all three packages at once.
    // A name claimed on the expansion hook could not be overridden this way.
    for (const name of REGISTERED) {
      expect(resolved.get(name)).toBe(`repository:${fileFor(name)}`);
    }
  });

  it("XP4: a structural name still outranks all three installers", function* () {
    const workspace = yield* useWorkspace();
    yield* ensureDir(workspace);
    yield* writeTextFile(join(workspace, "Each.md"), "local Each\n");

    const info = yield* scoped(function* () {
      yield* installAll("test-agent-first");
      return yield* inspectComponent({ name: "Each", componentDirs: [workspace] });
    });

    expect(describeOrigin(info)).toBe("structural:Each");
  });
});
