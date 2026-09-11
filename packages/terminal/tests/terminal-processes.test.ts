/**
 * Tier PO — process facts, and the POSIX host that establishes them
 * (architecture.md §Package ownership).
 *
 * A cancelled launch may not leave a child holding a terminal, and a cell may
 * not admit its next activity while the previous one still owns the screen.
 * Both are claims about processes, and neither can be made from a PID, an
 * elapsed timeout, or a signal that was merely sent. These rows are about the
 * neutral vocabulary for making them and the one host that answers it.
 *
 * They start a real child, because a stub that agreed with the implementation
 * would prove nothing about the kernel.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, sleep } from "effection";
import type { Operation } from "effection";
import { spawn as spawnChild } from "node:child_process";
import process from "node:process";
import type { ChildProcess } from "node:child_process";

import { TerminalGridPresentationError } from "../mod.ts";
import { TerminalGridPresentationError as LifecyclePresentationError } from "../lifecycle.ts";
import {
  deliverSignal,
  processReachable,
  ProcessObservationUnavailableError,
} from "../processes.ts";
import { installPosixProcessObservation } from "../posix.ts";

/** A child that stays until something stops it. */
function useChild(): Operation<ChildProcess> {
  return (function* (): Operation<ChildProcess> {
    const child = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    yield* ensure(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone, which is the state this was asking for.
      }
    });
    return child;
  })();
}

describe("Tier PO — process observation", () => {
  it("PO1: refuses when no host has installed one", function* () {
    let reachable: unknown;
    let delivery: unknown;
    yield* scoped(function* () {
      try {
        yield* processReachable(1);
      } catch (error) {
        reachable = error;
      }
      try {
        yield* deliverSignal(1, "SIGINT");
      } catch (error) {
        delivery = error;
      }
    });

    // A host that cannot observe processes says so rather than answering
    // "gone" for a child it never looked at.
    expect(reachable).toBeInstanceOf(ProcessObservationUnavailableError);
    expect(delivery).toBeInstanceOf(ProcessObservationUnavailableError);
  });

  it("PO2: the POSIX host reports a live child reachable and a stopped one gone", function* () {
    yield* installPosixProcessObservation();
    const child = yield* useChild();
    const pid = child.pid;
    expect(pid).toBeDefined();

    expect(yield* processReachable(pid!)).toBe(true);

    // A fatal signal the kernel accepted, and then the fact itself.
    expect(yield* deliverSignal(pid!, "SIGKILL")).toBe("delivered");
    while (yield* processReachable(pid!)) {
      yield* sleep(10);
    }
    expect(yield* processReachable(pid!)).toBe(false);

    // Gone between the decision and the delivery is the outcome the caller
    // was asking for, and is reported as such rather than as a refusal.
    expect(yield* deliverSignal(pid!, "SIGKILL")).toBe("absent");
  });
});

describe("Tier TG — one package, several facets", () => {
  it("TG25: a value two entrypoints publish is the same value", function* () {
    // A `catch` written against the root and one written against `./lifecycle`
    // classify the same error, because there is one definition of it.
    expect(LifecyclePresentationError).toBe(TerminalGridPresentationError);
    yield* sleep(0);
  });
});
