/**
 * One Sidekick, assembled the way the command assembles it (#883).
 *
 * Everything below the terminal is real: a temporary repository on disk, the
 * paired history this CLI publishes, the profile this command assembles, a real
 * `ReplSession` owning the entry task, the canonical conversation Core opens
 * over this history's own sequence, and the response ceiling `profile.ts`
 * builds. What is scripted is the provider — one `FakeAcp` standing where the
 * agent process would be — because the thing under test is the plumbing a reply
 * crosses, not what a model would say.
 *
 * What is *not* here yet is the terminal. Sending a message is a control
 * section 5 mounts, so these rows drive the owner the way the loop will, with
 * the loop's own state beside it. The rows that need a mounted tree — the
 * Sidekick pane, Send, Stop and the question drawer — are R5/R6/R8's and are
 * not covered.
 */

import { mkdtemp, open as openFile, appendFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensure, Ok, until } from "effection";
import type { Operation, Result } from "effection";

import { useTempFileCompiler } from "@executablemd/core";
import type { ExecutionInstallation } from "@executablemd/core/host";

import { installReplHost } from "../../../../src/repl-assembly.ts";
import { resolveAgentStack } from "../../../../src/agent-stack.ts";
import { assembleReplProfile } from "../../../../src/repl-profile.ts";
import type { ReplExecutionProfile } from "../../../../src/repl-profile.ts";
import { NO_PLUGINS } from "../../../../src/plugin-host.ts";
import { openReplSession } from "../../../../src/repl/session.ts";
import type { ReplSession } from "../../../../src/repl/session.ts";
import { admitted, filled, initialState } from "../../../../src/repl/application.ts";
import type { ReplState } from "../../../../src/repl/application.ts";
import { fillable } from "../../../../src/repl/sidekick/gate.ts";
import type { DraftFacts } from "../../../../src/repl/sidekick/gate.ts";
import {
  admitting as newAdmitting,
  submitForSidekick,
} from "../../../../src/repl/sidekick/admission.ts";
import type { Admitting } from "../../../../src/repl/sidekick/admission.ts";
import { pairedReplRepository } from "../../../../src/repl/sidekick/repository.ts";
import type {
  PairedChatStorage,
  PairedReplExecution,
  PairedReplRepository,
} from "../../../../src/repl/sidekick/repository.ts";
import { rootReads } from "../../../../src/repl/sidekick/requests.ts";
import type { RootReading } from "../../../../src/repl/sidekick/requests.ts";
import { projectSidekick } from "../../../../src/repl/sidekick/model.ts";
import type { SidekickRecord } from "../../../../src/repl/sidekick/history.ts";
import { useSidekickOwner } from "../../../../src/repl/sidekick/owner.ts";
import type { SidekickOwner } from "../../../../src/repl/sidekick/owner.ts";
import type { ControlJournal, SubmitReceipt } from "../../../../src/repl/sidekick/controls.ts";
import { createFakeAcp, makeRegistry, makeStore } from "../../../support/fake-acp.ts";
import type { FakeAcp } from "../../../support/fake-acp.ts";

/** The agent these conversations are opened with. */
export const AGENT = "scripted-sidekick";

/** One case's world: the real pieces, and the one scripted provider. */
export interface Harness {
  readonly fake: FakeAcp;
  /** The repository, so a case can reopen this execution as a cold one would. */
  readonly repository: PairedReplRepository;
  readonly owner: SidekickOwner;
  readonly session: ReplSession;
  readonly execution: PairedReplExecution;
  readonly profile: ReplExecutionProfile;
  /** The loop's own state, which the owner reads the draft and revision from. */
  state(): ReplState;
  /** The slot the person and a reply contend for, as the loop holds it. */
  readonly admitting: Admitting;
}

/** A temporary directory for one case, removed when its scope ends. */
export function* useTemporary(prefix: string): Operation<string> {
  const made = yield* until(mkdtemp(join(tmpdir(), prefix)));
  yield* ensure(() => until(rm(made, { recursive: true, force: true })));
  return made;
}

/**
 * Everything one case needs, assembled the way the command assembles it.
 *
 * The order matters and is the command's: the host, then the repository, then
 * the profile — which is what installs the provider stack — then the session,
 * then the owner over the execution's own chat storage.
 */
export function* useHarness(
  /**
   * One draft fill that fails, for the row about an ordinary root failure.
   *
   * Injected at the root's own seam rather than by breaking a control, because
   * what that row is about is what Core hands back when a root's element fails
   * partway: the response source is ordinary and the failure is ordinary.
   */
  failSource?: string,
  /** The seams a lifetime case needs, and an ordinary case leaves alone. */
  extra: {
    /**
     * One extra installation for the *entry* session, so a case can hold a real
     * entry's startup open.
     *
     * The entry's own, not the Sidekick conversation's: what such a case needs
     * to reach is the interval between a task being allocated and its entry
     * being admitted, and that interval is inside the entry's execution.
     */
    readonly entryInstallation?: ExecutionInstallation;
    /**
     * The draft fill, replaced whole, so a case can hold a control open.
     *
     * A control that suspends is how a response's cleanup is held, which is the
     * only way to observe what Stop waits for.
     */
    readonly fill?: (source: string) => Operation<Result<void>>;
  } = {},
): Operation<Harness> {
  // An entry's eval block compiles through a module this host has to supply, so
  // a harness without it would run entries that fail for a reason nothing in
  // these rows is about.
  yield* useTempFileCompiler();
  const dataRoot = yield* useTemporary("xmd-sidekick-journey-");
  yield* installReplHost({
    dataRoot: () => dataRoot,
    // The facts a runtime entrypoint states, so `<REPL.Environment />` answers
    // here the way it answers in a command rather than refusing.
    environment: () => [
      { label: "runtime", value: "a controlled journey host" },
      { label: "xmd", value: "0.0.0-journey" },
    ],
    identify: () => randomBytes(8).toString("hex"),
    createExclusive: (path) => openFile(path, "wx").then((handle) => handle.close()),
    appendRecord: (path, record) => appendFile(path, record),
  });

  const repository = pairedReplRepository(join(dataRoot, "repl"));
  const execution = yield* repository.create();

  const fake = createFakeAcp();
  const stack = yield* resolveAgentStack(
    {
      agentProvider: "acpx",
      defaultAgent: AGENT,
      approveAll: false,
      approveReads: false,
      denyAll: false,
    },
    undefined,
  );
  if (!stack.ok) {
    throw stack.error;
  }
  const profile = yield* (yield* assembleReplProfile(stack.value, NO_PLUGINS, {
    acp: {
      createRuntime: fake.create,
      sessionStore: makeStore(),
      agentRegistry: makeRegistry({ [AGENT]: `${AGENT}-cmd` }),
    },
    // The scripted agent, named to the profile rather than left to the
    // environment: the Sidekick assembly is built with it, and a conversation
    // opened under an agent this registry does not know would fail as an
    // availability refusal rather than reaching the fake.
    sidekickAgent: AGENT,
    planWriterRoot: yield* useTemporary("xmd-sidekick-plan-"),
  })).finalize();

  const opened = yield* openReplSession({
    execution,
    includes: profile.includes,
    installations:
      extra.entryInstallation === undefined
        ? profile.installations
        : [...profile.installations, extra.entryInstallation],
    permissionMode: profile.permissionMode,
  });
  if (!opened.ok) {
    throw opened.error;
  }
  const session = opened.value;

  // The loop's state, and the one slot the person and a reply contend for.
  let state = initialState(execution.id);
  const admitting: Admitting = newAdmitting();

  function facts(): DraftFacts {
    return {
      live: true,
      revisions: state.revisions,
      takenOver: state.takenOver,
      draft: state.draft,
    };
  }

  /** What the loop does with a finished submission, in the same order. */
  function applyReports(): void {
    for (const report of admitting.reported.splice(0)) {
      if (admitting.held === report.held) {
        admitting.held = undefined;
      }
      if (report.kind === "admitted") {
        state = admitted(state, report.held);
      }
    }
  }

  const root: RootReading = {
    ...rootReads(session, profile),
    // deno-lint-ignore require-yield
    *fill(source: string): Operation<Result<void>> {
      if (extra.fill !== undefined) {
        return yield* extra.fill(source);
      }
      const allowed = fillable(state);
      if (!allowed.ok) {
        return allowed;
      }
      if (source === failSource) {
        throw new Error("controlled ordinary fill failure");
      }
      state = filled(state, source);
      return Ok(undefined);
    },
  };

  const owner = yield* useSidekickOwner({
    // The production assembly, built by the profile from the same scripted
    // dependencies above: the Sidekick's own provider, with no tools, no MCP
    // servers, strict routing, denied permissions and no prompt
    // customization. Not the entry stack's, which is what the command does.
    assembly: profile.sidekickAssembly,
    chat: execution.chat as PairedChatStorage,
    // deno-lint-ignore require-yield
    *establish(): Operation<Result<PairedChatStorage>> {
      return Ok(execution.chat as PairedChatStorage);
    },
    root,
    submit(at, journal: ControlJournal): Operation<Result<SubmitReceipt>> {
      return submitForSidekick(at, {
        session: {
          // The acknowledged history, read the way the root reads it.
          entries: () => {
            const read = session.reading(undefined);
            if (!read.ok) {
              return read;
            }
            return Ok(
              read.value.model.entries.map((entry) => ({
                key: entry.key,
                source: entry.source,
              })),
            );
          },
          admits: () => session.admits(),
          submit: (source) => session.submit(source),
        },
        // Asked rather than snapshotted: `submitForSidekick` reads it when it
        // reserves and again when the entry starts, and `facts` already answers
        // from the loop state these rows hold.
        facts,
        held: admitting,
        journal,
        writer: execution.stream,
        woke: applyReports,
      });
    },
    revision: () => state.revisions.message,
    draft: () => state.draft,
    // deno-lint-ignore require-yield
    *acknowledge(): Operation<void> {
      // Nothing to apply: these rows own the state directly rather than through
      // a loop, so a saved message is acknowledged the moment it is saved.
    },
  });

  return { fake, repository, owner, session, execution, profile, admitting, state: () => state };
}

/** Every record this execution's chat history holds. */
export function records(execution: PairedReplExecution): Operation<readonly SidekickRecord[]> {
  const chat = execution.chat;
  if (chat.form !== "paired") {
    throw new Error("this execution has no chat history");
  }
  return chat.writer.readAll();
}
