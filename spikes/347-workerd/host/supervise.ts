import {
  ensure,
  type Operation,
  race,
  resource,
  sleep,
  spawn,
  type Stream,
} from "effection";
import { daemon, type Process } from "@effectionx/process";

export interface WorkerdServer {
  port: number;
  pid: number;
}

export interface WorkerdOptions {
  workerdPath: string;
  configPath: string;
  stateDir: string;
}

const STARTUP_TIMEOUT_MS = 15_000;

// workerd reports readiness by writing one JSON line per listening socket to
// the control fd; pointing the control fd at stdout gives readiness and the
// ephemeral port through the ordinary pipe.
export function useWorkerd(options: WorkerdOptions): Operation<WorkerdServer> {
  return resource(function* (provide) {
    Deno.mkdirSync(options.stateDir, { recursive: true });

    const process = yield* daemon(options.workerdPath, {
      arguments: [
        "serve",
        options.configPath,
        "--socket-addr",
        "http=127.0.0.1:0",
        "--control-fd=1",
        "--experimental",
        "--directory-path",
        `state=${options.stateDir}`,
      ],
    });

    // The default stdio middleware echoes child stdout to the host's stdout;
    // the control-fd line belongs to supervision, not to proof output.
    yield* process.around({
      *stdout() {},
    });

    // Registered after the daemon so it runs first at teardown: deliver
    // SIGTERM to workerd directly before the daemon's own group-kill and
    // pipe-EOF wait, which otherwise never reaches the child (see EVIDENCE).
    yield* ensure(function* () {
      try {
        Deno.kill(process.pid, "SIGTERM");
      } catch {
        return;
      }
    });

    const stderrTail: string[] = [];
    yield* spawn(function* () {
      yield* collect(process.stderr, stderrTail);
    });

    const outcome = yield* race([
      readListenPort(process),
      failStartup(process, stderrTail),
    ]);

    yield* provide({ port: outcome, pid: process.pid });
  });
}

function* readListenPort(process: Process): Operation<number> {
  let buffer = "";
  const decoder = new TextDecoder();
  const subscription = yield* process.stdout;
  let next = yield* subscription.next();
  while (!next.done) {
    buffer += typeof next.value === "string"
      ? next.value
      : decoder.decode(next.value);
    for (const line of buffer.split("\n")) {
      if (!line.includes('"event":"listen"')) {
        continue;
      }
      const message = JSON.parse(line);
      if (message.socket === "http" && typeof message.port === "number") {
        return message.port;
      }
    }
    next = yield* subscription.next();
  }
  throw new Error("workerd stdout closed before reporting a listening socket");
}

function* failStartup(
  process: Process,
  stderrTail: string[],
): Operation<number> {
  const outcome = yield* race([
    withKind("exit", process.join()),
    withKind("timeout", sleep(STARTUP_TIMEOUT_MS)),
  ]);
  const detail = stderrTail.join("").slice(-2000);
  if (outcome === "timeout") {
    throw new Error(
      `workerd did not report a listening socket within ${STARTUP_TIMEOUT_MS}ms\n${detail}`,
    );
  }
  throw new Error(`workerd exited during startup\n${detail}`);
}

function* withKind<T>(kind: string, operation: Operation<T>): Operation<string> {
  yield* operation;
  return kind;
}

function* collect(
  stream: Stream<Uint8Array, void>,
  into: string[],
): Operation<void> {
  const decoder = new TextDecoder();
  const subscription = yield* stream;
  let next = yield* subscription.next();
  while (!next.done) {
    into.push(
      typeof next.value === "string" ? next.value : decoder.decode(next.value),
    );
    next = yield* subscription.next();
  }
}
