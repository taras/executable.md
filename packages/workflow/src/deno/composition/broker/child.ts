/**
 * The broker: the one process that ever holds a credential value.
 *
 * It is started by the provider for one live invocation, acquires whatever the
 * invoking user's Git can prove for one exact repository, and then answers `get`
 * — and only `get` — to a caller that presents this lease's capability and asks
 * about that same repository. The provider that started it never receives a
 * username or a password; what it holds is a capability and a socket path.
 *
 * ## What it refuses
 *
 * A capability that is not this lease's, an operation that is not `get`, and a
 * locator that is not the one this lease was minted for. The last is what makes
 * a redirect fail closed: Git asks the shim about wherever it ended up, the shim
 * restates that, and a broker leased for somewhere else answers nothing.
 *
 * `store`, `erase`, `approve` and `reject` are not operations here. They are not
 * declined by a branch that could be changed — there is no code path that writes,
 * forgets or reports a credential anywhere.
 *
 * ## When it stops
 *
 * When its parent goes. The provider holds the child's standard input open for
 * the life of the lease, so end-of-file on it means the invocation is over — by
 * return, by refusal or by cancellation — and the process exits without waiting
 * to be signalled.
 */

import { Buffer } from "node:buffer";
import { createServer, type Socket } from "node:net";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { ACQUIRED, decodeQuestion, encodeLine, GET, READY, sameSecret } from "./protocol.ts";

/** What one broker was started to be about. */
export interface BrokerSubject {
  readonly endpoint: string;
  readonly capability: string;
  readonly protocol: string;
  readonly host: string;
  readonly path: string;
}

/** The subject these arguments name, or `undefined` when they name none. */
export function brokerSubject(argv: readonly string[]): BrokerSubject | undefined {
  const [endpoint, capability, protocol, host, path] = argv;
  if (
    endpoint === undefined ||
    capability === undefined ||
    protocol === undefined ||
    host === undefined ||
    path === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ endpoint, capability, protocol, host, path });
}

/** One credential, held here and nowhere else in this system. */
interface Held {
  readonly username: string;
  readonly password: string;
}

/**
 * What the invoking user's own Git can prove for this exact repository.
 *
 * `useHttpPath` is forced: without it Git withholds the path from every helper,
 * so an answer would be about the server and one acquisition would become the
 * identity for every repository on it. The answer is required to carry back the
 * exact protocol, host and path that were asked about — a helper is free to
 * rewrite those, and an answer about somewhere else has authorized nothing.
 *
 * Synchronous, deliberately: this runs once, before the socket exists, and the
 * process has nothing else to do until it has an answer or knows it has none.
 */
function acquire(subject: BrokerSubject): Held | undefined {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  environment["GIT_TERMINAL_PROMPT"] = "0";
  environment["GIT_ASKPASS"] = "";
  environment["SSH_ASKPASS"] = "";
  environment["LC_ALL"] = "C";

  const outcome = spawnSync("git", ["-c", "credential.useHttpPath=true", "credential", "fill"], {
    input:
      `protocol=${subject.protocol}\nhost=${subject.host}\n` +
      `${subject.path === "" ? "" : `path=${subject.path}\n`}\n`,
    env: environment,
    encoding: "utf8",
  });
  if (outcome.status !== 0 || typeof outcome.stdout !== "string") {
    return undefined;
  }

  const fields = new Map<string, string>();
  for (const line of outcome.stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      fields.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  const username = fields.get("username");
  const password = fields.get("password");
  if (username === undefined || password === undefined || password === "") {
    return undefined;
  }
  if (
    fields.get("protocol") !== subject.protocol ||
    fields.get("host") !== subject.host ||
    (subject.path !== "" && fields.get("path") !== subject.path)
  ) {
    return undefined;
  }
  return { username, password };
}

/** Whether this question is about the repository this lease was minted for. */
function about(
  subject: BrokerSubject,
  question: {
    readonly capability: string;
    readonly operation: string;
    readonly protocol: string;
    readonly host: string;
    readonly path: string;
  },
): boolean {
  return (
    sameSecret(question.capability, subject.capability) &&
    question.operation === GET &&
    question.protocol === subject.protocol &&
    question.host === subject.host &&
    question.path === subject.path
  );
}

/**
 * Serve one lease until the parent goes.
 *
 * One caller at a time. A lease belongs to one live provider invocation, whose
 * commands are sequential — an observation, then the mutation it decided — so a
 * second caller arriving while one is being answered is not that invocation and
 * is refused rather than queued.
 */
export function serveCredentialBroker(argv: readonly string[]): void {
  const subject = brokerSubject(argv);
  if (subject === undefined) {
    process.exit(2);
  }
  const held = acquire(subject);

  let busy = false;
  const server = createServer((socket: Socket) => {
    if (busy) {
      socket.end(encodeLine({}));
      return;
    }
    busy = true;
    let buffered = "";
    let answered = false;
    const answer = (value: unknown) => {
      if (!answered) {
        answered = true;
        socket.end(encodeLine(value));
      }
    };
    socket.on("error", () => answer({}));
    socket.on("close", () => {
      busy = false;
    });
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const end = buffered.indexOf("\n");
      if (end < 0) {
        return;
      }
      const question = decodeQuestion(buffered.slice(0, end));
      if (question === undefined || !about(subject, question) || held === undefined) {
        answer({});
        return;
      }
      answer({ username: held.username, password: held.password });
    });
  });

  server.listen(subject.endpoint, () => {
    // Order matters: a parent that reads `ready` may attach the lease, so it
    // must not do so before the socket can be connected to.
    process.stdout.write(`${READY}\n`);
    if (held !== undefined) {
      process.stdout.write(`${ACQUIRED}\n`);
    }
  });

  // End-of-file on standard input is the invocation ending, however it ended.
  process.stdin.on("end", () => {
    server.close();
    process.exit(0);
  });
  process.stdin.on("close", () => {
    server.close();
    process.exit(0);
  });
  process.stdin.resume();
}
