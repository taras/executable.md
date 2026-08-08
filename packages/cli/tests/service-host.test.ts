import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  createSignal,
  race,
  resource,
  scoped,
  spawn,
  suspend,
  until,
  withResolvers,
  type Operation,
} from "effection";
import { when } from "@effectionx/converge";
import { once } from "@effectionx/node/events";
import { timebox } from "@effectionx/timebox";
import { ProcessApi, Stdio, type Daemon } from "@effectionx/process";
import { withInvocation, InvocationTeardownError } from "@executablemd/core";
import {
  ServiceProcessExitBeforeReadyError,
  ServiceProtocolDuplicateError,
  ServiceProtocolHostnameMismatchError,
  ServiceProtocolIncompatibleError,
  ServiceProtocolMalformedError,
  ServiceProtocolTokenMismatchError,
  ServiceStartupTimeoutError,
  ServiceTeardownError,
  ServiceUnexpectedExitError,
  startService,
} from "@executablemd/runtime";
import {
  createProtocolObserver,
  inheritedEnvironment,
  installHostService,
} from "../src/service-host.ts";
import { createServer } from "node:http";
import process from "node:process";

const TOKEN = "12".repeat(32);
const fixture = new URL("./fixtures/attached-service.mjs", import.meta.url).pathname;

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

function occupy(port: number): Operation<void> {
  return resource(function* (provide) {
    const server = createServer((_request, response) => response.end("foreign"));
    const listening = once(server, "listening");
    const failed = once<[Error]>(server, "error");
    server.listen(port, "127.0.0.1");
    yield* race([
      listening,
      (function* () {
        const [error] = yield* failed;
        throw error;
      })(),
    ]);
    try {
      yield* provide();
    } finally {
      server.close();
    }
  });
}

function* useTeardownFailure(failure: Error): Operation<void> {
  yield* ProcessApi.around({
    *daemon() {
      return yield* resource(function* (provide) {
        const stdout = createSignal<Uint8Array, void>();
        const stderr = createSignal<Uint8Array, void>();
        const exited = withResolvers<{ code?: number; signal?: string }>();
        const process = {
          pid: 42,
          stdin: { send(_data: string) {} },
          stdout,
          stderr,
          *join() {
            return yield* exited.operation;
          },
          *expect() {
            return yield* exited.operation;
          },
          *around(...args: Parameters<typeof Stdio.around>): ReturnType<typeof Stdio.around> {
            return yield* Stdio.around(...args);
          },
          *[Symbol.iterator]() {
            yield* suspend();
          },
        } satisfies Daemon;
        const record = JSON.stringify({
          version: 1,
          token: TOKEN,
          hostname: "127.0.0.1",
          port: 41_234,
        });
        yield* Stdio.operations.stdout(new TextEncoder().encode(`XMD_SERVICE_READY:${record}\n`));
        try {
          yield* provide(process);
        } finally {
          stdout.close();
          stderr.close();
          throw failure;
        }
      });
    },
  });
}

describe("attached service host adapter", () => {
  it("forwards split ordinary bytes immediately and suppresses split handshake records", function* () {
    const forwarded: number[] = [];
    const endpoints: Array<{ hostname: string; port: number }> = [];
    const failures: Error[] = [];
    const observer = createProtocolObserver({
      token: TOKEN,
      ready: (endpoint) => endpoints.push(endpoint),
      fail: (error) => failures.push(error),
      forward: (bytes) => forwarded.push(...bytes),
    });
    const ordinary = Uint8Array.from([88, 77, 111, 114, 100, 105, 110, 97, 114, 121, 0, 255]);
    yield* observer.stdout(ordinary.slice(0, 2));
    yield* observer.stdout(ordinary.slice(2, 7));
    yield* observer.stdout(ordinary.slice(7));
    expect(forwarded).toEqual([...ordinary]);

    forwarded.length = 0;
    const record = new TextEncoder().encode(
      `\nXMD_SERVICE_READY:${JSON.stringify({
        version: 1,
        token: TOKEN,
        hostname: "127.0.0.1",
        port: 41_235,
      })}\n`,
    );
    yield* observer.stdout(record.slice(0, 5));
    yield* observer.stdout(record.slice(5, 19));
    yield* observer.stdout(record.slice(19, 47));
    yield* observer.stdout(record.slice(47));

    expect(forwarded).toEqual([10]);
    expect(endpoints).toEqual([{ hostname: "127.0.0.1", port: 41_235 }]);
    expect(failures).toEqual([]);

    yield* observer.stdout(record.slice(1));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(ServiceProtocolDuplicateError);
    expect(forwarded).toEqual([10]);
  });

  it("bounds and suppresses an invalid handshake candidate", function* () {
    const forwarded: number[] = [];
    const failures: Error[] = [];
    const observer = createProtocolObserver({
      token: TOKEN,
      ready() {},
      fail: (error) => failures.push(error),
      forward: (bytes) => forwarded.push(...bytes),
    });
    const secret = `${TOKEN}${"x".repeat(1_024)}`;
    const bytes = new TextEncoder().encode(`XMD_SERVICE_READY:${secret}\nordinary`);

    yield* observer.stdout(bytes);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(ServiceProtocolMalformedError);
    expect(new TextDecoder().decode(Uint8Array.from(forwarded))).toBe("ordinary");
    expect(String(failures[0])).not.toContain(TOKEN);
  });

  it("starts genuinely concurrent service attachments and suppresses handshake records", function* () {
    const stdout: string[] = [];
    const stderr: string[] = [];

    yield* scoped(function* () {
      yield* installHostService(adapter(stdout, stderr));
      const release = withResolvers<void>();
      const firstReady = withResolvers<{ hostname: string; port: number }>();
      const secondReady = withResolvers<{ hostname: string; port: number }>();
      const firstOwner = yield* spawn(function* () {
        const service = yield* startService({ command: command("normal", "first") });
        firstReady.resolve(service.endpoint);
        yield* release.operation;
      });
      const secondOwner = yield* spawn(function* () {
        const service = yield* startService({ command: command("normal", "second") });
        secondReady.resolve(service.endpoint);
        yield* release.operation;
      });
      const first = yield* firstReady.operation;
      const second = yield* secondReady.operation;

      expect(first.port).not.toBe(second.port);
      expect(Object.isFrozen(first)).toBe(true);

      const firstResponse = yield* until(
        globalThis
          .fetch(`http://${first.hostname}:${first.port}`)
          .then((response) => response.text()),
      );
      const secondResponse = yield* until(
        globalThis
          .fetch(`http://${second.hostname}:${second.port}`)
          .then((response) => response.text()),
      );
      expect(firstResponse).toBe("service:first");
      expect(secondResponse).toBe("service:second");
      release.resolve();
      yield* firstOwner;
      yield* secondOwner;
    });

    expect(stdout.join("")).toContain("service stdout before handshake");
    expect(stdout.join("")).toContain("service stdout after handshake");
    expect(stderr.join("")).toContain("service stderr before handshake");
    expect(stderr.join("")).toContain("service stderr after handshake");
    expect(stdout.join("")).not.toContain("XMD_SERVICE_READY");
    expect(stdout.join("")).not.toContain(TOKEN);
    expect(fixturePids(stderr)).toHaveLength(2);
    yield* expectGone(fixturePids(stderr));
  });

  it("categorizes startup failures without exposing handshake records", function* () {
    const cases: Array<[string, { prototype: Error }, number]> = [
      ["exit-before", ServiceProcessExitBeforeReadyError, 2_000],
      ["malformed", ServiceProtocolMalformedError, 2_000],
      ["non-object", ServiceProtocolMalformedError, 2_000],
      ["incompatible", ServiceProtocolIncompatibleError, 2_000],
      ["forged", ServiceProtocolTokenMismatchError, 2_000],
      ["wrong-host", ServiceProtocolHostnameMismatchError, 2_000],
      ["extra-member", ServiceProtocolMalformedError, 2_000],
      ["partial-record", ServiceProtocolMalformedError, 2_000],
      ["not-handshake-compatible", ServiceStartupTimeoutError, 75],
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

  it("cancels startup and releases the child before the handshake", function* () {
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

  it("cancels after the handshake and releases the child listener", function* () {
    const stderr: string[] = [];
    const ready = withResolvers<{ hostname: string; port: number }>();
    let endpoint = { hostname: "127.0.0.1", port: 0 };

    yield* scoped(function* () {
      yield* installHostService(adapter([], stderr));
      const owner = yield* spawn(function* () {
        const service = yield* startService({ command: command("normal", "cancel-ready") });
        ready.resolve(service.endpoint);
        yield* suspend();
      });
      endpoint = yield* ready.operation;
      const response = yield* until(
        globalThis
          .fetch(`http://${endpoint.hostname}:${endpoint.port}`)
          .then((result) => result.text()),
      );
      expect(response).toBe("service:cancel-ready");
      yield* owner.halt();
      yield* expectGone(fixturePids(stderr));
      yield* scoped(() => occupy(endpoint.port));
    });
  });

  it("forwards unterminated ordinary stdout while the attached service is active", function* () {
    const stdout: string[] = [];
    const stderr: string[] = [];

    yield* scoped(function* () {
      yield* installHostService(adapter(stdout, stderr));
      yield* startService({ command: command("unterminated-live-output") });
      const observed = yield* timebox(2_000, () =>
        when(function* () {
          if (!stderr.join("").includes("unterminated live output written")) {
            throw new Error("fixture has not written its unterminated stdout yet");
          }
        }),
      );
      expect(observed.timeout).toBe(false);
      expect(stdout.join("")).toContain("unterminated-live-output");
    });
  });

  it("translates an observable process teardown failure", function* () {
    const planted = new Error("injected process teardown failure");
    let failure: unknown;
    try {
      yield* scoped(function* () {
        yield* installHostService(adapter([], []));
        yield* useTeardownFailure(planted);
        yield* startService({ command: "injected-service" });
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ServiceTeardownError);
    if (!(failure instanceof ServiceTeardownError)) {
      throw new Error("expected ServiceTeardownError");
    }
    expect(failure.cause).toBe(planted);
  });

  it("preserves an execution failure beside a translated teardown failure", function* () {
    const execution = new Error("active execution failure");
    const teardown = new Error("injected process teardown failure");
    let failure: unknown;
    try {
      yield* scoped(function* () {
        yield* installHostService(adapter([], []));
        yield* useTeardownFailure(teardown);
        yield* withInvocation(function* () {
          yield* startService({ command: "injected-service" });
          throw execution;
        });
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error("expected AggregateError");
    }
    expect(failure.errors[0]).toBe(execution);
    expect(failure.errors[1]).toBeInstanceOf(InvocationTeardownError);
    const invocationTeardown = failure.errors[1];
    if (!(invocationTeardown instanceof InvocationTeardownError)) {
      throw new Error("expected InvocationTeardownError");
    }
    expect(invocationTeardown.causes).toHaveLength(1);
    expect(invocationTeardown.causes[0]).toBeInstanceOf(ServiceTeardownError);
    const serviceTeardown = invocationTeardown.causes[0];
    if (!(serviceTeardown instanceof ServiceTeardownError)) {
      throw new Error("expected ServiceTeardownError");
    }
    expect(serviceTeardown.cause).toBe(teardown);
  });

  it("fails the owning scope when an attached process exits or repeats the handshake", function* () {
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
