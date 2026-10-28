import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { cliCommand, cliShellCommand, shellQuote } from "@executablemd/test-support/launch";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { Agent, Execution } from "@executablemd/core";
import { API } from "@executablemd/runtime";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, lstat, mkdtemp, readdir, realpath, rmdir, symlink, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { once } from "@effectionx/node/events";
import { Writable } from "node:stream";
import {
  ensure,
  Ok,
  race,
  resource,
  scoped,
  spawn,
  sleep,
  suspend,
  until,
  withResolvers,
} from "effection";
import type { Operation } from "effection";
import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";
import { useAcpxProvider } from "../../acp/src/provider.ts";
import { createAcpRuntime, createRuntimeStore } from "../../acp/src/acpx-runtime.ts";
import type { AcpRuntimeHandle, AcpRuntimeTurnResult } from "../../acp/src/acpx-runtime.ts";
import {
  useHarness,
  useTemporary,
  records,
  AGENT,
} from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { rootReads } from "../src/repl/sidekick/requests.ts";
import { createSidekickAdmission, useSidekickDispatch } from "../src/repl/sidekick/dispatch.ts";
import { useSidekickAttachment } from "../src/sidekick-acp/server.ts";
import { requestAttachment } from "../src/sidekick-acp/client.ts";
import { usePosixSidekickTransport } from "../src/sidekick-acp/posix.ts";
import {
  recordingTerminal,
  untilDrawn,
  useMountedHost,
  MOUNTED_AGENT,
} from "./fixtures/repl/issue-883/mounted-program.ts";
import { runReplProgram } from "../src/repl/program.ts";
import { ReplHost } from "../src/repl/host.ts";
import { PAIRED_DIRECTORY, parseEntryRecords } from "../src/repl/sidekick/history.ts";
import { AGENT_PROMPT } from "@executablemd/core/host";
import {
  Descriptor,
  MAX_FRAME,
  SidekickTransport,
  referenceText,
} from "../src/sidekick-acp/protocol.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const attachResult = z.object({ attachment: z.string() }).strict();
const message = z
  .object({ execution: z.string(), conversation: z.string(), id: z.string() })
  .strict();
const statusSchema = z
  .object({ busy: z.boolean(), messages: z.array(message), questionPending: z.boolean() })
  .passthrough();
const exchangeSchema = z
  .object({
    message: message.nullable(),
    ending: z.object({ joined: z.boolean(), outcome: z.string() }).passthrough().nullable(),
    output: z.string(),
  })
  .passthrough();
function fills(source: string): string {
  return [
    '<Let as="code" select="code">',
    "```xmd",
    source,
    "```",
    "</Let>",
    "<REPL.EntryInput>{code}</REPL.EntryInput>",
  ].join("\n");
}
function* world(options: Parameters<typeof useHarness>[1] = {}) {
  yield* usePosixSidekickTransport(process.platform);
  const home = yield* until(realpath(yield* useTemporary("xmd-sidekick-client-")));
  yield* until(chmod(home, 0o700));
  const held = yield* useHarness(undefined, options);
  const selected = yield* held.owner.select(AGENT);
  if (!selected.ok) {
    throw selected.error;
  }
  held.fake.script({ reply: "<Output>Established fixture conversation.</Output>" });
  const established = yield* held.owner.message("Establish this isolated fixture conversation.");
  if (!established.ok) {
    throw established.error;
  }
  const baselineTurns = held.fake.prompts.length;
  const admission = createSidekickAdmission();
  const dispatch = yield* useSidekickDispatch({
    owner: held.owner,
    admission,
    execution: held.execution.id,
    workspace: held.workspace,
    changed() {},
  });
  const path = join(home, "attachment.json");
  const descriptor = yield* useSidekickAttachment(path, {
    owner: held.owner,
    dispatch,
    reads: rootReads(held.session, held.profile),
    execution: held.execution.id,
    cwd: held.workspace,
  });
  const launch = cliCommand(["sidekick", "acp", "--attach", path]);
  console.log(
    JSON.stringify({
      kind: "attachment-client-inputs",
      cwd: held.workspace,
      descriptor,
      bridge: launch,
      home,
      stores: join(home, "embedded-store"),
    }),
  );
  return { held, path, home, descriptor, launch, admission, dispatch, baselineTurns };
}
type World = ReturnType<typeof world> extends Operation<infer T> ? T : never;
function sdk(
  world: World,
): Operation<{ connection: acp.ClientConnection; updates: acp.SessionNotification[] }> {
  return resource(function* (provide) {
    let child: ChildProcess | undefined;
    const closed = withResolvers<void>();
    const onClose = () => closed.resolve();
    const onError = () => {
      /* Only close proves that child cleanup has finished. */
    };
    yield* ensure(function* () {
      if (child !== undefined) {
        try {
          child.kill();
          yield* closed.operation;
        } finally {
          child.off("close", onClose);
          child.off("error", onError);
        }
      }
    });
    child = spawnChild(world.launch.command, world.launch.arguments, {
      cwd: world.held.workspace,
      env: { PATH: process.env.PATH, DENO_DIR: process.env.DENO_DIR, HOME: world.home },
      stdio: ["pipe", "pipe", "inherit"],
    });
    child.on("close", onClose);
    child.on("error", onError);
    if (child.stdin === null || child.stdout === null) {
      throw new Error("Bridge stdio missing.");
    }
    const stdout = child.stdout;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let ended = false;
    const input = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel() {
        ended = true;
      },
    });
    const data = (bytes: Uint8Array) => {
      if (!ended) {
        controller?.enqueue(new Uint8Array(bytes));
      }
    };
    const end = () => {
      if (!ended) {
        ended = true;
        controller?.close();
      }
    };
    const updates: acp.SessionNotification[] = [];
    const connection = acp
      .client({ name: "sidekick-protocol-fixture" })
      .onNotification("session/update", (ctx) => {
        updates.push(ctx.params);
      })
      .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), input));
    try {
      stdout.on("data", data);
      stdout.on("end", end);
      const initialized = yield* until(
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {},
        }),
      );
      expect(initialized.protocolVersion).toBe(1);
      expect(initialized.agentCapabilities?.loadSession).toBe(true);
      yield* provide({ connection, updates });
    } finally {
      ended = true;
      stdout.off("data", data);
      stdout.off("end", end);
      connection.close();
    }
  });
}
function* deadline(what: string): Operation<never> {
  yield* sleep(5000);
  throw new Error(what);
}
function* refused(operation: Operation<unknown>): Operation<void> {
  let error: unknown;
  try {
    yield* operation;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
}
function* clientIdentity() {
  // Resolved the way production resolves it, from the package that declares it.
  // `packages/acp` is ACPX's declarer, and each runtime's own installer places
  // it differently: Deno's links it at the repository root, pnpm's beside that
  // declarer, Bun's somewhere else again. A path built from the root happens to
  // exist under two of those layouts and not the third, so the resolver answers
  // instead of a guess.
  const fromDeclarer = createRequire(join(ROOT, "packages/acp/package.json"));
  const packagePath = yield* until(realpath(fromDeclarer.resolve("acpx/package.json")));
  const info = z
    .object({ version: z.literal("0.12.0") })
    .passthrough()
    .parse(JSON.parse(yield* readTextFile(packagePath)));
  const cli = join(dirname(packagePath), "dist/cli.js");
  const runtime = join(dirname(packagePath), "dist/runtime.js");
  const upstream = join(ROOT, "packages/acp/vendor/acpx/upstream/runtime.js");
  expect(yield* readTextFile(runtime)).toBe(yield* readTextFile(upstream));
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  console.log(
    JSON.stringify({
      kind: "actual-client-provenance",
      releasedVersion: info.version,
      releaseCommit: "6a24a546d2349cbe71ed032d52d07cab611e320c",
      packagePath,
      cli,
      cliSha256: digest(yield* readTextFile(cli)),
      releasedRuntimeSha256: digest(yield* readTextFile(runtime)),
      embeddedRuntimeSha256: digest(
        yield* readTextFile(join(ROOT, "packages/acp/vendor/acpx/generated/runtime.js")),
      ),
      provenance: digest(yield* readTextFile(join(ROOT, "packages/acp/vendor/acpx/PROVENANCE.md"))),
    }),
  );
  return cli;
}

describe("minimal live Sidekick ACP attachment", () => {
  it("A1/A2: released acpx0.12 delegates serially through the real bridge and bounded reads stay passive", function* () {
    const one = yield* world();
    const cli = yield* clientIdentity();
    const target = "98a72388dc63f4b72a0a5e84960a2667d1a1acdb";
    const code = '<Output><Json value={{outcome:"pass",revision:"' + target + '"}} /></Output>\n';
    one.held.fake.script({
      reply: fills(code) + "\n<REPL.Submit />\n<Output>Review entry admitted.</Output>",
    });
    one.held.fake.script({ reply: "<Output>Review exchange joined.</Output>" });
    one.held.fake.script({ reply: "<Output>Second released request.</Output>" });
    for (const text of [
      "review exact fixture revision " + target,
      "second serial released request",
    ]) {
      const args = [
        cli,
        "--cwd",
        one.descriptor.cwd,
        "--format",
        "json",
        "--agent",
        cliShellCommand(["sidekick", "acp", "--attach", one.path]),
        "exec",
        text,
      ];
      console.log(
        JSON.stringify({
          kind: "released-client-argv",
          command: "node",
          arguments: args,
          home: one.home,
        }),
      );
      const result = yield* exec("node", {
        arguments: args,
        cwd: one.held.workspace,
        env: { HOME: one.home, PATH: process.env.PATH ?? "", DENO_DIR: process.env.DENO_DIR ?? "" },
      }).join();
      if (result.code !== 0) {
        throw new Error("Released ACPX failed: " + result.stderr + result.stdout);
      }
      expect(result.stdout).toContain(
        text.startsWith("second") ? "Second released request." : "Review exchange joined.",
      );
    }
    expect(one.held.fake.prompts).toHaveLength(one.baselineTurns + 3);
    const head = one.held.session.reading(undefined);
    if (!head.ok) {
      throw head.error;
    }
    expect(head.value.model.entries[0]?.source).toBe(code);
    console.log(
      JSON.stringify({
        kind: "controlled-product-output",
        output: head.value.model.entries[0]?.terminal?.output,
      }),
    );
    expect(
      JSON.parse(
        (head.value.model.entries[0]?.terminal?.output ?? "").match(/\{[\s\S]*\}/)?.[0] ?? "null",
      ),
    ).toEqual({ outcome: "pass", revision: target });
    yield* refused(requestAttachment(one.path, { method: "entry", entry: 1, view: "prompt" }));
    const before = yield* records(one.held.execution);
    const status = statusSchema.parse(yield* requestAttachment(one.path, { method: "status" }));
    expect(status.busy).toBe(false);
    const reference = status.messages.at(-1);
    if (reference === undefined) {
      throw new Error("No acknowledged message identity.");
    }
    const read = exchangeSchema.parse(
      yield* requestAttachment(one.path, { method: "message", reference, follow: true }),
    );
    expect(read.ending?.joined).toBe(true);
    const views: ("source" | "output" | "journal" | "prompt")[] = ["source", "output", "journal"];
    for (const view of views) {
      const result = yield* requestAttachment(one.path, { method: "entry", entry: 1, view });
      expect(result).toHaveProperty("entry", 1);
    }
    const launch = cliCommand([
      "sidekick",
      "read",
      "--attach",
      one.path,
      "message",
      referenceText(reference),
      "--follow",
    ]);
    const actual = yield* exec(launch.command, {
      arguments: launch.arguments,
      cwd: one.held.workspace,
      env: { HOME: one.home, PATH: process.env.PATH ?? "", DENO_DIR: process.env.DENO_DIR ?? "" },
    }).join();
    expect(actual.code).toBe(0);
    expect(actual.stdout).toContain('"joined":true');
    expect(yield* records(one.held.execution)).toEqual(before);
    expect(one.held.fake.prompts).toHaveLength(one.baselineTurns + 3);
  });

  it("A1/A3: the actual embedded provider keeps serial attachment identity and completing RPC metadata", function* () {
    const one = yield* world();
    yield* clientIdentity();
    const review =
      '<Output><Json value={{outcome:"pass",revision:"98a72388dc63f4b72a0a5e84960a2667d1a1acdb"}} /></Output>\n';
    one.held.fake.script({ reply: fills(review) + "\n<REPL.Submit/>" });
    one.held.fake.script({ reply: "<Output>Embedded first.</Output>" });
    one.held.fake.script({ reply: "<Output>Embedded second.</Output>" });
    yield* scoped(function* () {
      yield* API.Env.around({
        *cwd() {
          return one.descriptor.cwd;
        },
      });
      const endings: AcpRuntimeTurnResult[] = [];
      let actual: ReturnType<typeof createAcpRuntime> | undefined;
      let handle: AcpRuntimeHandle | undefined;
      const command = cliShellCommand(["sidekick", "acp", "--attach", one.path]);
      const provider = yield* useAcpxProvider(
        { defaultAgent: "attached-sidekick", permissionMode: "deny-all" },
        {
          agentRegistry: { resolve: () => command, list: () => ["attached-sidekick"] },
          sessionStore: createRuntimeStore({ stateDir: join(one.home, "embedded-store") }),
          createRuntime(options) {
            const runtime = createAcpRuntime({
              ...options,
              timeoutMs: 20000,
              agentProcessEnv: { HOME: one.home, DENO_DIR: process.env.DENO_DIR ?? "" },
            });
            actual = runtime;
            const traced = <T>(name: string, result: Promise<T>) => {
              console.log("embedded " + name + " start");
              return result.then(
                (value) => {
                  console.log("embedded " + name + " done");
                  return value;
                },
                (error) => {
                  console.log("embedded " + name + " failed " + String(error));
                  throw error;
                },
              );
            };
            return {
              doctor: () => traced("doctor", runtime.doctor()),
              ensureSession: (input) =>
                traced(
                  "ensure",
                  runtime.ensureSession(input).then((value) => {
                    handle = value;
                    return value;
                  }),
                ),
              runTurn: runtime.runTurn.bind(runtime),
              cancel: (input) => traced("cancel", runtime.cancel(input)),
              close: (input) => traced("close", runtime.close(input)),
              startTurn(request) {
                console.log("embedded turn start");
                const turn = runtime.startTurn(request);
                void turn.result.then((result) => {
                  console.log("embedded turn result " + result.status);
                  endings.push(result);
                });
                return turn;
              },
            };
          },
        },
      );
      console.log(
        JSON.stringify({
          kind: "embedded-client-inputs",
          command,
          cwd: one.held.workspace,
          stateDir: join(one.home, "embedded-store"),
          runtime: join(ROOT, "packages/acp/vendor/acpx/generated/runtime.js"),
        }),
      );
      yield* Agent.around({
        *agent([name]) {
          return yield* provider.agent(name);
        },
      });
      console.log("embedded session resolving");
      const session = yield* provider.session("one-attachment");
      console.log("embedded session resolved");
      for (const text of ["first embedded request", "second embedded request"]) {
        yield* scoped(function* () {
          const stream = yield* provider.promptStream(text, { session, timeout: 20000 });
          let next = yield* stream.next();
          while (!next.done) {
            next = yield* stream.next();
          }
          expect(next.value).toContain(
            text.startsWith("first") ? "Embedded first." : "Embedded second.",
          );
        });
        if (text.startsWith("first")) {
          if (actual === undefined || handle === undefined) {
            throw new Error("Actual client handle missing.");
          }
          const before = yield* records(one.held.execution);
          const turns = one.held.fake.prompts.length;
          yield* until(actual.close({ handle, reason: "controlled passive reconnect" }));
          yield* until(actual.getStatus({ handle }));
          expect(yield* records(one.held.execution)).toEqual(before);
          expect(one.held.fake.prompts).toHaveLength(turns);
        }
      }
      const reviewed = one.held.session.reading(undefined);
      if (!reviewed.ok) {
        throw reviewed.error;
      }
      expect(reviewed.value.model.entries[0]?.source).toBe(review);
      expect(JSON.parse(reviewed.value.model.entries[0]?.terminal?.output ?? "null")).toEqual({
        outcome: "pass",
        revision: "98a72388dc63f4b72a0a5e84960a2667d1a1acdb",
      });
      expect(endings).toHaveLength(2);
      for (const ending of endings) {
        expect(ending.status).toBe("completed");
        if (ending.status !== "completed") {
          throw new Error("Embedded completing response missing.");
        }
        expect(ending._meta).toHaveProperty(["executablemd.sidekick-exchange/v1"]);
      }
      expect(one.held.fake.prompts).toHaveLength(one.baselineTurns + 3);
      expect(one.held.owner.reading.ok && one.held.owner.reading.value.active).toBe(
        one.descriptor.conversation,
      );
    });
  });

  it("A3/A5: real socket EOF detaches observation; exact follow/cancel/close join without resend", function* () {
    const one = yield* world();
    const attached = attachResult.parse(
      yield* requestAttachment(one.path, { method: "attach", cwd: one.descriptor.cwd }),
    );
    one.held.fake.script({ reply: "<Output>held producer</Output>", held: true });
    const observer = yield* spawn(() =>
      requestAttachment(one.path, {
        method: "prompt",
        attachment: attached.attachment,
        text: "held",
      }),
    );
    yield* one.held.fake.startedTurns(one.baselineTurns + 1);
    yield* observer.halt();
    expect(one.held.owner.busy).toBe(true);
    expect(one.admission.message).not.toBe(undefined);
    const read = statusSchema.parse(yield* requestAttachment(one.path, { method: "status" }));
    const reference = read.messages.at(-1);
    if (reference === undefined) {
      throw new Error("No saved held-message identity.");
    }
    const loaded = yield* requestAttachment(one.path, {
      method: "load",
      attachment: attached.attachment,
      cwd: one.descriptor.cwd,
    });
    expect(loaded).toHaveProperty("attachment", attached.attachment);
    const followed = yield* spawn(() =>
      requestAttachment(one.path, { method: "message", reference, follow: true }),
    );
    yield* requestAttachment(one.path, { method: "cancel", attachment: attached.attachment });
    expect(exchangeSchema.parse(yield* followed).ending?.joined).toBe(true);
    expect(one.held.owner.busy).toBe(false);
    expect(one.held.fake.prompts).toHaveLength(one.baselineTurns + 1);
    yield* requestAttachment(one.path, { method: "close", attachment: attached.attachment });
    yield* refused(
      requestAttachment(one.path, {
        method: "load",
        attachment: attached.attachment,
        cwd: one.descriptor.cwd,
      }),
    );
    expect(one.held.owner.reading.ok && one.held.owner.reading.value.active).toBe(
      one.descriptor.conversation,
    );
  });

  it("A4: ACP cannot clear the composer or replace a held human draft", function* () {
    let acknowledgements = 0;
    const one = yield* world({
      state: (initial) =>
        Object.freeze({
          ...initial,
          message: "human unsent",
          draft: "human held",
          takenOver: true,
        }),
      *acknowledge() {
        acknowledgements += 1;
      },
    });
    const acknowledgementsBefore = acknowledgements;
    const attached = attachResult.parse(
      yield* requestAttachment(one.path, { method: "attach", cwd: one.descriptor.cwd }),
    );
    one.held.fake.script({ reply: fills("replacement") + "\n<REPL.Submit />" });
    one.held.fake.script({ reply: "<Output>Human ownership retained.</Output>" });
    yield* requestAttachment(one.path, {
      method: "prompt",
      attachment: attached.attachment,
      text: "try controls",
    });
    expect(one.held.state().message).toBe("human unsent");
    expect(one.held.state().draft).toBe("human held");
    expect(acknowledgements).toBe(acknowledgementsBefore);
    expect(one.held.fake.prompts[one.baselineTurns + 1]).toContain("draft");
  });

  it("A5/A6: SDK load fences fallback-new and advertised close releases only its mapping", function* () {
    const one = yield* world();
    const first = yield* scoped(function* () {
      const { connection } = yield* sdk(one);
      return yield* until(
        connection.agent.request(acp.methods.agent.session.new, {
          cwd: one.descriptor.cwd,
          mcpServers: [],
        }),
      );
    });
    const before = yield* records(one.held.execution);
    yield* scoped(function* () {
      const { connection } = yield* sdk(one);
      yield* until(
        connection.agent.request(acp.methods.agent.session.load, {
          sessionId: first.sessionId,
          cwd: one.descriptor.cwd,
          mcpServers: [],
        }),
      );
      yield* until(
        connection.agent.request(acp.methods.agent.session.close, { sessionId: first.sessionId }),
      );
    });
    yield* scoped(function* () {
      const { connection } = yield* sdk(one);
      yield* refused(
        until(
          connection.agent.request(acp.methods.agent.session.load, {
            sessionId: first.sessionId,
            cwd: one.descriptor.cwd,
            mcpServers: [],
          }),
        ),
      );
      yield* refused(
        until(
          connection.agent.request(acp.methods.agent.session.new, {
            cwd: one.descriptor.cwd,
            mcpServers: [],
          }),
        ),
      );
    });
    expect(yield* records(one.held.execution)).toEqual(before);
    expect(one.held.fake.prompts).toHaveLength(one.baselineTurns + 0);
  });

  it("A6: descriptors, frames and switched pairs refuse without provider work", function* () {
    const one = yield* world();
    const before = yield* records(one.held.execution);
    yield* refused(
      useSidekickAttachment(one.path, {
        owner: one.held.owner,
        dispatch: one.dispatch,
        reads: rootReads(one.held.session, one.held.profile),
        execution: one.descriptor.execution,
        cwd: one.descriptor.cwd,
      }),
    );
    yield* until(chmod(one.path, 0o644));
    yield* refused(requestAttachment(one.path, { method: "status" }));
    yield* until(chmod(one.path, 0o600));
    const linked = join(one.home, "linked.json");
    yield* until(symlink(one.path, linked));
    yield* refused(requestAttachment(linked, { method: "status" }));
    yield* scoped(function* () {
      const host = yield* SidekickTransport.expect();
      const { wire } = yield* host.connect(one.path);
      yield* wire.send({ id: 0, request: { method: "hello", descriptor: one.descriptor } });
      yield* wire.receive();
      yield* wire.send({ id: 1, request: { method: "answer", key: "not-authority", value: {} } });
      yield* refused(wire.receive());
    });
    yield* scoped(function* () {
      const { wire } = yield* (yield* SidekickTransport.expect()).connect(one.path);
      yield* refused(wire.send({ text: "x".repeat(MAX_FRAME) }));
    });
    yield* refused(requestAttachment(one.path, { method: "attach", cwd: one.home }));
    expect(yield* records(one.held.execution)).toEqual(before);
    expect(one.held.fake.prompts).toHaveLength(one.baselineTurns + 0);
  });
  it("A4: a current question stays pending until its exact existing UI owner answers", function* () {
    const one = yield* world();
    const attached = attachResult.parse(
      yield* requestAttachment(one.path, { method: "attach", cwd: one.descriptor.cwd }),
    );
    const shape = {
      type: "object",
      properties: { decision: { type: "string", enum: ["approve", "reject"] } },
      required: ["decision"],
      additionalProperties: false,
    };
    one.held.fake.script({
      reply:
        "<Elicit schema={" +
        JSON.stringify(shape) +
        '} as="answer">Approve this fixture?</Elicit>\n<Output><Json value={answer}/></Output>',
    });
    one.held.fake.script({ reply: "<Output>Human answer retained.</Output>" });
    const changes = yield* one.held.owner.questions.changes;
    const sent = yield* spawn(() =>
      requestAttachment(one.path, {
        method: "prompt",
        attachment: attached.attachment,
        text: "ask the human",
      }),
    );
    while (one.held.owner.questions.pending === undefined) {
      yield* changes.next();
    }
    const question = one.held.owner.questions.pending;
    if (question === undefined) {
      throw new Error("Question not presented.");
    }
    const before = yield* records(one.held.execution);
    expect(
      statusSchema.parse(yield* requestAttachment(one.path, { method: "status" })).questionPending,
    ).toBe(true);
    yield* refused(
      requestAttachment(
        one.path,
        JSON.parse('{"method":"answer","key":"not-authority","value":{"decision":"approve"}}'),
      ),
    );
    expect(yield* records(one.held.execution)).toEqual(before);
    expect(one.held.owner.questions.pending).toBe(question);
    expect(question.submit({ decision: "approve" }).kind).toBe("answered");
    expect(exchangeSchema.parse(yield* sent).ending?.outcome).toBe("completed");
    expect(question.submit({ decision: "reject" }).kind).not.toBe("answered");
    expect(one.held.fake.prompts).toHaveLength(one.baselineTurns + 2);
  });

  it("A5: cancellation joins control cleanup and stale attachment cancellation cannot stop a successor", function* () {
    const entered = withResolvers<void>();
    let cleaned = false;
    const one = yield* world({
      *fill() {
        yield* ensure(() => {
          cleaned = true;
        });
        entered.resolve();
        yield* suspend();
        return Ok(undefined);
      },
    });
    const a = attachResult.parse(
      yield* requestAttachment(one.path, { method: "attach", cwd: one.descriptor.cwd }),
    );
    one.held.fake.script({ reply: fills("blocked") });
    const first = yield* spawn(() =>
      requestAttachment(one.path, {
        method: "prompt",
        attachment: a.attachment,
        text: "hold control",
      }),
    );
    yield* entered.operation;
    const old = one.dispatch.current;
    if (old === undefined) {
      throw new Error("No exact exchange.");
    }
    yield* requestAttachment(one.path, { method: "cancel", attachment: a.attachment });
    expect(exchangeSchema.parse(yield* first).ending?.outcome).toBe("cancelled");
    expect(cleaned).toBe(true);
    one.held.fake.script({ reply: "<Output>Human successor.</Output>", held: true });
    const next = yield* one.dispatch.send("human successor");
    if (!next.ok) {
      throw next.error;
    }
    yield* one.held.fake.startedTurns(one.baselineTurns + 2);
    yield* old.cancel();
    yield* requestAttachment(one.path, { method: "cancel", attachment: a.attachment });
    expect(one.held.owner.busy).toBe(true);
    one.held.fake.releaseTurn();
    expect((yield* next.value.completion).ok).toBe(true);
  });

  it("A5: real ACP close joins an active exchange and owner exit removes only its owned names", function* () {
    const one = yield* world();
    const { connection } = yield* sdk(one);
    const session = yield* until(
      connection.agent.request(acp.methods.agent.session.new, {
        cwd: one.descriptor.cwd,
        mcpServers: [],
      }),
    );
    one.held.fake.script({ reply: "", manual: true });
    const prompt = yield* spawn(function* () {
      return yield* until(
        connection.agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hold" }],
        }),
      );
    });
    yield* one.held.fake.startedTurns(one.baselineTurns + 1);
    yield* until(
      connection.agent.request(acp.methods.agent.session.close, { sessionId: session.sessionId }),
    );
    expect((yield* prompt).stopReason).toBe("cancelled");
    expect(one.held.owner.busy).toBe(false);
    let descriptor: z.infer<typeof Descriptor> | undefined;
    const file = join(one.home, "exit.json");
    yield* scoped(function* () {
      descriptor = yield* useSidekickAttachment(file, {
        owner: one.held.owner,
        dispatch: one.dispatch,
        reads: rootReads(one.held.session, one.held.profile),
        execution: one.descriptor.execution,
        cwd: one.descriptor.cwd,
      });
    });
    yield* refused(until(lstat(file)));
    if (descriptor === undefined) {
      throw new Error("No owned endpoint.");
    }
    yield* refused(until(lstat(descriptor.socket)));
    const replaced = join(one.home, "replaced.json");
    yield* scoped(function* () {
      yield* useSidekickAttachment(replaced, {
        owner: one.held.owner,
        dispatch: one.dispatch,
        reads: rootReads(one.held.session, one.held.profile),
        execution: one.descriptor.execution,
        cwd: one.descriptor.cwd,
      });
      yield* until(unlink(replaced));
      yield* writeTextFile(replaced, "replacement owner bytes");
    });
    expect(yield* readTextFile(replaced)).toBe("replacement owner bytes");
  });

  it("A6: partial follow-up failure stays failed and an unassociated saved message remains unknown", function* () {
    const one = yield* world();
    const before = statusSchema.parse(yield* requestAttachment(one.path, { method: "status" }));
    const unknown = before.messages[0];
    if (unknown === undefined) {
      throw new Error("No bootstrap message.");
    }
    yield* refused(
      requestAttachment(one.path, { method: "message", reference: unknown, follow: true }),
    );
    const a = attachResult.parse(
      yield* requestAttachment(one.path, { method: "attach", cwd: one.descriptor.cwd }),
    );
    one.held.fake.script({ reply: "<Output>Earlier answer.</Output>\n<REPL.Bindings/>" });
    one.held.fake.script({ reply: "incomplete", stopReason: "max_tokens" });
    const ended = exchangeSchema.parse(
      yield* requestAttachment(one.path, {
        method: "prompt",
        attachment: a.attachment,
        text: "fail after partial",
      }),
    );
    expect(ended.ending?.outcome).toBe("failed");
    expect(ended.output).toContain("Earlier answer.");
    expect(one.held.fake.prompts).toHaveLength(one.baselineTurns + 2);
  });

  it("A2/A6: page continuations bind exact evidence after newer entries and descriptors cannot retarget", function* () {
    const one = yield* world();
    const a = attachResult.parse(
      yield* requestAttachment(one.path, { method: "attach", cwd: one.descriptor.cwd }),
    );
    const source = "<Output>" + "x".repeat(5000) + "</Output>";
    one.held.fake.script({ reply: fills(source) + "\n<REPL.Submit/>" });
    one.held.fake.script({ reply: "<Output>first settled</Output>" });
    yield* requestAttachment(one.path, {
      method: "prompt",
      attachment: a.attachment,
      text: "create long entry",
    });
    const page = z
      .object({ entry: z.number(), text: z.string(), next: z.string().nullable() })
      .passthrough()
      .parse(yield* requestAttachment(one.path, { method: "entry", entry: 1, view: "source" }));
    expect(Array.from(page.text)).toHaveLength(4096);
    if (page.next === null) {
      throw new Error("No continuation.");
    }
    one.held.fake.script({ reply: fills("<Output>newer entry</Output>") + "\n<REPL.Submit/>" });
    one.held.fake.script({ reply: "<Output>second settled</Output>" });
    yield* requestAttachment(one.path, {
      method: "prompt",
      attachment: a.attachment,
      text: "create newer entry",
    });
    const tail = z
      .object({ entry: z.number(), text: z.string() })
      .passthrough()
      .parse(
        yield* requestAttachment(one.path, {
          method: "entry",
          entry: 1,
          view: "source",
          cursor: page.next,
        }),
      );
    expect(tail.entry).toBe(1);
    expect(page.text + tail.text).toBe(source);
    yield* refused(
      requestAttachment(one.path, { method: "entry", entry: 2, view: "source", cursor: page.next }),
    );
    yield* refused(
      requestAttachment(one.path, { method: "entry", entry: 1, view: "output", cursor: page.next }),
    );
    const bytes = yield* readTextFile(one.path);
    yield* writeTextFile(
      one.path,
      JSON.stringify({ ...one.descriptor, conversation: "different" }),
    );
    yield* refused(requestAttachment(one.path, { method: "status" }));
    yield* writeTextFile(one.path, bytes);
    const root = yield* records(one.held.execution);
    yield* requestAttachment(one.path, { method: "status" });
    expect(yield* records(one.held.execution)).toEqual(root);
  });

  it("A6: unestablished feedback refuses another prompt without guessing or resend", function* () {
    const one = yield* world();
    const a = attachResult.parse(
      yield* requestAttachment(one.path, { method: "attach", cwd: one.descriptor.cwd }),
    );
    let prompts = 0;
    yield* ReplHost.around({
      *appendRecord([file, text], next) {
        const row = z
          .object({ kind: z.string(), event: z.string().optional() })
          .passthrough()
          .parse(JSON.parse(text));
        if (row.kind === "event" && row.event !== undefined) {
          const events = parseEntryRecords(row.event);
          if (
            events.some(
              (event) => event.type === "yield" && event.description.type === AGENT_PROMPT,
            ) &&
            ++prompts === 2
          ) {
            throw new Error("Controlled feedback acknowledgement loss.");
          }
        }
        yield* next(file, text);
      },
    });
    one.held.fake.script({ reply: "<REPL.Bindings/>" });
    one.held.fake.script({ reply: "<Output>Backend accepted feedback.</Output>" });
    yield* requestAttachment(one.path, {
      method: "prompt",
      attachment: a.attachment,
      text: "inspect",
    });
    const status = z
      .object({ feedbackUnestablished: z.number() })
      .passthrough()
      .parse(yield* requestAttachment(one.path, { method: "status" }));
    expect(status.feedbackUnestablished).toBeGreaterThan(0);
    const before = yield* records(one.held.execution);
    const count = one.held.fake.prompts.length;
    const result = exchangeSchema.parse(
      yield* requestAttachment(one.path, {
        method: "prompt",
        attachment: a.attachment,
        text: "do not resend",
      }),
    );
    expect(result.ending?.outcome).toBe("failed");
    expect(one.held.fake.prompts).toHaveLength(count);
    expect(yield* records(one.held.execution)).toEqual(before);
  });

  it("A6: the 64-update observer bound detaches a slow connection while its root producer continues", function* () {
    const one = yield* world();
    const host = yield* SidekickTransport.expect();
    const blocked = withResolvers<void>();
    yield* SidekickTransport.set({
      ...host,
      *publish(path, binding) {
        const listener = yield* host.publish(path, binding);
        return {
          descriptor: listener.descriptor,
          *accept() {
            const incoming = yield* listener.accept();
            return (function* () {
              const wire = yield* incoming;
              return {
                ...wire,
                *send(frame: unknown) {
                  if (
                    z.object({ kind: z.string() }).passthrough().safeParse(frame).data?.kind ===
                    "update"
                  ) {
                    blocked.resolve();
                    yield* suspend();
                  }
                  yield* wire.send(frame);
                },
              };
            })();
          },
        };
      },
    });
    const path = join(one.home, "slow.json");
    yield* useSidekickAttachment(path, {
      owner: one.held.owner,
      dispatch: one.dispatch,
      reads: rootReads(one.held.session, one.held.profile),
      execution: one.descriptor.execution,
      cwd: one.descriptor.cwd,
    });
    const a = attachResult.parse(
      yield* requestAttachment(path, { method: "attach", cwd: one.descriptor.cwd }),
    );
    one.held.fake.script({
      deltas: Array.from({ length: 200 }, () => "<Output>piece</Output>\n"),
      holdAfter: 200,
    });
    const observing = yield* spawn(function* () {
      yield* refused(
        requestAttachment(path, {
          method: "prompt",
          attachment: a.attachment,
          text: "large activity",
        }),
      );
    });
    yield* blocked.operation;
    yield* race([
      observing,
      (function* () {
        yield* sleep(10000);
        throw new Error("Observer bound did not detach.");
      })(),
    ]);
    expect(one.held.owner.busy).toBe(true);
    const exact = one.dispatch.current;
    if (exact === undefined) {
      throw new Error("Root producer lost.");
    }
    one.held.fake.releaseDeltas();
    expect((yield* exact.completion).ok).toBe(true);
  });

  it("A6: real embedded timeout and materialization controls never manufacture joined completion", function* () {
    const home = yield* useTemporary("xmd-incomplete-attachment-");
    const agent = join(home, "agent.cjs");
    const source = `const readline=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;
const reply=result=>send({jsonrpc:'2.0',id:r.id,result});
if(r.method==='initialize')reply({protocolVersion:1,agentCapabilities:{loadSession:true}});
else if(r.method==='session/new')reply({sessionId:'controlled-outer',_meta:{agentSessionId:'controlled-outer'}});
else if(r.method==='session/load')reply({_meta:{agentSessionId:'controlled-outer'}});
else if(r.method==='session/prompt'){
if(process.env.CONTROL==='timeout')send({jsonrpc:'2.0',method:'session/update',params:{sessionId:r.params.sessionId,update:{sessionUpdate:'session_info_update',_meta:{'executablemd.session-materialization/v1':{state:'accepted'}}}}});
send({jsonrpc:'2.0',method:'session/update',params:{sessionId:r.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Controlled earlier text.'}}}});
if(process.env.CONTROL==='bare')reply({stopReason:'end_turn'});
}else reply({});});`;
    yield* writeTextFile(agent, source);
    for (const control of ["bare", "timeout"]) {
      yield* scoped(function* () {
        const command = "node " + shellQuote(agent);
        console.log(
          JSON.stringify({
            kind: "controlled-embedded-input",
            command,
            home,
            control,
            sha256: createHash("sha256").update(source).digest("hex"),
          }),
        );
        const runtime = createAcpRuntime({
          cwd: home,
          agentRegistry: { resolve: () => command, list: () => ["controlled"] },
          sessionStore: createRuntimeStore({ stateDir: join(home, control) }),
          permissionMode: "deny-all",
          nonInteractivePermissions: "deny",
          agentProcessEnv: { HOME: home, CONTROL: control },
        });
        const handle = yield* until(
          runtime.ensureSession({
            agent: "controlled",
            sessionKey: control,
            mode: "persistent",
            materialization: "first-turn-acceptance",
          }),
        );
        yield* ensure(() =>
          until(runtime.close({ handle, reason: "controlled fixture teardown" })),
        );
        const turn = runtime.startTurn({
          handle,
          text: "control",
          mode: "prompt",
          requestId: control,
          timeoutMs: 100,
        });
        const accepted = turn.materialized.then(
          () => true,
          () => false,
        );
        // The result settles before final store writes; the event stream joins them.
        const events = turn.events[Symbol.asyncIterator]();
        let event = yield* until(events.next());
        while (!event.done) {
          event = yield* until(events.next());
        }
        const result = yield* until(turn.result);
        expect(result.status).toBe("completed");
        if (result.status !== "completed") {
          throw new Error("No controlled ending.");
        }
        expect(result.stopReason).toBe("end_turn");
        expect(result._meta?.["executablemd.sidekick-exchange/v1"]).toBe(undefined);
        expect(yield* until(accepted)).toBe(control === "timeout");
      });
    }
  });

  it("A5: cancelling Submit waiting joins response ownership and leaves admitted entry ownership intact", function* () {
    const reached = withResolvers<void>();
    const release = withResolvers<void>();
    const finished = withResolvers<void>();
    yield* ensure(() => release.resolve());
    const one = yield* world({
      entryInstallation: {
        *install() {
          yield* Execution.around({
            *document([request], next) {
              yield* ensure(() => finished.resolve());
              reached.resolve();
              yield* release.operation;
              yield* next(request);
            },
          });
        },
      },
    });
    const a = attachResult.parse(
      yield* requestAttachment(one.path, { method: "attach", cwd: one.descriptor.cwd }),
    );
    one.held.fake.script({ reply: fills("<Output>entry</Output>") + "\n<REPL.Submit/>" });
    const observing = yield* spawn(() =>
      requestAttachment(one.path, { method: "prompt", attachment: a.attachment, text: "submit" }),
    );
    yield* reached.operation;
    yield* requestAttachment(one.path, { method: "cancel", attachment: a.attachment });
    yield* finished.operation;
    expect(exchangeSchema.parse(yield* observing).ending?.outcome).toBe("cancelled");
    expect(one.held.session.model.entries).toHaveLength(0);
  });

  it("A5/A6: enclosing owner teardown joins its producer and socket; stale descriptors stay offline", function* () {
    let endpoint: z.infer<typeof Descriptor> | undefined;
    let path = "";
    yield* scoped(function* () {
      const one = yield* world();
      endpoint = one.descriptor;
      path = one.path;
      one.held.fake.script({ reply: "", manual: true });
      const sent = yield* one.dispatch.send("in flight at enclosing exit");
      if (!sent.ok) {
        throw sent.error;
      }
      yield* one.held.fake.startedTurns(one.baselineTurns + 1);
    });
    if (endpoint === undefined) {
      throw new Error("Missing owned endpoint.");
    }
    yield* refused(until(lstat(endpoint.socket)));
    yield* refused(until(lstat(path)));
  });
});

describe("A5: cancels pending endpoint directory acquisition", () => {
  it("A5: cancels pending endpoint directory acquisition and joins exact cleanup", function* () {
    const home = yield* until(realpath(yield* useTemporary("xmd-pending-endpoint-")));
    yield* until(chmod(home, 0o700));
    const file = join(home, "attachment.json");
    const created = withResolvers<string>();
    // A raw promise, because the factory below is a plain callback the host
    // calls outside this operation: Effection's own `withResolvers` hands back
    // an operation, which that callback cannot await.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancelling = withResolvers<void>();
    let published = false;
    let joined = false;
    let directory: string | undefined;
    let identity: Awaited<ReturnType<typeof lstat>> | undefined;
    yield* ensure(function* () {
      if (directory !== undefined && identity !== undefined) {
        try {
          const actual = yield* until(lstat(directory));
          if (actual.dev === identity.dev && actual.ino === identity.ino) {
            yield* until(rmdir(directory));
            console.log(JSON.stringify({ kind: "pending-endpoint-fixture-cleanup", directory }));
          }
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }
      }
    });
    yield* usePosixSidekickTransport(process.platform, (prefix) =>
      mkdtemp(prefix).then((path) => {
        created.resolve(path);
        return released.then(() => path);
      }),
    );
    const host = yield* SidekickTransport.expect();
    try {
      const owner = yield* spawn(function* () {
        yield* host.publish(file, {
          owner: "pending-owner",
          execution: "pending-execution",
          conversation: "pending-conversation",
          cwd: home,
        });
        published = true;
        yield* suspend();
      });
      directory = yield* race([
        created.operation,
        (function* (): Operation<string> {
          yield* owner;
          throw new Error("Publication ended before directory creation.");
        })(),
      ]);
      identity = yield* until(lstat(directory));
      const stopping = yield* spawn(function* () {
        cancelling.resolve();
        yield* owner.halt();
        joined = true;
      });
      yield* cancelling.operation;
      expect(joined).toBe(false);
      expect(published).toBe(false);
      release();
      yield* stopping;
    } finally {
      release();
    }
    let exists = true;
    try {
      yield* until(lstat(directory));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      exists = false;
    }
    console.log(
      JSON.stringify({
        kind: "pending-endpoint-cleanup-result",
        directory,
        exists,
        joined,
        published,
      }),
    );
    expect(joined).toBe(true);
    expect(published).toBe(false);
    yield* refused(until(lstat(file)));
    yield* refused(until(lstat(join(directory, "s"))));
    expect(exists).toBe(false);
  });
});

describe("A5: a peer the listener accepts after teardown begins", () => {
  it("A5: a late peer is still owned, closed and joined", function* () {
    const home = yield* until(realpath(yield* useTemporary("xmd-late-peer-")));
    yield* until(chmod(home, 0o700));
    const file = join(home, "attachment.json");
    // A raw promise, because this barrier is released from a synchronous
    // `finally` here while the owner's own cleanup waits on it: an operation
    // would have to be yielded, and unwinding is where it must let go.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = withResolvers<void>();
    let barriers = 0;
    // Only the first accepted socket is held. Whatever the listener accepts
    // afterwards closes normally, which is what this row is about.
    yield* usePosixSidekickTransport(process.platform, mkdtemp, function* () {
      barriers += 1;
      if (barriers > 1) {
        return;
      }
      holding.resolve();
      yield* until(released);
    });
    const host = yield* SidekickTransport.expect();
    const listening = withResolvers<{
      descriptor: { socket: string };
      accept(): Operation<unknown>;
    }>();
    let joined = false;
    let late: Socket | undefined;
    let early: Socket | undefined;
    let lateClosed = false;
    let directory: string | undefined;
    let socketPath: string | undefined;
    try {
      const owner = yield* spawn(function* () {
        const listener = yield* host.publish(file, {
          owner: "late-peer-owner",
          execution: "late-peer-execution",
          conversation: "late-peer-conversation",
          cwd: home,
        });
        listening.resolve(listener);
        yield* suspend();
      });
      const listener = yield* race([
        listening.operation,
        (function* (): Operation<never> {
          yield* owner;
          throw new Error("The publication ended before it published.");
        })(),
      ]);
      socketPath = listener.descriptor.socket;
      directory = dirname(socketPath);

      // One peer this listener has adopted: accepting it is what says the
      // transport tracked the socket, rather than that connect() returned.
      early = createConnection(socketPath);
      yield* once(early, "connect");
      yield* race([listener.accept(), deadline("The listener never accepted the first peer.")]);

      // Teardown begins and stops inside that socket's own cleanup, before its
      // close. The listener still exists here, and the owner has not joined.
      const stopping = yield* spawn(function* () {
        yield* owner.halt();
        joined = true;
      });
      yield* race([holding.operation, deadline("The first peer's cleanup never ran.")]);
      expect(joined).toBe(false);

      // The peer that arrives in that window, and the listener's own account of
      // accepting it: a connect that returned proves only that the kernel
      // queued it.
      late = createConnection(socketPath);
      yield* once(late, "connect");
      const held = late;
      const watching = yield* spawn(function* () {
        yield* once(held, "close");
        lateClosed = true;
      });
      yield* race([listener.accept(), deadline("The listener never accepted the late peer.")]);

      release();
      yield* race([stopping, deadline("The owner never joined after its cleanup was released.")]);
      // Closed by the owner that accepted it, and awaited before this fixture
      // touches either peer.
      yield* race([watching, deadline("The late peer was never closed by its owner.")]);
    } finally {
      release();
      early?.destroy();
      late?.destroy();
    }
    console.log(
      JSON.stringify({ kind: "late-peer-teardown-result", joined, lateClosed, barriers }),
    );
    expect(joined).toBe(true);
    expect(lateClosed).toBe(true);
    expect(barriers).toBeGreaterThan(1);
    yield* refused(until(lstat(file)));
    yield* refused(until(lstat(socketPath)));
    yield* refused(until(lstat(directory)));
  });
});

describe("ACP startup bootstrap", () => {
  it("creates a real initial message without UI input and joins the first external prompt", function* () {
    yield* usePosixSidekickTransport(process.platform);
    const home = yield* until(realpath(yield* useTemporary("xmd-acp-startup-")));
    yield* until(chmod(home, 0o700));
    const path = join(home, "attachment.json");
    const host = yield* useMountedHost();
    host.fake.script({ reply: "<Output>Ready for ACP.</Output>", held: true });
    yield* scoped(function* () {
      const recording = recordingTerminal();
      yield* recording.install();
      const starting = yield* spawn(() =>
        runReplProgram({ profile: host.profile, sidekickAcp: path }),
      );
      yield* race([
        host.fake.startedTurns(1),
        (function* (): Operation<void> {
          const result = yield* starting;
          throw result.ok ? new Error("REPL ended before its initialization turn.") : result.error;
        })(),
      ]);
      yield* refused(until(lstat(path)));
      host.fake.releaseTurn();
      yield* untilDrawn(recording.terminal);
      const descriptor = Descriptor.parse(JSON.parse(yield* readTextFile(path)));
      const opened = yield* host.repository.open(descriptor.execution);
      const saved = yield* records(opened);
      expect(saved.filter((one) => one.kind === "message")).toHaveLength(1);
      expect(
        saved.filter((one) => one.kind === "conversation" && one.phase === "activated"),
      ).toHaveLength(1);
      expect(host.fake.ensured[0]?.agent).toBe(MOUNTED_AGENT);
      expect(host.fake.created[0]?.permissionMode).toBe("deny-all");
      expect(host.fake.configCalls).toEqual([]);
      const attached = attachResult.parse(
        yield* requestAttachment(path, { method: "attach", cwd: descriptor.cwd }),
      );
      host.fake.script({ reply: "<Output>First external request completed.</Output>", held: true });
      let completed = false;
      const observing = yield* spawn(function* () {
        const answer = yield* requestAttachment(path, {
          method: "prompt",
          attachment: attached.attachment,
          text: "first external request",
        });
        completed = true;
        return exchangeSchema.parse(answer);
      });
      yield* host.fake.startedTurns(2);
      expect(completed).toBe(false);
      host.fake.releaseTurn();
      const answer = yield* observing;
      expect(answer.ending).toMatchObject({ joined: true, outcome: "completed" });
      expect(answer.output).toContain("First external request completed.");
      expect(host.fake.prompts).toHaveLength(2);
    });
    expect(yield* until(readdir(home))).toEqual([]);
  });

  it("reopens existing history without another initial message or provider setup", function* () {
    yield* usePosixSidekickTransport(process.platform);
    const home = yield* until(realpath(yield* useTemporary("xmd-acp-resume-")));
    yield* until(chmod(home, 0o700));
    const path = join(home, "attachment.json");
    const host = yield* useMountedHost();
    host.fake.script({ reply: "<Output>Ready.</Output>" });
    const first = yield* scoped(function* () {
      const recording = recordingTerminal();
      yield* recording.install();
      yield* spawn(() => runReplProgram({ profile: host.profile, sidekickAcp: path }));
      yield* untilDrawn(recording.terminal);
      return Descriptor.parse(JSON.parse(yield* readTextFile(path)));
    });
    const before = yield* records(yield* host.repository.open(first.execution));
    const setups = host.fake.ensured.length;
    yield* scoped(function* () {
      const recording = recordingTerminal();
      yield* recording.install();
      yield* spawn(() =>
        runReplProgram({
          profile: host.profile,
          sidekickAcp: path,
          location: `xmd://repl/${first.execution}/entries`,
        }),
      );
      yield* untilDrawn(recording.terminal);
      const descriptor = Descriptor.parse(JSON.parse(yield* readTextFile(path)));
      expect(descriptor.conversation).toBe(first.conversation);
      expect(host.fake.prompts).toHaveLength(1);
      expect(host.fake.ensured).toHaveLength(setups);
      expect(yield* records(yield* host.repository.open(first.execution))).toEqual(before);
    });
    expect(yield* until(readdir(home))).toEqual([]);
  });

  it("reports provider initialization failure and leaves no published endpoint", function* () {
    yield* usePosixSidekickTransport(process.platform);
    const home = yield* until(realpath(yield* useTemporary("xmd-acp-init-failure-")));
    yield* until(chmod(home, 0o700));
    const path = join(home, "attachment.json");
    const host = yield* useMountedHost();
    host.fake.unavailable(MOUNTED_AGENT, new Error("controlled initialization refusal"));
    const recording = recordingTerminal();
    yield* recording.install();
    const result = yield* runReplProgram({ profile: host.profile, sidekickAcp: path });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Initialization unexpectedly succeeded.");
    }
    expect(result.error.message).toContain("controlled initialization refusal");
    expect(host.fake.prompts).toHaveLength(0);
    expect(host.fake.ensured).toHaveLength(1);
    expect(yield* until(readdir(home))).toEqual([]);
  });

  for (const event of ["Control-C", "EOF"]) {
    it(event + " cancels held initialization and joins cleanup before returning", function* () {
      yield* usePosixSidekickTransport(process.platform);
      const home = yield* until(realpath(yield* useTemporary("xmd-acp-bootstrap-shutdown-")));
      yield* until(chmod(home, 0o700));
      const host = yield* useMountedHost();
      host.fake.script({ reply: "<Output>Never completed.</Output>", held: true });
      const cancellation = host.fake.holdCancellation();
      const recording = recordingTerminal();
      yield* recording.install();
      let completed = false;
      const running = yield* spawn(function* () {
        const result = yield* runReplProgram({
          profile: host.profile,
          sidekickAcp: join(home, "attachment.json"),
        });
        completed = true;
        return result;
      });
      yield* ensure(() => cancellation.release());
      yield* host.fake.holdingTurns(1);
      const published = yield* until(readdir(join(host.root, PAIRED_DIRECTORY)));
      expect(published).toHaveLength(1);
      const execution = published[0];
      const before = yield* records(yield* host.repository.open(execution));
      if (event === "Control-C") {
        recording.terminal.feed("\u0003");
      } else {
        recording.terminal.end();
      }
      const reached = yield* race([
        (function* () {
          yield* cancellation.reached;
          return true;
        })(),
        (function* () {
          yield* sleep(1000);
          return false;
        })(),
      ]);
      expect(reached).toBe(true);
      expect(completed).toBe(false);
      expect(host.fake.cancels).toBe(1);
      expect(yield* until(readdir(home))).toEqual([]);
      cancellation.release();
      const result = yield* running;
      expect(result.ok).toBe(true);
      expect(completed).toBe(true);
      expect(recording.terminal.raw).toEqual([true, false]);
      expect(recording.terminal.resets).toBe(1);
      expect(recording.terminal.readers).toBe(0);
      expect(host.fake.prompts).toHaveLength(1);
      expect(yield* records(yield* host.repository.open(execution))).toEqual(before);
      expect(before.filter((one) => one.kind === "message")).toHaveLength(1);
      expect(before.filter((one) => one.kind === "response")).toHaveLength(0);
      expect(yield* until(readdir(home))).toEqual([]);
    });
  }
});

function* publishingHome(prefix: string): Operation<string> {
  const home = yield* until(realpath(yield* useTemporary(prefix)));
  yield* until(chmod(home, 0o700));
  return home;
}
function* stageNameIn(home: string): Operation<string> {
  const staged = (yield* until(readdir(home))).filter((name) => name.startsWith(".sidekick-"));
  expect(staged).toHaveLength(1);
  return join(home, staged[0]);
}
function binding(owner: string) {
  return {
    owner,
    execution: owner + "-execution",
    conversation: owner + "-conversation",
  };
}

describe("ACP81: a replacement inside a refreshed identity window", () => {
  it("ACP81: a stage name replaced under its refresh is refused and left where it is", function* () {
    const home = yield* publishingHome("xmd-stage-replaced-");
    const file = join(home, "attachment.json");
    const reached = withResolvers<void>();
    // A raw promise, because the hold below is a plain callback the
    // publication calls outside this operation: it cannot await an operation,
    // and this test has to let go of it from its own `finally`.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let directory: string | undefined;
    yield* usePosixSidekickTransport(
      process.platform,
      (prefix) =>
        mkdtemp(prefix).then((created) => {
          directory = created;
          return created;
        }),
      undefined,
      {
        holdIdentityRefresh: (window) => {
          if (window !== "stage") {
            return Promise.resolve();
          }
          reached.resolve();
          return held;
        },
      },
    );
    const host = yield* SidekickTransport.expect();
    let failure: unknown;
    let published = false;
    let foreign: string | undefined;
    let foreignIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      const owner = yield* spawn(function* () {
        try {
          yield* host.publish(file, { ...binding("stage-replaced"), cwd: home });
          published = true;
          yield* suspend();
        } catch (error) {
          failure = error;
        }
      });
      yield* reached.operation;
      foreign = yield* stageNameIn(home);
      yield* until(unlink(foreign));
      yield* writeTextFile(foreign, "someone else's file");
      foreignIdentity = yield* until(lstat(foreign));
      release();
      yield* owner;
    } finally {
      release();
    }
    console.log(
      JSON.stringify({
        kind: "stage-window-replacement",
        refused: failure instanceof Error ? failure.message : null,
        published,
      }),
    );
    expect(published).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "the staged descriptor was replaced while it was being published.",
    );
    expect(yield* readTextFile(foreign!)).toBe("someone else's file");
    expect((yield* until(lstat(foreign!))).ino).toBe(foreignIdentity!.ino);
    expect(yield* until(readdir(home))).toEqual([foreign!.slice(home.length + 1)]);
    yield* refused(until(lstat(file)));
    yield* refused(until(lstat(directory!)));
  });

  it("ACP81: a published name replaced under its refresh is refused and never unlinked", function* () {
    const home = yield* publishingHome("xmd-published-replaced-");
    const file = join(home, "attachment.json");
    const reached = withResolvers<void>();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let directory: string | undefined;
    yield* usePosixSidekickTransport(
      process.platform,
      (prefix) =>
        mkdtemp(prefix).then((created) => {
          directory = created;
          return created;
        }),
      undefined,
      {
        holdIdentityRefresh: (window) => {
          if (window !== "published") {
            return Promise.resolve();
          }
          reached.resolve();
          return held;
        },
      },
    );
    const host = yield* SidekickTransport.expect();
    let failure: unknown;
    let published = false;
    let foreignIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      const owner = yield* spawn(function* () {
        try {
          yield* host.publish(file, { ...binding("published-replaced"), cwd: home });
          published = true;
          yield* suspend();
        } catch (error) {
          failure = error;
        }
      });
      yield* reached.operation;
      yield* until(unlink(file));
      yield* writeTextFile(file, "someone else's attachment");
      foreignIdentity = yield* until(lstat(file));
      release();
      yield* owner;
    } finally {
      release();
    }
    console.log(
      JSON.stringify({
        kind: "published-window-replacement",
        refused: failure instanceof Error ? failure.message : null,
        published,
      }),
    );
    expect(published).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "the published descriptor was replaced while it was being published.",
    );
    expect(yield* readTextFile(file)).toBe("someone else's attachment");
    expect((yield* until(lstat(file))).ino).toBe(foreignIdentity!.ino);
    expect(yield* until(readdir(home))).toEqual(["attachment.json"]);
    yield* refused(until(lstat(directory!)));
  });

  it("ACP81: cancellation while a refresh is in flight adopts nothing and still joins", function* () {
    const home = yield* publishingHome("xmd-refresh-cancelled-");
    const file = join(home, "attachment.json");
    const reached = withResolvers<void>();
    const cancelling = withResolvers<void>();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let directory: string | undefined;
    yield* usePosixSidekickTransport(
      process.platform,
      (prefix) =>
        mkdtemp(prefix).then((created) => {
          directory = created;
          return created;
        }),
      undefined,
      {
        holdIdentityRefresh: (window) => {
          if (window !== "published") {
            return Promise.resolve();
          }
          reached.resolve();
          return held;
        },
      },
    );
    const host = yield* SidekickTransport.expect();
    let published = false;
    let joined = false;
    let foreignIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      const owner = yield* spawn(function* () {
        yield* host.publish(file, { ...binding("refresh-cancelled"), cwd: home });
        published = true;
        yield* suspend();
      });
      yield* reached.operation;
      yield* until(unlink(file));
      yield* writeTextFile(file, "someone else's attachment");
      foreignIdentity = yield* until(lstat(file));
      const stopping = yield* spawn(function* () {
        cancelling.resolve();
        yield* owner.halt();
        joined = true;
      });
      yield* cancelling.operation;
      expect(joined).toBe(false);
      release();
      yield* stopping;
    } finally {
      release();
    }
    console.log(JSON.stringify({ kind: "refresh-cancellation", joined, published, directory }));
    expect(joined).toBe(true);
    expect(published).toBe(false);
    expect(yield* readTextFile(file)).toBe("someone else's attachment");
    expect((yield* until(lstat(file))).ino).toBe(foreignIdentity!.ino);
    expect(yield* until(readdir(home))).toEqual(["attachment.json"]);
    yield* refused(until(lstat(directory!)));
  });

  it("ACP81: the directory is judged while its socket is still in it, and still removed", function* () {
    const home = yield* publishingHome("xmd-ctime-directory-");
    const file = join(home, "attachment.json");
    let directory: string | undefined;
    // Whether the socket was still a child of the directory at each reading of
    // the directory's own identity. A reading taken after the listener close
    // has unlinked it is a reading of a directory this teardown has already
    // changed, which is what the identity substitute below cannot survive.
    const socketPresent: boolean[] = [];
    yield* usePosixSidekickTransport(
      process.platform,
      (prefix) =>
        mkdtemp(prefix).then((created) => {
          directory = created;
          return created;
        }),
      undefined,
      {
        // The documented libuv fallback, which this filesystem will not do:
        // no creation time to read, so `birthtime` is the `ctime`. Deno's own
        // `ctime` is truncated to the second, so the leak this would cause is
        // not observable here — the ordering above it is, and that is what the
        // sequence below pins.
        readDirectoryIdentity: (path) => {
          const asked = directory;
          const observed =
            asked === undefined
              ? Promise.resolve()
              : lstat(join(asked, "s")).then(
                  () => {
                    socketPresent.push(true);
                  },
                  () => {
                    socketPresent.push(false);
                  },
                );
          return observed
            .then(() => lstat(path))
            .then((stat) =>
              Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
                birthtimeMs: stat.ctimeMs,
                birthtime: new Date(stat.ctimeMs),
              }),
            );
        },
      },
    );
    const host = yield* SidekickTransport.expect();
    let socketPath: string | undefined;
    yield* scoped(function* () {
      const attachment = yield* host.publish(file, {
        ...binding("ctime-directory"),
        cwd: home,
      });
      socketPath = attachment.descriptor.socket;
      expect(dirname(socketPath)).toBe(directory);
      expect((yield* until(lstat(socketPath))).isSocket()).toBe(true);
      expect(socketPresent).toEqual([false, true]);
    });
    console.log(JSON.stringify({ kind: "ctime-substitute-directory", directory, socketPresent }));
    // Created (no socket yet), refreshed once the socket existed, and judged at
    // teardown while it still did.
    expect(socketPresent).toEqual([false, true, true]);
    yield* refused(until(lstat(file)));
    yield* refused(until(lstat(socketPath!)));
    yield* refused(until(lstat(directory!)));
    expect(yield* until(readdir(home))).toEqual([]);
  });
});
