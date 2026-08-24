/**
 * A guarded journal across a whole document execution.
 *
 * The gate wraps the stream before `execute()`, so it sees the run from the
 * root component import onward. A rejection is asserted as the *absence of
 * the offending event*: the run keeps journaling afterwards, and the failure
 * it records is an append of its own.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile } from "@effectionx/fs";
import { ensure, until } from "effection";
import type { Operation } from "effection";
import { appendFile } from "node:fs/promises";
import { useTempDirectory } from "@executablemd/test-support/temp";
import * as path from "node:path";
import { DurableStreamTestServer } from "@durable-streams/server";
import {
  guardDurableStream,
  InMemoryStream,
  serializeDurableEvent,
  useHttpDurableStream,
} from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { inlineSource } from "../src/root-source.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * A synthetic GitHub token, format-realistic and assembled here at run time so
 * no usable-looking literal enters the repository and scanning this file finds
 * nothing. Nothing here reads an environment variable, a Git credential, or
 * user configuration.
 */
const CANARY = ["ghp", "_", ALPHABET.slice(0, 36)].join("");

/** A root whose own source carries the canary, so its import event does. */
const TAINTED = `# Tainted

The token is ${CANARY} and must never reach a backend.
`;

const DOCUMENT = `# Guarded

\`\`\`bash exec
echo first
\`\`\`

\`\`\`bash exec
echo second
\`\`\`
`;

/**
 * The same document in a region that prints.
 *
 * A rejected append is an ordinary failure where it happens, so reading what
 * the run journaled *after* one needs the document to carry on — which an
 * authored `<PrintErrors>` region asks for, and nothing else does.
 */
const RECOVERING = `<PrintErrors>\n\n${DOCUMENT}\n</PrintErrors>\n`;

/** A short, readable identity for an event in a timeline assertion. */
function label(event: DurableEvent): string {
  if (event.type === "yield") {
    return `yield(${event.description.type})`;
  }
  return `close(${event.coroutineId})`;
}

/**
 * The first exec block's event. Matching on the description rather than the
 * whole record matters: the root import journals the document source, so its
 * event carries every command in the document too.
 */
function isFirstExec(event: DurableEvent): boolean {
  return (
    event.type === "yield" &&
    event.description.type === "exec" &&
    serializeDurableEvent(event).includes("echo first")
  );
}

function rejecting(gated: string[], reject: (event: DurableEvent) => boolean) {
  // deno-lint-ignore require-yield
  return function* (event: DurableEvent): Operation<void> {
    gated.push(label(event));
    if (reject(event)) {
      throw new Error("gate rejected the event");
    }
  };
}

/** Records the shell commands a document actually ran. */
function* useRecordingExec(commands: string[]): Operation<void> {
  yield* API.Process.around({
    // deno-lint-ignore require-yield
    *exec([options]) {
      const script = (options.command[2] ?? "").trim();
      commands.push(script);
      return { exitCode: 0, stdout: `${script}\n`, stderr: "" };
    },
  });
}

function instrumented(timeline: string[], backend: DurableStream): DurableStream {
  return {
    readAll: () => backend.readAll(),
    *append(event: DurableEvent): Operation<void> {
      timeline.push(`backend:${label(event)}`);
      yield* backend.append(event);
    },
  };
}

/**
 * A fetch that asks the server to close the connection after each response.
 * The test owns the server's lifetime, and stop() waits for every open
 * connection — a pooled keep-alive connection held by the runtime's fetch
 * client keeps teardown waiting on the client pool's eviction clock.
 */
function closingFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("connection", "close");
  return globalThis.fetch(input, { ...init, headers });
}

/**
 * A file backend shaped like the CLI's FileStream: it appends the shared
 * NDJSON record and answers readAll() from the events it accepted, so a test
 * can compare the bytes on disk against exactly those events.
 */
function fileStream(journalPath: string): DurableStream {
  const accepted: DurableEvent[] = [];
  return {
    // deno-lint-ignore require-yield
    *readAll(): Operation<DurableEvent[]> {
      return accepted.map((event) => structuredClone(event));
    },
    *append(event: DurableEvent): Operation<void> {
      yield* until(appendFile(journalPath, serializeDurableEvent(event)));
      accepted.push(event);
    },
  };
}

describe("a guarded journal", () => {
  it("gates every live event, starting with the root component import", function* () {
    const timeline: string[] = [];
    const gated: string[] = [];
    const backend = new InMemoryStream();

    yield* useStubFs({ "README.md": DOCUMENT });
    yield* useRecordingExec([]);

    const stream = guardDurableStream(
      instrumented(timeline, backend),
      // deno-lint-ignore require-yield
      function* (event) {
        gated.push(label(event));
      },
    );

    const result = yield* yield* execute({ path: "README.md", stream });
    expect(result.ok).toBe(true);

    const persisted = backend.snapshot();
    expect(persisted.map(label)).toEqual([
      "yield(import_component)",
      "yield(exec)",
      "yield(exec)",
      "close(root)",
    ]);

    // Each event reached the gate before its backend append, in order.
    expect(gated).toEqual(persisted.map(label));
    expect(timeline).toEqual(persisted.map((event) => `backend:${label(event)}`));
  });

  it("rejects one event without stopping the run's remaining journal", function* () {
    const gated: string[] = [];
    const commands: string[] = [];
    const backend = new InMemoryStream();

    yield* useStubFs({ "README.md": RECOVERING });
    yield* useRecordingExec(commands);

    const stream = guardDurableStream(backend, rejecting(gated, isFirstExec));

    const result = yield* yield* execute({ path: "README.md", stream });

    // The block ran, but its result never came back through the effect — the
    // document rendered the append failure in place of the command's output.
    expect(commands).toEqual(["echo first", "echo second"]);
    expect(result.ok && result.value).toContain("<!-- ERROR: gate rejected the event -->");
    expect(result.ok && result.value).not.toContain("first");

    // Rejection is per event: the offending one is absent, everything after it
    // still persisted.
    const persisted = backend.snapshot();
    expect(persisted.some(isFirstExec)).toBe(false);
    expect(persisted.map(label)).toEqual(["yield(import_component)", "yield(exec)", "close(root)"]);
    expect(gated).toEqual(["yield(import_component)", "yield(exec)", "yield(exec)", "close(root)"]);
  });

  it("lets the run journal its own failure after a rejection", function* () {
    const gated: string[] = [];
    const backend = new InMemoryStream();

    yield* useStubFs({ "README.md": DOCUMENT });
    yield* useRecordingExec([]);

    const stream = guardDurableStream(
      backend,
      rejecting(
        gated,
        (event) => event.type === "yield" && event.description.type === "import_component",
      ),
    );

    const result = yield* yield* execute({ path: "README.md", stream });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toContain("gate rejected the event");

    // A rejected append does not imply an empty backend. The Close(err) the
    // failure produced is a separate append that crossed the gate on its own.
    const persisted = backend.snapshot();
    expect(persisted.map(label)).toEqual(["close(root)"]);
    const close = persisted[0]!;
    expect(close.type === "close" && close.result.status).toBe("err");
    expect(gated).toEqual(["yield(import_component)", "close(root)"]);
  });

  it("keeps the rejected event out of a file backend", function* () {
    const dir = yield* useTempDirectory("xmd-guarded-journal-");
    const journalPath = path.join(dir, "journal.jsonl");

    yield* useStubFs({ "README.md": RECOVERING });
    yield* useRecordingExec([]);

    const backend = fileStream(journalPath);
    const stream = guardDurableStream(backend, rejecting([], isFirstExec));

    yield* yield* execute({ path: "README.md", stream });

    const persisted = yield* backend.readAll();
    expect(persisted.some(isFirstExec)).toBe(false);
    expect(persisted.map(label)).toEqual(["yield(import_component)", "yield(exec)", "close(root)"]);

    // The bytes on disk are exactly the accepted events — the rejected one
    // left no partial record behind.
    expect(yield* readTextFile(journalPath)).toBe(persisted.map(serializeDurableEvent).join(""));
  });

  it("keeps the rejected event out of an HTTP backend", function* () {
    // port 0: the corpus runs under three runtimes concurrently, and a fixed
    // port lets those servers collide — macOS shares the listen port between
    // processes instead of refusing the second bind.
    const server = new DurableStreamTestServer({ port: 0 });
    const baseUrl = yield* until(server.start());
    yield* ensure(() => until(server.stop()));

    yield* useStubFs({ "README.md": RECOVERING });
    yield* useRecordingExec([]);

    const backend = yield* useHttpDurableStream({
      baseUrl,
      streamId: "guarded-journal",
      producerId: "guarded-journal-test",
      epoch: 1,
      fetch: closingFetch,
    });
    const stream = guardDurableStream(backend, rejecting([], isFirstExec));

    yield* yield* execute({ path: "README.md", stream });

    const persisted = yield* backend.readAll();
    expect(persisted.some(isFirstExec)).toBe(false);
    expect(persisted.map(label)).toEqual(["yield(import_component)", "yield(exec)", "close(root)"]);
  });
});

/**
 * The default scanner over each persistence backend (#199).
 *
 * These runs install no gate of their own. `execute()` selects its own
 * credential policy before the first live event, so what they exercise is the
 * real default scanner reaching a file and an HTTP backend — the memory case
 * is covered in `secret-detection.test.ts` and is not repeated here.
 */
describe("the default scanner over a persistence backend", () => {
  it("keeps a credential out of a file backend", function* () {
    const dir = yield* useTempDirectory("xmd-default-scanner-");
    const journalPath = path.join(dir, "journal.jsonl");
    const backend = fileStream(journalPath);

    const result = yield* yield* execute({ ...inlineSource(TAINTED), stream: backend });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.name).toBe("SecretDetectedError");

    // The diagnostic names the rule that fired and never the matched value.
    const error = result.ok === false ? result.error : new Error("unreachable");
    expect(error.message).not.toContain(CANARY);
    expect(error.stack ?? "").not.toContain(CANARY);

    // The offending import never reached the backend, and the close the
    // failure produced crossed the policy on its own.
    const persisted = yield* backend.readAll();
    expect(persisted.some((event) => event.type === "yield")).toBe(false);
    expect(persisted.map(label)).toEqual(["close(root)"]);
    const close = persisted[0]!;
    expect(close.type === "close" && close.result.status).toBe("err");
    expect(persisted.map(serializeDurableEvent).join("")).not.toContain(CANARY);

    // What is on disk is exactly those events, canary-free byte for byte.
    const bytes = yield* readTextFile(journalPath);
    expect(bytes).toBe(persisted.map(serializeDurableEvent).join(""));
    expect(bytes).not.toContain(CANARY);
  });

  it("keeps a credential out of an HTTP backend", function* () {
    // port 0: the corpus runs under three runtimes concurrently, and a fixed
    // port lets those servers collide — macOS shares the listen port between
    // processes instead of refusing the second bind.
    const server = new DurableStreamTestServer({ port: 0 });
    const baseUrl = yield* until(server.start());
    yield* ensure(() => until(server.stop()));

    const backend = yield* useHttpDurableStream({
      baseUrl,
      streamId: "default-scanner",
      producerId: "default-scanner-test",
      epoch: 1,
      fetch: closingFetch,
    });

    const result = yield* yield* execute({ ...inlineSource(TAINTED), stream: backend });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.name).toBe("SecretDetectedError");

    // The diagnostic names the rule that fired and never the matched value.
    const error = result.ok === false ? result.error : new Error("unreachable");
    expect(error.message).not.toContain(CANARY);
    expect(error.stack ?? "").not.toContain(CANARY);

    // Read back through the stream rather than from anything the run retained.
    const persisted = yield* backend.readAll();
    expect(persisted.some((event) => event.type === "yield")).toBe(false);
    expect(persisted.map(label)).toEqual(["close(root)"]);
    const close = persisted[0]!;
    expect(close.type === "close" && close.result.status).toBe("err");
    expect(persisted.map(serializeDurableEvent).join("")).not.toContain(CANARY);
  });
});
