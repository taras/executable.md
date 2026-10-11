/**
 * Leaving `xmd repl` on a real terminal (#870 UI2).
 *
 * The one row that cannot be faked. Every other piece of this Story's evidence
 * injects a terminal, which is what makes it portable and deterministic — but a
 * fake terminal's cleanup is whatever the fake decided, and the defect this row
 * exists for lived in the *runtime's* cleanup: an iterator's `return()` is queued
 * behind its own pending read, so a command that decided to leave waited for the
 * next keystroke before it finished. Nothing short of a real pty, with a real
 * reader blocked on a real descriptor, can show that it no longer does.
 *
 * So this launches the production entrypoint for the host runtime on a pty,
 * activates `[exit]` with literal terminal bytes, and then **sends nothing more**
 * while leaving the pty's input open. A run that needs one more byte fails here
 * by running out of time, which is exactly what a person pressing the control and
 * watching their shell not come back experiences.
 *
 * The terminal itself — which allocator this host can drive, what its screen
 * shows, how a child is owned until it has closed — is `./fixtures/pty.ts`, which
 * the repository journey drives too.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { cliRuntime, cliShellCommand } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { type Operation, scoped, sleep, spawn } from "effection";
import {
  allocate,
  BURST,
  ended,
  LEAVE_MS,
  ownedChild,
  reaching,
  REACH_MS,
  showing,
} from "./fixtures/pty.ts";
import type { ChildLike } from "./fixtures/pty.ts";

/** Let every ready task run, so "still unwinding" is a claim about turns. */
function* settled(turns = 8): Operation<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    yield* sleep(0);
  }
}

/**
 * A child a test drives: it closes when told, and says what is still attached.
 *
 * Structural rather than a real process, because what this row is about is the
 * *window* between signalling a child and its close arriving — and a real
 * process closes as fast as it likes, which is exactly the window a leak hides
 * in.
 */
function controllableChild(): {
  readonly child: ChildLike;
  readonly listeners: () => number;
  readonly signals: () => string[];
  /** Report a failure without closing, which is a thing a real child does. */
  fail(cause: Error): void;
  close(): void;
} {
  // Typed as what it holds, so nothing here has to be asserted back into shape.
  const attached = new Map<string, Set<(cause?: unknown) => void>>();
  const signals: string[] = [];
  const child: ChildLike = {
    on(event, listener) {
      const set = attached.get(event) ?? new Set();
      set.add(listener);
      attached.set(event, set);
      return child;
    },
    off(event, listener) {
      attached.get(event)?.delete(listener);
      return child;
    },
    kill(signal?: unknown) {
      signals.push(String(signal ?? "SIGTERM"));
      return true;
    },
    exitCode: null,
    signalCode: null,
  };
  return {
    child,
    listeners: () => [...attached.values()].reduce((total, set) => total + set.size, 0),
    signals: () => [...signals],
    fail(cause: Error): void {
      for (const listener of attached.get("error") ?? []) {
        listener(cause);
      }
    },
    close(): void {
      for (const listener of attached.get("close") ?? []) {
        listener();
      }
    },
  };
}

describe("REPL exit: the pty child this row owns", () => {
  it("UI2: leaving the scope signals the child and waits for it to close", function* () {
    const controllable = controllableChild();
    let left = false;

    const owner = yield* spawn(function* (): Operation<void> {
      yield* scoped(function* (): Operation<void> {
        const owned = yield* ownedChild(() => controllable.child);
        expect(owned.closed()).toBe(false);
        // close, error, and nothing on the two streams this fake does not have.
        expect(controllable.listeners()).toBe(2);
      });
      left = true;
    });

    // The scope has gone and the child was signalled — and the owner is still
    // unwinding, because a signal that was sent is not a process that has closed.
    yield* settled();
    yield* settled();
    expect(controllable.signals()).toEqual(["SIGKILL"]);
    expect(left).toBe(false);

    controllable.close();
    yield* owner;

    // Joined, and nothing of it is still attached: the handlers that did the
    // waiting came off after it rather than before.
    expect(left).toBe(true);
    expect(controllable.listeners()).toBe(0);
  });

  it("UI2: an error is kept, and the owner still waits for the close", function* () {
    const controllable = controllableChild();
    let left = false;
    let reported: Error | undefined;

    const owner = yield* spawn(function* (): Operation<void> {
      yield* scoped(function* (): Operation<void> {
        const owned = yield* ownedChild(() => controllable.child);

        // 1. The error arrives. A child can report one and still be running, and
        //    its stdio is open until `close` says otherwise.
        controllable.fail(new Error("the child could not start its pty"));
        yield* settled();
        expect(owned.failure()?.message).toContain("could not start");
        // 2. It is not closure, so nothing is finished.
        expect(owned.closed()).toBe(false);
        reported = owned.failure();
      });
      left = true;
    });

    // 3. The scope has gone and the owner is still unwinding: an error is not a
    //    close, and this waits for the close.
    yield* settled();
    yield* settled();
    expect(left).toBe(false);
    expect(controllable.signals()).toEqual(["SIGKILL"]);

    // 4. The close arrives, and only then does the owner complete.
    controllable.close();
    yield* owner;
    expect(left).toBe(true);
    expect(reported?.message).toContain("could not start");

    // 5. And nothing of it is still attached.
    expect(controllable.listeners()).toBe(0);
  });

  it("UI2: a child that has already closed is not signalled again", function* () {
    const controllable = controllableChild();

    yield* scoped(function* (): Operation<void> {
      const owned = yield* ownedChild(() => controllable.child);
      controllable.close();
      expect(owned.closed()).toBe(true);
    });

    // Nothing to kill, and the wait was already settled: cleanup is idempotent
    // and does not signal a process that has gone.
    expect(controllable.signals()).toEqual([]);
    expect(controllable.listeners()).toBe(0);
  });
});

describe("REPL exit: a real terminal, and nothing further typed", () => {
  it("UI2: [exit] finishes the command with no further byte and no closed input", function* () {
    const line = cliShellCommand(["repl", "--deny-all"]);

    yield* scoped(function* (): Operation<void> {
      // Owned by this scope, like the child below it: the data root is created
      // and removed by the same scope, so a run that passes, fails or is
      // cancelled leaves no directory behind. A test making a claim about
      // ownership has to keep it about itself first.
      const home = yield* useTempDirectory("xmd-repl-pty-");
      const pty = yield* allocate(line, home);

      // The screen, drawn on a real terminal by the production entrypoint for
      // whichever runtime this suite is running under.
      yield* showing(pty, "[exit]", REACH_MS);

      // A burst first, through this runtime's own reader. One chunk of input
      // becomes many decoded keystrokes, so a reader that handed its buffer over
      // without yielding would lose the tail of it — and losing the tail of what
      // somebody typed is the kind of defect a single keypress never shows.
      yield* pty.type(BURST);
      yield* showing(pty, BURST, LEAVE_MS);

      // Reached the way a person reaches it.
      yield* reaching(pty, "[exit]", LEAVE_MS);

      // Activated. And then nothing: no byte follows, and the pty's input stays
      // open, so the only thing that can end this command is the command.
      yield* pty.type("\r");

      const status = yield* ended(
        pty,
        LEAVE_MS,
        "[exit] was activated and no further byte was sent. That is the defect this row " +
          "exists for: teardown waited for a read nobody was going to satisfy.",
      );

      // Ordinary success.
      expect(status).toBe(0);

      const after = (yield* pty.shows()).join("\n");
      // The screen was given back: the REPL's own controls are gone from it. A
      // command that ended through a host exit primitive would skip the teardown
      // that leaves the alternate buffer, so its frame — and the location drawn
      // in that frame — would still be on the screen, which is why this is
      // asserted before the location is counted rather than instead of it.
      expect(after).not.toContain("[exit]");
      expect(after).not.toContain("[history]");

      // And exactly one location, which is the one the command printed for a
      // caller to come back with.
      const printed = after.match(/xmd:\/\/repl\//g) ?? [];
      expect(printed).toHaveLength(1);

      // And runnable exactly as printed: the location is one quoted argument of
      // an `xmd repl` command, so somebody who has just been handed their
      // terminal back can paste the line rather than assemble one. Under a line
      // that says what it is for, because the screen that would have explained it
      // has just gone.
      expect(after).toContain("Reopen this view with:");
      expect(after).toMatch(/xmd repl 'xmd:\/\/repl\/[^']+'/);
    });
  });

  it("UI2: Control-C finishes the command the same way, with no control reached", function* () {
    const line = cliShellCommand(["repl", "--deny-all"]);

    yield* scoped(function* (): Operation<void> {
      const home = yield* useTempDirectory("xmd-repl-pty-");
      const pty = yield* allocate(line, home);

      yield* showing(pty, "[exit]", REACH_MS);

      // The interrupt, from wherever focus happens to be: no Tab walk and no
      // control activated, because the point of this key is that it does not
      // need one. Raw mode has cleared ISIG by now, so this byte is the only
      // notice the command gets — nothing signals the process.
      yield* pty.type("\u0003");

      const status = yield* ended(
        pty,
        LEAVE_MS,
        "Control-C was the only notice the command got, and no further byte was sent.",
      );

      // Ordinary success, not a signal: a SIGINT that reached this process would
      // leave 130 here, and would not have run the teardown asserted below.
      expect(status).toBe(0);

      const after = (yield* pty.shows()).join("\n");
      expect(after).not.toContain("[exit]");
      expect(after).not.toContain("[history]");

      const printed = after.match(/xmd:\/\/repl\//g) ?? [];
      expect(printed).toHaveLength(1);

      // And runnable exactly as printed: the location is one quoted argument of
      // an `xmd repl` command, so somebody who has just been handed their
      // terminal back can paste the line rather than assemble one. Under a line
      // that says what it is for, because the screen that would have explained it
      // has just gone.
      expect(after).toContain("Reopen this view with:");
      expect(after).toMatch(/xmd repl 'xmd:\/\/repl\/[^']+'/);
    });
  });
});
