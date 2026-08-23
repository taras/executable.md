/**
 * Tier WSR — a run restarts, and each Session site comes back to its own
 * conversation (specs/workflow-workspace-spec.md §8.5).
 *
 * The whole boundary, once: a real Markdown document with two same-named
 * `<Session>` sites, the real workflow attachment, the real mapping table in the
 * run's own database, and a second attachment over what the first left behind.
 * Only the agent process is substituted.
 *
 * WAP7 proves two sibling sites place two identities while a document is
 * running, and WSL proves the resolution rules in isolation. Neither crosses
 * this boundary: document, to committed row, to a new attachment reading it
 * back. That crossing is what a restart is.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn } from "effection";
import type { Operation } from "effection";
import { readTextFile } from "@effectionx/fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collect, execute, retainedSource } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import { withWorkflowWorkspace } from "@executablemd/workflow/deno";
import { useWorkflowAgentProfile } from "../src/workflow-agent.ts";
import type { WorkflowAgentProfileOptions } from "../src/workflow-agent.ts";
import { createFakeAcp, makeStore, tripwireAcp } from "./support/fake-acp.ts";
import type { FakeAcp } from "./support/fake-acp.ts";
import { createRun, useStorageRoot, withStorage } from "./support/workflow-run.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "workflow-agent");

function* documentSource(): Operation<string> {
  return yield* readTextFile(join(FIXTURES, "sibling-sessions.md"));
}

interface Attempt {
  output?: Json;
  failure?: string;
}

/**
 * One attachment over `database`, running the fixture.
 *
 * The contextual working directory is somewhere the run may not reach, and a
 * host Files provider sits outside the attachment, so anything that fell through
 * to the caller's filesystem would be visible rather than silent.
 */
function attach(
  root: string,
  database: WorkflowRunDatabase,
  source: string,
  options: {
    readonly createRuntime: WorkflowAgentProfileOptions["createRuntime"];
    readonly sessionStore: WorkflowAgentProfileOptions["sessionStore"];
  },
): Operation<Attempt> {
  return scoped(function* () {
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd(): Operation<string> {
          return "/nowhere-the-workflow-may-reach";
        },
      },
      { at: "min" },
    );
    yield* useHostFiles();
    let output: Json | undefined;
    let failure: string | undefined;
    try {
      output = yield* withWorkflowWorkspace(
        database,
        scoped(function* () {
          return yield* collect(
            yield* execute({
              ...retainedSource("workflows/sibling-sessions.md", source),
              stream: database.journal,
            }),
          );
        }),
        {
          agent: (attachment) =>
            useWorkflowAgentProfile({
              root,
              attachment,
              defaultAgent: "codex",
              ...options,
            }),
        },
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    return {
      ...(output === undefined ? {} : { output }),
      ...(failure === undefined ? {} : { failure }),
    };
  });
}

/** Every session key the fake was asked to establish, in order. */
function established(fake: FakeAcp): string[] {
  return fake.ensured.map((input) => input.sessionKey);
}

describe("Tier WSR — a restart reattaches each Session site", () => {
  it("WSR1: two same-named sites keep their own asserted identities across a restart", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentSource();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      // One store across both attachments: the provider keeps its sessions
      // across processes, so a fresh one would be a provider that forgot rather
      // than a process that restarted.
      const store = makeStore();

      // The first attachment is interrupted while the second site's turn is in
      // flight, so the first site's mapping has committed and the second site's
      // has not.
      const interrupted = createFakeAcp();
      interrupted.script({ reply: "the first reviewer saw the checklist" });
      interrupted.script({ reply: "", manual: true });

      const first = yield* spawn(() =>
        attach(root, database, source, {
          createRuntime: interrupted.create,
          sessionStore: store,
        }),
      );
      yield* interrupted.startedTurns(2);
      yield* first.halt();

      const before = established(interrupted);
      // Two sites, two sessions — with one authored name between them.
      expect(new Set(before).size).toBe(2);

      // The restart: a new attachment over the same run and the same provider
      // store, with a provider that answers the turn the first attempt never
      // finished.
      const resumed = createFakeAcp();
      resumed.script({ reply: "the second reviewer saw the release notes" });
      const second = yield* attach(root, database, source, {
        createRuntime: resumed.create,
        sessionStore: store,
      });

      expect(second.failure).toBe(undefined);

      // Each site came back to its own conversation. The second attachment
      // establishes only the keys the first one did — no third session, and no
      // site reattached to the other's.
      const after = established(resumed);
      expect(after.length).toBeGreaterThan(0);
      for (const key of after) {
        expect(before).toContain(key);
      }
      expect(new Set([...before, ...after]).size).toBe(2);

      // And the identities the provider asserted are still one per site, which
      // is what "reattached to its own" means rather than "reattached". A key
      // may be ensured more than once in an attachment, so the claim is about
      // distinct sites rather than about how many times each was asked for.
      const sites = new Set(after);
      const asserted = new Set([...sites].map((key) => `agent-session:${key}`));
      expect(asserted.size).toBe(sites.size);
      // The site the first attempt never finished is the one this attempt ran.
      expect(sites.size).toBeGreaterThan(0);
    });
  });

  it("WSR2: a replayed site asks the provider for nothing", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentSource();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const store = makeStore();

      const live = createFakeAcp();
      live.script({ reply: "the first reviewer saw the checklist" });
      live.script({ reply: "the second reviewer saw the release notes" });
      const complete = yield* attach(root, database, source, {
        createRuntime: live.create,
        sessionStore: store,
      });
      expect(complete.failure).toBe(undefined);
      expect(new Set(established(live)).size).toBe(2);

      // Both sites are recorded, so a further attachment restores them and
      // reaches no provider at all — not even to create a runtime.
      const reached: string[] = [];
      const replay = yield* attach(root, database, source, {
        createRuntime: tripwireAcp((what) => reached.push(what)),
        sessionStore: store,
      });
      expect(replay.failure).toBe(undefined);
      expect(reached).toEqual([]);
    });
  });
});
