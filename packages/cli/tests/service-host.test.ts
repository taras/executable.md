import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn, suspend, until, withResolvers, type Operation } from "effection";
import { when } from "@effectionx/converge";
import { timebox } from "@effectionx/timebox";
import {
  ServiceProcessExitBeforeReadyError,
  ServiceProtocolDuplicateError,
  ServiceProtocolHostnameMismatchError,
  ServiceProtocolIncompatibleError,
  ServiceProtocolMalformedError,
  ServiceProtocolTokenMismatchError,
  ServiceStartupTimeoutError,
  ServiceUnexpectedExitError,
  startService,
} from "@executablemd/runtime";
import { inheritedEnvironment, installHostService } from "../src/service-host.ts";
import process from "node:process";

const TOKEN = "12".repeat(32);
const fixture = new URL("./fixtures/cooperative-service.mjs", import.meta.url).pathname;

function command(mode: string, nonce = "nonce"): string {
  return `node ${JSON.stringify(fixture)} ${mode} ${nonce}`;
}

function adapter(stdout: string[], stderr: string[]) {
  const decoder = new TextDecoder();
  return {
    token: () => TOKEN,
    environment: () => inheritedEnvironment(process.env),
    stdout(bytes: Uint8Array) {
      stdout.push(decoder.decode(bytes));
    },
    stderr(bytes: Uint8Array) {
      stderr.push(decoder.decode(bytes));
    },
  };
}

function fixturePids(stderr: string[]): number[] {
  return [...stderr.join("").matchAll(/service pid:(\d+)/g)].map((match) => Number(match[1]));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function* expectGone(pids: number[]): Operation<void> {
  const result = yield* timebox(2_000, () =>
    when(function* () {
      if (pids.some(isAlive)) {
        throw new Error("service child has not exited yet");
      }
    }),
  );
  expect(result.timeout).toBe(false);
}

describe("cooperative host service adapter", () => {
  it("starts real isolated services, forwards live output, and suppresses readiness", function* () {
    const stdout: string[] = [];
    const stderr: string[] = [];

    yield* scoped(function* () {
      yield* installHostService(adapter(stdout, stderr));
      const first = yield* startService({ command: command("normal", "first") });
      const second = yield* startService({ command: command("normal", "second") });

      expect(first.endpoint.port).not.toBe(second.endpoint.port);
      expect(Object.isFrozen(first.endpoint)).toBe(true);

      const firstResponse = yield* until(
        globalThis
          .fetch(`http://${first.endpoint.hostname}:${first.endpoint.port}`)
          .then((response) => response.text()),
      );
      const secondResponse = yield* until(
        globalThis
          .fetch(`http://${second.endpoint.hostname}:${second.endpoint.port}`)
          .then((response) => response.text()),
      );
      expect(firstResponse).toBe("service:first");
      expect(secondResponse).toBe("service:second");
    });

    expect(stdout.join("")).toContain("service stdout before readiness");
    expect(stdout.join("")).toContain("service stdout after readiness");
    expect(stderr.join("")).toContain("service stderr before readiness");
    expect(stderr.join("")).toContain("service stderr after readiness");
    expect(stdout.join("")).not.toContain("XMD_SERVICE_READY");
    expect(stdout.join("")).not.toContain(TOKEN);
    expect(fixturePids(stderr)).toHaveLength(2);
    yield* expectGone(fixturePids(stderr));
  });

  it("categorizes startup failures without exposing protocol records", function* () {
    const cases: Array<[string, { prototype: Error }, number]> = [
      ["exit-before", ServiceProcessExitBeforeReadyError, 2_000],
      ["malformed", ServiceProtocolMalformedError, 2_000],
      ["non-object", ServiceProtocolMalformedError, 2_000],
      ["incompatible", ServiceProtocolIncompatibleError, 2_000],
      ["forged", ServiceProtocolTokenMismatchError, 2_000],
      ["wrong-host", ServiceProtocolHostnameMismatchError, 2_000],
      ["extra-member", ServiceProtocolMalformedError, 2_000],
      ["partial-record", ServiceProtocolMalformedError, 2_000],
      ["non-cooperative", ServiceStartupTimeoutError, 75],
    ];

    for (const [mode, ErrorType, startupTimeout] of cases) {
      let failure: unknown;
      const stdout: string[] = [];
      const stderr: string[] = [];
      try {
        yield* scoped(function* () {
          yield* installHostService(adapter(stdout, stderr));
          yield* startService({ command: command(mode), startupTimeout });
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(ErrorType);
      expect(String(failure)).not.toContain(TOKEN);
      expect(JSON.stringify(failure)).not.toContain(TOKEN);
      expect(stdout.join("")).not.toContain("XMD_SERVICE_READY");
      yield* expectGone(fixturePids(stderr));
    }
  });

  it("cancels startup and releases the child before readiness", function* () {
    const pidPublished = withResolvers<number>();
    const decoder = new TextDecoder();
    let pid = 0;

    yield* scoped(function* () {
      yield* installHostService({
        ...adapter([], []),
        stderr(bytes: Uint8Array) {
          const match = /service pid:(\d+)/.exec(decoder.decode(bytes));
          if (match) {
            pidPublished.resolve(Number(match[1]));
          }
        },
      });
      yield* spawn(function* () {
        yield* startService({ command: command("delayed"), startupTimeout: 10_000 });
      });
      pid = yield* pidPublished.operation;
    });

    expect(pid).toBeGreaterThan(0);
    yield* expectGone([pid]);
  });

  it("fails the owning scope when a ready process exits or repeats readiness", function* () {
    const cases: Array<[string, { prototype: Error }]> = [
      ["exit-after", ServiceUnexpectedExitError],
      ["duplicate", ServiceProtocolDuplicateError],
    ];

    for (const [mode, ErrorType] of cases) {
      let failure: unknown;
      try {
        yield* scoped(function* () {
          yield* installHostService(adapter([], []));
          yield* startService({ command: command(mode) });
          yield* suspend();
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ErrorType);
      expect(String(failure)).not.toContain(TOKEN);
    }
  });
});
