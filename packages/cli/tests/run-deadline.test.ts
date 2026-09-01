/**
 * Tier RD — the run deadline (specs/acp-client-spec.md §Config).
 *
 * The deadline is the whole run's, so these cases drive `runXmd` in this
 * process: a subprocess can report that a run ended, but not that it never
 * read the document, never installed a provider, or resolved its deadline
 * once. The seam is the Fs Api — the read a run performs first — and it is a
 * gate rather than a delay: it suspends until the deadline cancels it, so
 * nothing here depends on how long anything takes.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, ensure, scoped, suspend, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { API, Config, Service, fetch, useHostFiles } from "@executablemd/runtime";
import { runXmd } from "../src/cli.ts";
import { SOURCE_UPGRADE } from "./support/upgrade-assembly.ts";

/**
 * The exit continuation `exit()` reaches for. `main()` installs one under this
 * name; a suite that drives `runXmd` directly installs its own so a command's
 * status is a value rather than a process exit.
 */
const ExitContext = createContext<(result: { status: number }) => Operation<void>>("exit");

interface Driven {
  status: number;
  stderr: string;
  /** Every path the run read, in order. */
  reads: string[];
  /** Teardown and reporting, in the order they happened. */
  events: string[];
  /** Whether the host's provider installer ran. */
  serviceInstalled: boolean;
  /** How many times the run resolved its contextual deadline. */
  deadlineReads: number;
}

interface DriveOptions {
  /** Installed around the run, as an embedding host would. */
  config?: { timeout?: number; timeoutExec?: number; timeoutFetch?: number };
  /** A read of a path containing this text suspends until the run is cancelled. */
  suspendOn?: string;
  /** Runs inside the run's own scope, where the run's configuration applies. */
  inScope?: () => Operation<void>;
}

function* drive(args: string[], options: DriveOptions = {}): Operation<Driven> {
  const reads: string[] = [];
  const events: string[] = [];
  let status = 0;
  let stderr = "";
  let serviceInstalled = false;
  let deadlineReads = 0;

  const written = console.error;
  return yield* scoped(function* () {
    yield* ensure(() => {
      console.error = written;
    });
    console.error = (...parts: unknown[]) => {
      const line = parts.map((part) => String(part)).join(" ");
      stderr += `${line}\n`;
      events.push(`reported: ${line}`);
    };

    yield* ExitContext.set(function* (result) {
      status = result.status;
    });

    // Outermost, so it observes every resolution the run performs — including
    // the one the command line's own installation answers.
    yield* Config.around({
      timeout: (_args, next) => {
        deadlineReads += 1;
        return next();
      },
    });

    if (options.config) {
      const { timeout, timeoutExec, timeoutFetch } = options.config;
      yield* Config.around(
        {
          ...(timeout === undefined ? {} : { timeout: () => timeout }),
          ...(timeoutExec === undefined ? {} : { timeoutExec: () => timeoutExec }),
          ...(timeoutFetch === undefined ? {} : { timeoutFetch: () => timeoutFetch }),
        },
        { at: "min" },
      );
    }

    yield* API.Fs.around({
      *readTextFile([target], next) {
        reads.push(target);
        if (options.suspendOn !== undefined && target.includes(options.suspendOn)) {
          // Cleanup registered before the wait, so cancelling the wait runs it.
          yield* ensure(() => {
            events.push("torn down");
          });
          yield* suspend();
        }
        return yield* next(target);
      },
    });

    yield* useHostFiles();

    yield* runXmd(
      args,
      function* () {
        serviceInstalled = true;
        yield* Service.around({
          *start() {
            throw new Error("the run started a service");
          },
        });
        if (options.inScope) {
          yield* options.inScope();
        }
      },
      SOURCE_UPGRADE,
    );

    return { status, stderr, reads, events, serviceInstalled, deadlineReads };
  });
}

function* useDocument<T>(body: string, run: (dir: string) => Operation<T>): Operation<T> {
  const dir = path.join(os.tmpdir(), `xmd-rd-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* writeTextFile(path.join(dir, "doc.md"), body);
    return yield* run(dir);
  });
}

/**
 * A listener that accepts a connection and answers nothing, so a request to it
 * ends only when something bounds it. Sockets are destroyed before the close,
 * because an open connection would otherwise hold the close open.
 */
function* useHangingServer(): Operation<string> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
  });
  yield* until(
    new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    }),
  );
  yield* ensure(function* () {
    yield* until(
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
    );
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}/`;
}

/** A document that would leave a file behind if anything expanded it. */
const AUTHORED = ['<File path="written.txt">effect</File>', ""].join("\n");

describe("Tier RD — the run deadline", () => {
  it("RD1: a malformed duration is refused before the run opens anything", function* () {
    const run = yield* drive(["run", "missing.md", "--timeout=not-a-duration", "--raw"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--timeout must be a duration");
    // Not "the file is missing": the grammar failed before the file mattered.
    expect(run.reads).toEqual([]);
  });

  it("RD1a: the same holds for --timeout-exec and --timeout-fetch", function* () {
    for (const flag of ["--timeout-exec", "--timeout-fetch"]) {
      const run = yield* drive(["run", "missing.md", `${flag}=nope`, "--raw"]);
      expect({ flag, status: run.status, reads: run.reads }).toEqual({
        flag,
        status: 1,
        reads: [],
      });
      expect(run.stderr).toContain(`${flag} must be a duration`);
    }
  });

  it("RD2: the deadline cancels a run suspended in its first read", function* () {
    yield* useDocument(AUTHORED, function* (dir) {
      const document = path.join(dir, "doc.md");
      const run = yield* drive(["run", document, "--timeout=200ms", "--raw"], {
        suspendOn: "doc.md",
      });

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("exceeded its --timeout");
      // Preparation is inside the deadline: this read is the props phase's.
      expect(run.reads).toEqual([document]);
    });
  });

  it("RD3: a run cancelled in preparation installs no provider and authors nothing", function* () {
    yield* useDocument(AUTHORED, function* (dir) {
      const run = yield* drive(["run", path.join(dir, "doc.md"), "--timeout=200ms", "--raw"], {
        suspendOn: "doc.md",
      });

      expect(run.status).toBe(1);
      expect(run.serviceInstalled).toBe(false);
      expect(yield* exists(path.join(dir, "written.txt"))).toBe(false);
    });
  });

  it("RD4: an enclosing deadline bounds a run that named none", function* () {
    yield* useDocument(AUTHORED, function* (dir) {
      const run = yield* drive(["run", path.join(dir, "doc.md"), "--raw"], {
        config: { timeout: 200 },
        suspendOn: "doc.md",
      });

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("exceeded its --timeout of 200ms");
    });
  });

  it("RD5: an invalid enclosing deadline fails before the first read", function* () {
    yield* useDocument(AUTHORED, function* (dir) {
      const run = yield* drive(["run", path.join(dir, "doc.md"), "--raw"], {
        config: { timeout: 0 },
      });

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("Config timeout must be a positive");
      expect(run.reads).toEqual([]);
    });
  });

  it("RD6: the command line's deadline outranks the enclosing one", function* () {
    yield* useDocument(AUTHORED, function* (dir) {
      const run = yield* drive(["run", path.join(dir, "doc.md"), "--timeout=200ms", "--raw"], {
        // An hour: only the command line's value can end this run.
        config: { timeout: 3_600_000 },
        suspendOn: "doc.md",
      });

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("exceeded its --timeout of 200ms");
    });
  });

  it("RD7: the run resolves its deadline exactly once", function* () {
    yield* useDocument(AUTHORED, function* (dir) {
      const run = yield* drive(["run", path.join(dir, "doc.md"), "--timeout=200ms", "--raw"], {
        suspendOn: "doc.md",
      });

      expect(run.deadlineReads).toBe(1);
    });
  });

  it("RD8: teardown completes before the timeout is reported", function* () {
    yield* useDocument(AUTHORED, function* (dir) {
      const run = yield* drive(["run", path.join(dir, "doc.md"), "--timeout=200ms", "--raw"], {
        suspendOn: "doc.md",
      });

      const reported = run.events.findIndex((event) => event.includes("exceeded its --timeout"));
      const teardown = run.events.indexOf("torn down");
      expect(teardown).toBeGreaterThan(-1);
      expect(reported).toBeGreaterThan(teardown);
    });
  });

  /**
   * The option has to reach a Fetch, not merely fail to reach an exec block.
   * The run's own scope is where its configuration applies, so the request is
   * made from the hook a host installs its providers in — against a listener
   * that answers nothing, so only the configured bound can end it.
   */
  it("RD9: --timeout-fetch bounds a Fetch performed inside the run", function* () {
    const url = yield* useHangingServer();
    yield* useDocument("# Doc\n", function* (dir) {
      let failure = "";
      yield* drive(["run", path.join(dir, "doc.md"), "--timeout-fetch=200ms", "--raw"], {
        *inScope() {
          try {
            yield* fetch(url);
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
          }
        },
      });

      expect(failure).toContain("timed out after 200ms");
    });
  });
});
