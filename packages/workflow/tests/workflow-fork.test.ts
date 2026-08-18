/**
 * Tier WFK — what a fork may inherit, decided before anything exists.
 *
 * Two questions, both answered from retained values alone: whether a checkpoint
 * can be forked at all, and which events a fork that selects it takes with it.
 * Neither opens a database, so both are exercised here against retained shapes
 * a run could hold rather than against a run that had to be produced.
 *
 * The blockers are the reason this tier is not folded into the CLI's: an Agent
 * turn and an effect a later build wrote are histories this build cannot
 * produce on purpose, and a test that waited for one would assert nothing on
 * the days it did not arrive. The Git-host pair is here for the opposite
 * reason — both sides of that boundary can be stated exactly — and Tier WFF
 * proves them end to end against a real `<Git.Push>`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import {
  classifyForkability,
  forkJournal,
  isRootImportEvent,
  isRunRecordEvent,
  selectForkPrefix,
} from "@executablemd/workflow";
import type { ForkCandidate } from "@executablemd/workflow";

const ROOT_A = "a".repeat(64);
const ROOT_B = "b".repeat(64);

function retained(type: string, name = type, result: Json = null): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type, name },
    result: { status: "ok", value: result },
  };
}

function closed(coroutineId: string): DurableEvent {
  return { type: "close", coroutineId, result: { status: "ok", value: null } };
}

/** One history, classified against the roots the run still holds. */
function classify(
  events: readonly { id: string; event: DurableEvent; root?: string }[],
  retainedRoots: readonly string[] = [ROOT_A, ROOT_B],
) {
  return classifyForkability(
    events.map((entry) => ({
      eventId: entry.id,
      event: entry.event,
      workspaceRootId: entry.root ?? ROOT_A,
    })),
    { retainedRoots: new Set(retainedRoots) },
  );
}

/** The same history, as fork selection reads it. */
function candidates(
  events: readonly { id: string; event: DurableEvent; root?: string }[],
): ForkCandidate[] {
  const forkability = classify(events);
  return events.map((entry, index) => ({
    eventId: entry.id,
    event: entry.event,
    workspaceRootId: entry.root ?? ROOT_A,
    forkability: forkability[index] ?? { forkable: false, blockers: [] },
  }));
}

const RUN_RECORD = retained("workflow_run", "workflow_run", {
  runId: "source-1",
  base: "main",
  pinnedCommit: "abc",
});
const ROOT_IMPORT = retained("import_component", "__root__", {
  kind: "repository",
  path: "flows/release.md",
  content: "# Release\n",
});

describe("Tier WFK — forkability and fork selection", () => {
  it("WFK1: a history of inheritable effects is forkable at every event", function* () {
    const forkability = classify([
      { id: "e1", event: RUN_RECORD },
      { id: "e2", event: ROOT_IMPORT },
      { id: "e3", event: retained("workspace_file", "write:x:/notes.md"), root: ROOT_B },
      { id: "e4", event: retained("exec", "exec:echo hi"), root: ROOT_B },
      { id: "e5", event: closed("root"), root: ROOT_B },
    ]);

    expect(forkability.map((entry) => entry.forkable)).toEqual([true, true, true, true, true]);
    // Empty exactly when forkable, which is the shape the CLI contract states.
    expect(forkability.every((entry) => entry.blockers.length === 0)).toBe(true);
  });

  it("WFK2: a blocker is cumulative and names the earliest event that introduced it", function* () {
    const forkability = classify([
      { id: "e1", event: RUN_RECORD },
      { id: "e2", event: retained("agent_prompt", "prompt:1") },
      { id: "e3", event: retained("exec", "exec:echo hi") },
      { id: "e4", event: retained("agent_prompt", "prompt:2") },
    ]);

    expect(forkability[0]?.forkable).toBe(true);
    for (const entry of forkability.slice(1)) {
      expect(entry.forkable).toBe(false);
      // The second Agent turn adds no second blocker: the code is already
      // introduced, and it names the turn that introduced it.
      expect(entry.blockers).toEqual([{ code: "agent-state-unavailable", eventId: "e2" }]);
    }
  });

  it("WFK3: each stable code has its own retained cause", function* () {
    const forkability = classify(
      [
        { id: "e1", event: RUN_RECORD },
        // A Git-host event holding no completed reconciliation record: the run
        // stopped without establishing what happened at the remote.
        { id: "e2", event: retained("git_host_effect", "git-push:1") },
        { id: "e3", event: retained("something_a_later_build_wrote", "whatever") },
        { id: "e4", event: retained("exec", "exec:echo hi"), root: "c".repeat(64) },
      ],
      [ROOT_A],
    );

    expect(forkability[1]?.blockers).toEqual([
      { code: "external-state-unavailable", eventId: "e2" },
    ]);
    expect(forkability[2]?.blockers).toEqual([
      { code: "external-state-unavailable", eventId: "e2" },
      { code: "unsupported-effect", eventId: "e3" },
    ]);
    expect(forkability[3]?.blockers).toEqual([
      { code: "external-state-unavailable", eventId: "e2" },
      { code: "unsupported-effect", eventId: "e3" },
      { code: "workspace-root-unavailable", eventId: "e4" },
    ]);
    // Codes and event ids, and nothing a retained description held.
    for (const entry of forkability) {
      for (const blocker of entry.blockers) {
        expect(JSON.stringify(blocker)).not.toContain("git-push");
        expect(JSON.stringify(blocker)).not.toContain("whatever");
      }
    }
  });

  it("WFK3b: a completed Git-host record is inherited, not refused", function* () {
    // What decides a Git-host event is what the history holds about it, not its
    // type. A completed reconciliation record carries the pre-state, the
    // observations, the decision and the result, and replays without
    // contacting a provider at all.
    const completed = retained("git_host_effect", "git-push:1", {
      request: {
        identity: { runId: "source-1", expansionId: "x" },
        kind: "git-push",
        inputs: { remote: "origin" },
        naturalKey: { destinationRef: "refs/heads/publish/1" },
      },
      preState: { remoteCommit: null },
      observations: { remoteCommit: "abc" },
      decision: "performed",
      result: { remoteCommit: "abc" },
    });

    const forkability = classify([
      { id: "e1", event: RUN_RECORD },
      { id: "e2", event: completed },
      { id: "e3", event: retained("exec", "exec:echo hi") },
    ]);

    expect(forkability.map((entry) => entry.forkable)).toEqual([true, true, true]);
    expect(forkability.every((entry) => entry.blockers.length === 0)).toBe(true);

    // A record that is nearly one is still not one: a member the shape does not
    // declare describes something else, and a fork does not guess at it.
    const nearly = retained("git_host_effect", "git-push:2", {
      request: {
        identity: { runId: "source-1", expansionId: "y" },
        kind: "git-push",
        inputs: {},
        naturalKey: {},
      },
      preState: null,
      observations: null,
      decision: "performed",
      result: null,
      extra: "a member this shape does not declare",
    });
    const refused = classify([
      { id: "e1", event: RUN_RECORD },
      { id: "e2", event: nearly },
    ]);
    expect(refused[1]?.blockers).toEqual([{ code: "external-state-unavailable", eventId: "e2" }]);
  });

  it("WFK4: selection takes the prefix and leaves the two records a fork writes", function* () {
    const history = candidates([
      { id: "e1", event: RUN_RECORD },
      { id: "e2", event: ROOT_IMPORT },
      { id: "e3", event: retained("import_component", "File") },
      { id: "e4", event: retained("workspace_file", "write:x:/notes.md"), root: ROOT_B },
      { id: "e5", event: retained("exec", "exec:echo hi"), root: ROOT_B },
      { id: "e6", event: closed("root"), root: ROOT_B },
    ]);

    const selected = selectForkPrefix(history, "e4");
    expect(selected.ok).toBe(true);
    if (!selected.ok) {
      return;
    }
    expect(selected.value.inherited.map((entry) => entry.eventId)).toEqual(["e3", "e4"]);
    expect(selected.value.checkpointWorkspaceRootId).toBe(ROOT_B);

    // The fork's journal is its own two records and then what it inherited.
    const journal = forkJournal(
      { runId: "fork-1", base: "main", pinnedCommit: "def" },
      ROOT_IMPORT,
      selected.value,
    );
    expect(journal).toHaveLength(4);
    expect(isRunRecordEvent(journal[0] as DurableEvent)).toBe(true);
    expect(isRootImportEvent(journal[1] as DurableEvent)).toBe(true);
    expect(journal[2]).toEqual(history[2]?.event);
    expect(journal[3]).toEqual(history[3]?.event);
  });

  it("WFK5: a checkpoint nobody retained, an outcome and a blocked prefix are refused", function* () {
    const history = candidates([
      { id: "e1", event: RUN_RECORD },
      { id: "e2", event: ROOT_IMPORT },
      { id: "e3", event: retained("agent_prompt", "prompt:1") },
      { id: "e4", event: closed("root") },
    ]);

    const missing = selectForkPrefix(history, "nowhere");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.message).toContain("nowhere");
    }

    const outcome = selectForkPrefix(history, "e4");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("canonical outcome");
    }

    const blocked = selectForkPrefix(history, "e3");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      // The stable code, and the event that introduced it.
      expect(blocked.error.message).toContain("agent-state-unavailable");
      expect(blocked.error.message).toContain("e3");
      expect(blocked.error.message).not.toContain("prompt:1");
    }
  });
});
