import { Component } from "@executablemd/core/api";
import { API } from "@executablemd/runtime";
import { scoped, spawn, withResolvers } from "effection";
import { join } from "node:path";
import { directRecovery } from "./joined-response-recovery.ts";
import type { RecoveryFixture } from "./joined-response-recovery.ts";

export const cuts = [
  "after-reservation",
  "derivative-before-commit",
  "derivative-unknown",
  "after-derivative",
  "continuation-before-commit",
  "continuation-unknown",
  "confirmation-before-write",
  "confirmation-unknown",
  "native-return-unavailable",
];

export function interruptedRecovery(fixture: RecoveryFixture, cut: string) {
  return scoped(function* () {
    let injected = false;
    const writes: string[] = [];
    const laterWrites: string[] = [];
    function stop() {
      injected = true;
      throw new Error("ControlledRecoveryCut: " + cut);
    }
    yield* API.Files.around({
      *writeTextFile([input], next) {
        const path = join(input.cwd, input.path);
        if (path.startsWith(fixture.ticket + "/")) {
          writes.push(path);
          if (injected) {
            laterWrites.push(path);
          }
          if (
            !injected &&
            ((cut === "after-reservation" && path.endsWith("/request.json")) ||
              (cut === "after-derivative" && path.endsWith("/disposition.json")) ||
              (cut === "confirmation-before-write" && path.endsWith("/confirmation.json")))
          ) {
            stop();
          }
        }
        return yield* next(input);
      },
    });
    yield* API.Fs.around({
      *rename([source, destination], next) {
        const selected =
          destination.startsWith(fixture.ticket + "/") &&
          ((cut.startsWith("derivative-") &&
            /\/reconciliations\/[a-f0-9]{64}\/result.json$/.test(destination)) ||
            (cut.startsWith("continuation-") && destination.includes("/continuations/")) ||
            (cut === "confirmation-unknown" && destination.endsWith("/confirmation.json")));
        if (!injected && selected && cut.endsWith("before-commit")) {
          stop();
        }
        yield* next(source, destination);
        if (!injected && selected) {
          stop();
        }
      },
    });
    yield* Component.around({
      *expand([request], next) {
        yield* next(request);
        if (
          !injected &&
          cut === "native-return-unavailable" &&
          request.expansion.name === "Ticket.ReconcileResponse"
        ) {
          stop();
        }
      },
    });
    let returned: unknown;
    let failure: unknown;
    try {
      returned = yield* directRecovery(fixture);
    } catch (error) {
      failure = error;
    }
    return {
      injected,
      writes,
      laterWrites,
      returned,
      failure: failure instanceof Error ? failure.message : null,
    };
  });
}

export function contenders(fixture: RecoveryFixture) {
  return scoped(function* () {
    const reached = withResolvers<void>();
    const release = withResolvers<void>();
    let entered = false;
    let requests = 0;
    yield* API.Files.around({
      *writeTextFile([input], next) {
        if (
          join(input.cwd, input.path).startsWith(fixture.ticket + "/reconciliations/") &&
          input.path.endsWith("request.json")
        ) {
          requests++;
          if (!entered) {
            entered = true;
            reached.resolve();
            yield* release.operation;
          }
        }
        return yield* next(input);
      },
    });
    const first = yield* spawn(function* () {
      return yield* directRecovery(fixture);
    });
    let second;
    try {
      yield* reached.operation;
      second = yield* directRecovery(fixture);
    } finally {
      release.resolve();
    }
    const winner = yield* first;
    return { requests, winner, second };
  });
}
