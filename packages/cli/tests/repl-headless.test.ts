import { Plugin } from "@executablemd/core/api";
import type { ReplPluginInstallation } from "../api.ts";
import { useSidekickAttachment } from "../src/sidekick-acp/server.ts";
import { attachChildUi } from "../src/headless/ui.ts";
import { sidekickAssembly } from "../src/repl/sidekick/assembly.ts";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Err, race, scoped, sleep, spawn, suspend, until, withResolvers } from "effection";
import { API } from "@executablemd/runtime";
import { cliCommand } from "@executablemd/test-support/launch";
import { usePosixSidekickTransport } from "../src/sidekick-acp/posix.ts";
import process from "node:process";
import { runReplProgram } from "../src/repl/program.ts";
import type { HeadlessReplRoot } from "../src/repl/program.ts";
import { useReplLiveScreen } from "../src/repl/live-screen.ts";
import { ReplTerminal } from "../src/repl/terminal.ts";
import { recordingTerminal, useMountedHost } from "./support/mounted-repl.ts";
import { useHeadlessFixture, START_CHILD, promptChild } from "./support/headless-repl.ts";
import { attachmentDescriptor, requestAttachment } from "../src/sidekick-acp/client.ts";
import { Reply, SidekickTransport } from "../src/sidekick-acp/protocol.ts";
import { z } from "zod";
import { childAddressPath, useHeadlessChildren } from "../src/headless/host.ts";
import { agentIdentityComponents, installAgentComponents } from "@executablemd/core";
import { executeInstalled, useAgentConversation } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { join } from "node:path";
import { makeRegistry, makeStore } from "./support/fake-acp.ts";
import { chmod, mkdtemp, realpath } from "node:fs/promises";

describe("parent-owned headless REPL", () => {
  it("H3: disconnect after accepted work reconnects exactly without resubmitting its effect", function* () {
    const held = yield* useHeadlessFixture();
    const source = '<Let as="once" value="single-disconnected-effect" /><Output>{once}</Output>';
    held.host.fake.script({
      reply: `<Let as="code" select="code">\n\x60\x60\x60xmd\n${source}\n\x60\x60\x60\n</Let><REPL.EntryInput>{code}</REPL.EntryInput><REPL.Submit />`,
    });
    held.host.fake.script({ reply: "<Output>Original work joined.</Output>", held: true });
    const mapping = z
      .object({ attachment: z.string() })
      .strict()
      .parse(yield* requestAttachment(held.path, { method: "attach", cwd: held.descriptor.cwd }));
    const accepted = withResolvers<{ execution: string; conversation: string; id: string }>();
    yield* scoped(function* () {
      const { wire, descriptor } = yield* (yield* SidekickTransport.expect()).connect(held.path);
      yield* wire.send({ id: 0, request: { method: "hello", descriptor } });
      Reply.parse(yield* wire.receive());
      yield* wire.send({
        id: 1,
        request: {
          method: "prompt",
          attachment: mapping.attachment,
          text: "Perform the one effect.",
        },
      });
      yield* spawn(function* () {
        while (true) {
          const reply = Reply.parse(yield* wire.receive());
          if (reply.kind === "update") {
            const snapshot = z
              .object({
                message: z
                  .object({ execution: z.string(), conversation: z.string(), id: z.string() })
                  .nullable(),
              })
              .passthrough()
              .parse(reply.value);
            if (snapshot.message !== null) {
              accepted.resolve(snapshot.message);
            }
          }
        }
      });
      yield* held.host.fake.holdingTurns(1);
      yield* accepted.operation;
      wire.close();
    });
    const reference = yield* accepted.operation;
    expect(reference.execution).toBe(held.descriptor.execution);
    expect(reference.conversation).toBe(held.descriptor.conversation);
    const output = yield* requestAttachment(held.path, {
      method: "entry",
      entry: 1,
      view: "output",
    });
    expect(JSON.stringify(output)).toContain("single-disconnected-effect");
    held.host.fake.releaseTurn();
    const original = z
      .object({ message: z.unknown(), ending: z.object({ joined: z.literal(true) }).passthrough() })
      .passthrough()
      .parse(yield* requestAttachment(held.path, { method: "message", reference, follow: true }));
    expect(original.message).toEqual(reference);
    expect(held.host.fake.prompts).toHaveLength(2);
    expect((yield* attachmentDescriptor(held.path)).execution).toBe(reference.execution);
    yield* held.task.halt();
  });

  it("H3: explicit ACP cancel joins only its exchange and leaves the exact child live", function* () {
    const held = yield* useHeadlessFixture();
    held.host.fake.script({ manual: true });
    const cleanup = held.host.fake.holdCancellation();
    const mapping = z
      .object({ attachment: z.string() })
      .strict()
      .parse(yield* requestAttachment(held.path, { method: "attach", cwd: held.descriptor.cwd }));
    const prompt = yield* spawn(() =>
      requestAttachment(held.path, {
        method: "prompt",
        attachment: mapping.attachment,
        text: "Hold the original exchange.",
      }),
    );
    yield* held.host.fake.startedTurns(1);
    let joined = false;
    const cancelling = yield* spawn(function* () {
      yield* requestAttachment(held.path, { method: "cancel", attachment: mapping.attachment });
      joined = true;
    });
    yield* cleanup.reached;
    expect(joined).toBe(false);
    cleanup.release();
    yield* cancelling;
    yield* prompt;
    expect((yield* attachmentDescriptor(held.path)).owner).toBe(held.reference.sessionId);
    yield* requestAttachment(held.path, { method: "close", attachment: mapping.attachment });
    expect((yield* attachmentDescriptor(held.path)).owner).toBe(held.reference.sessionId);
    yield* held.task.halt();
  });

  it("H2: real XMD startup, native work, refusal and Shutdown never touch the parent's terminal", function* () {
    let accesses = 0;
    function denied(): never {
      accesses += 1;
      throw new Error("Child touched the parent terminal.");
    }
    yield* ReplTerminal.around(
      {
        interactive: denied,
        size: denied,
        write: denied,
        writeNow: denied,
        setRaw: denied,
        input: denied,
        resizes: denied,
      },
      { at: "max" },
    );
    const held = yield* useHeadlessFixture();
    held.host.fake.script({ reply: "<Output>Terminal-free child work.</Output>" });
    const sent = yield* held.root.session.submit(promptChild("Perform terminal-free work."));
    if (!sent.ok) {
      throw sent.error;
    }
    const worked = yield* sent.value.join();
    if (!worked.ok) {
      throw worked.error;
    }
    const refusal = yield* held.root.session.submit(
      '<Agent name="xmd"><XMD.Session sessionId="00000000-0000-4000-8000-000000000001"><Prompt>Do not start.</Prompt></XMD.Session></Agent>',
    );
    if (!refusal.ok) {
      throw refusal.error;
    }
    expect((yield* refusal.value.join()).ok).toBe(false);
    const shutdown = yield* held.root.session.submit(
      "<XMD.Session.Shutdown sessionId={child.sessionId} />",
    );
    if (!shutdown.ok) {
      throw shutdown.error;
    }
    const stopped = yield* shutdown.value.join();
    if (!stopped.ok) {
      throw stopped.error;
    }
    yield* held.task.halt();
    expect(accesses).toBe(0);
  });
  it("H3: cancellation before readiness joins startup; after registration only the parent closes the child", function* () {
    for (const cut of ["before-ready", "registered"]) {
      yield* scoped(function* () {
        yield* usePosixSidekickTransport(process.platform);
        yield* API.Env.around({
          *command([args = []]) {
            const launch = cliCommand(args);
            return [launch.command, ...launch.arguments];
          },
        });
        const host = yield* useMountedHost({ hostFiles: true });
        const reached = withResolvers<void>();
        const closing = withResolvers<void>();
        const release = withResolvers<void>();
        let closed = false;
        const children = yield* useHeadlessChildren(function* (headless) {
          yield* ensure(function* () {
            closing.resolve();
            yield* release.operation;
            closed = true;
          });
          const result = yield* runReplProgram({
            profile: host.profile,
            root: host.root,
            headless: {
              view: headless.view,
              *ready(root) {
                if (cut === "registered") {
                  yield* headless.ready(root);
                }
                reached.resolve();
                yield* suspend();
              },
            },
          });
          if (!result.ok) {
            throw result.error;
          }
        });
        yield* ensureDir(host.root);
        const path = join(host.root, "creator-cut.md");
        yield* writeTextFile(
          path,
          '<Agent name="xmd"><Session name="worker"><XMD.Session as="child" /></Session></Agent><Block />',
        );
        const stream = new InMemoryStream();
        const provider = children.factory({
          createRuntime: host.fake.create,
          agentRegistry: makeRegistry({}),
          sessionStore: makeStore(),
        });
        const creator = yield* spawn(function* () {
          const execution = yield* executeInstalled({ path, stream }, [
            children.installation,
            {
              components: agentIdentityComponents(),
              *install() {
                yield* installAgentComponents({
                  rootProvider: {
                    factory: provider,
                    options: { defaultAgent: "xmd", permissionMode: "deny-all" },
                  },
                });
              },
            },
            {
              components: [
                {
                  name: "Block",
                  origin: "test",
                  props: { type: "object" },
                  factory: () =>
                    function* () {
                      yield* suspend();
                      return null;
                    },
                },
              ],
            },
          ]);
          const output = yield* execution.output;
          let next = yield* output.next();
          while (!next.done) {
            next = yield* output.next();
          }
          return yield* execution;
        });
        yield* reached.operation;
        const allocation = (yield* stream.readAll()).find(
          (event) => event.type === "yield" && event.description.type === "xmd_session",
        );
        const address = z
          .object({
            result: z
              .object({ value: z.object({ sessionId: z.string().uuid() }).strict() })
              .passthrough(),
          })
          .passthrough()
          .parse(allocation).result.value;
        let joined = false;
        const stopping = yield* spawn(function* () {
          yield* creator.halt();
          if (cut === "registered") {
            expect(
              (yield* attachmentDescriptor(yield* childAddressPath(address.sessionId))).owner,
            ).toBe(address.sessionId);
            expect(closed).toBe(false);
            yield* children.close();
          }
          joined = true;
        });
        yield* closing.operation;
        expect(joined).toBe(false);
        expect(closed).toBe(false);
        release.resolve();
        yield* stopping;
        expect(closed).toBe(true);
        yield* children.close();
      });
    }
  });
  it("H7/J6: supported startup resolves temporary symlinks and refuses an unsafe endpoint root", function* () {
    let directory: string | undefined;
    yield* ensure(function* () {
      if (directory !== undefined) {
        yield* rm(directory, { recursive: true, force: true });
      }
    });
    directory = yield* until(mkdtemp("/tmp/xmd-headless-private-"));
    const canonical = yield* until(realpath(directory));
    for (const root of [directory, canonical]) {
      yield* scoped(function* () {
        const held = yield* useHeadlessFixture(undefined, undefined, root);
        expect(held.path.startsWith(canonical + "/")).toBe(true);
        expect((yield* attachmentDescriptor(held.path)).owner).toBe(held.reference.sessionId);
        console.log(
          JSON.stringify({
            host: process.platform,
            input: root,
            resolved: canonical,
            endpointDirectory: held.path.slice(0, held.path.lastIndexOf("/")),
            outcome: "live exact handshake",
          }),
        );
        yield* held.task.halt();
      });
    }
    yield* until(chmod(directory, 0o777));
    const unsafe = yield* scoped(function* () {
      try {
        yield* useHeadlessFixture(undefined, undefined, directory);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("An unsafe endpoint directory was accepted.");
    });
    expect(unsafe).toContain("not writable by group or others");
    expect(unsafe).toMatch(/XMD child [a-f0-9-]{36} could not start/);
    yield* until(chmod(directory, 0o700));
  });
  it("H1: actual placement allocates before acquisition, live replay looks up and ended replay refuses", function* () {
    yield* usePosixSidekickTransport(process.platform);
    yield* API.Env.around({
      *command([args = []]) {
        const launch = cliCommand(args);
        return [launch.command, ...launch.arguments];
      },
    });
    const host = yield* useMountedHost({ hostFiles: true });
    const stream = new InMemoryStream();
    let acquired = 0;
    const children = yield* useHeadlessChildren(function* (headless) {
      const before = yield* stream.readAll();
      const allocation = z
        .object({
          type: z.literal("yield"),
          coroutineId: z.literal("root"),
          description: z
            .object({
              type: z.literal("xmd_session"),
              name: z.string().regex(/^[a-f0-9]{64}\/xmd-child$/),
            })
            .strict(),
          result: z
            .object({
              status: z.literal("ok"),
              value: z.object({ sessionId: z.string().uuid() }).strict(),
            })
            .strict(),
        })
        .strict()
        .parse(
          before.find(
            (event) => event.type === "yield" && event.description.type === "xmd_session",
          ),
        );
      expect(allocation.result.value.sessionId).not.toBe("worker");
      acquired += 1;
      const outcome = yield* runReplProgram({ profile: host.profile, root: host.root, headless });
      if (!outcome.ok) {
        throw outcome.error;
      }
    });
    yield* ensureDir(host.root);
    let reached = withResolvers<void>();
    const path = join(host.root, "placement.md");
    yield* writeTextFile(
      path,
      '<Agent name="xmd"><Session name="worker"><XMD.Session as="reference" /><Json value={reference} /></Session></Agent><Pending />',
    );
    const provider = children.factory({
      createRuntime: host.fake.create,
      agentRegistry: makeRegistry({}),
      sessionStore: makeStore(),
    });
    const execute = () =>
      scoped(function* () {
        const execution = yield* executeInstalled({ path, stream }, [
          {
            components: agentIdentityComponents(),
            *install() {
              yield* installAgentComponents({
                rootProvider: {
                  factory: provider,
                  options: { defaultAgent: "xmd", permissionMode: "deny-all" },
                },
              });
            },
          },
          children.installation,
          {
            components: [
              {
                name: "Pending",
                origin: "test",
                props: { type: "object", additionalProperties: false },
                factory() {
                  return function* () {
                    reached.resolve();
                    yield* suspend();
                    return null;
                  };
                },
              },
            ],
          },
        ]);
        const output = yield* execution.output;
        let next = yield* output.next();
        while (!next.done) {
          next = yield* output.next();
        }
        return { output: next.value, result: yield* execution };
      });
    for (let pass = 0; pass < 2; pass += 1) {
      reached = withResolvers<void>();
      const running = yield* spawn(execute);
      const result = yield* race([
        (function* () {
          yield* reached.operation;
          return undefined;
        })(),
        running,
      ]);
      expect(result).toBeUndefined();
      expect(acquired).toBe(1);
      yield* running.halt();
    }
    const chatHistory = new InMemoryStream();
    const chatStore = makeStore();
    const chatAttempt = (command: string) =>
      scoped(function* () {
        const assembly = sidekickAssembly("guide", {
          createRuntime: host.fake.create,
          agentRegistry: makeRegistry({ guide: command }),
          sessionStore: chatStore,
        });
        const opened = yield* useAgentConversation({
          history: chatHistory,
          id: "ordinary-sidekick-construction",
          agent: assembly.agent,
          installations: assembly.installations,
        });
        if (!opened.ok) {
          throw opened.error;
        }
        return yield* opened.value.prompt("continue");
      });
    host.fake.script({ reply: "first ordinary Sidekick" });
    const chatFirst = yield* chatAttempt("guide-original");
    if (!chatFirst.ok) {
      throw chatFirst.error;
    }
    const originalSession = host.fake.turns.at(-1)?.handle;
    host.fake.script({ reply: "second ordinary Sidekick" });
    const chatAgain = yield* chatAttempt("guide-original");
    if (!chatAgain.ok) {
      throw chatAgain.error;
    }
    expect(host.fake.turns.at(-1)?.handle.sessionKey).toBe(originalSession?.sessionKey);
    const beforeChange = {
      ensured: host.fake.ensured.length,
      turns: host.fake.turns.length,
      acquired,
    };
    // A changed adapter command continues the same held conversation through
    // today's command (#1221), and still never reaches a headless placement.
    host.fake.script({ reply: "changed ordinary Sidekick" });
    const chatChanged = yield* chatAttempt("guide-changed");
    if (!chatChanged.ok) {
      throw chatChanged.error;
    }
    expect(chatChanged.value).toBe("changed ordinary Sidekick");
    const changedEnsures = host.fake.ensured.slice(beforeChange.ensured);
    expect(changedEnsures.length).toBeGreaterThan(0);
    expect(changedEnsures.every((one) => one.sessionKey === originalSession?.sessionKey)).toBe(
      true,
    );
    expect(host.fake.turns.length).toBe(beforeChange.turns + 1);
    expect(host.fake.turns.at(-1)?.handle.sessionKey).toBe(originalSession?.sessionKey);
    expect(acquired).toBe(beforeChange.acquired);
    expect(JSON.stringify(yield* chatHistory.readAll())).not.toContain('"type":"xmd_session"');
    console.log(
      JSON.stringify({
        kind: "actual-sidekick-assembly-held-reopen",
        acquired,
        continuedSession: originalSession?.sessionKey,
        newEnsuresOnChange: changedEnsures.length,
        newTurnsOnChange: host.fake.turns.length - beforeChange.turns,
        retainedRecordCount: (yield* chatHistory.readAll()).length,
      }),
    );
    yield* children.close();
    const ended = yield* execute();
    expect(ended.result.ok).toBe(false);
    expect(acquired).toBe(1);
    expect(host.fake.prompts).toHaveLength(3);
    const causes: string[] = [];
    if (!ended.result.ok) {
      let failure: unknown = ended.result.error;
      while (failure instanceof Error) {
        causes.push(failure.message);
        failure = failure.cause;
      }
    }
    expect(
      causes.some((message) =>
        message.includes("unavailable or ended; no replacement was started"),
      ),
    ).toBe(true);
    console.log(JSON.stringify({ kind: "original-ended-cause-chain", causes }));
    console.log(
      JSON.stringify({
        kind: "actual-document-partial-replay",
        acquired,
        allocations: (yield* stream.readAll()).filter(
          (event) => event.type === "yield" && event.description.type === "xmd_session",
        ),
        ended: ended.result.ok ? "unexpected success" : ended.result.error.message,
      }),
    );
  });
  it("H2: opens, works and joins without acquiring the parent terminal", function* () {
    const host = yield* useMountedHost();
    let accesses = 0;
    function denied(): never {
      accesses += 1;
      throw new Error("headless work reached the parent terminal");
    }
    yield* ReplTerminal.around(
      {
        interactive: denied,
        size: denied,
        write: denied,
        writeNow: denied,
        setRaw: denied,
        input: denied,
        resizes: denied,
      },
      { at: "max" },
    );
    const view = yield* useReplLiveScreen();
    const ready = withResolvers<Parameters<HeadlessReplRoot["ready"]>[0]>();
    const closed = withResolvers<void>();
    const root = yield* spawn(function* () {
      yield* ensure(() => closed.resolve());
      return yield* runReplProgram({
        profile: host.profile,
        root: host.root,
        headless: {
          view,
          *ready(root) {
            ready.resolve(root);
          },
        },
      });
    });
    const child = yield* ready.operation;
    const submitted = yield* child.session.submit("<Output>headless work</Output>");
    if (!submitted.ok) {
      throw submitted.error;
    }
    const completed = yield* submitted.value.join();
    if (!completed.ok) {
      throw completed.error;
    }
    expect(child.session.overlay.output).toBeDefined();
    expect(view.connected).toBe(false);
    expect(accesses).toBe(0);
    yield* root.halt();
    yield* closed.operation;
    expect(accesses).toBe(0);
  });

  it("H1/H3: distinct same-labelled placements survive their entries and ended exact references never replace them", function* () {
    const held = yield* useHeadlessFixture();
    const first = held.reference.sessionId;
    const another = yield* held.root.session.submit(
      START_CHILD.replaceAll('as="child"', 'as="another"'),
    );
    if (!another.ok) {
      throw another.error;
    }
    const result = yield* another.value.join();
    if (!result.ok) {
      throw result.error;
    }
    const bindings = yield* held.root.session.bindings();
    if (!bindings.ok) {
      throw bindings.error;
    }
    const second = z
      .object({ sessionId: z.string() })
      .strict()
      .parse(bindings.value.another).sessionId;
    expect(second).not.toBe(first);
    expect((yield* attachmentDescriptor(held.path)).conversation).toBe(
      held.descriptor.conversation,
    );
    expect(held.host.fake.prompts).toHaveLength(0);
    yield* scoped(function* () {
      const foreign = yield* useHeadlessFixture();
      const denied = yield* foreign.root.session.submit(
        `<XMD.Session.Shutdown sessionId=${JSON.stringify(first)} />`,
      );
      if (!denied.ok) {
        throw denied.error;
      }
      const denial = yield* denied.value.join();
      expect(denial.ok).toBe(false);
      expect((yield* attachmentDescriptor(held.path)).execution).toBe(held.descriptor.execution);
      yield* foreign.task.halt();
    });
    const stop = yield* held.root.session.submit(
      "<XMD.Session.Shutdown sessionId={child.sessionId} />",
    );
    if (!stop.ok) {
      throw stop.error;
    }
    const stopped = yield* stop.value.join();
    if (!stopped.ok) {
      throw stopped.error;
    }
    for (const source of [
      '<Agent name="xmd"><XMD.Session sessionId={child.sessionId}><Prompt>Do not run.</Prompt></XMD.Session></Agent>',
      "<XMD.Session.Shutdown sessionId={child.sessionId} />",
    ]) {
      const submitted = yield* held.root.session.submit(source);
      if (!submitted.ok) {
        throw submitted.error;
      }
      expect((yield* submitted.value.join()).ok).toBe(false);
    }
    for (const target of [first, "00000000-0000-4000-8000-000000000001"]) {
      const error = yield* scoped(function* () {
        try {
          yield* attachChildUi(target);
        } catch (error) {
          return error;
        }
        throw new Error("An unavailable child acquired a UI.");
      });
      expect(error).toBeInstanceOf(Error);
    }
    expect(held.host.fake.prompts).toHaveLength(0);
    yield* held.task.halt();
  });

  it("H3: Shutdown and parent end wait for actual accepted socket cleanup", function* () {
    for (const ending of ["shutdown", "parent-end"]) {
      yield* scoped(function* () {
        let hold = false;
        const closing = withResolvers<void>();
        const release = withResolvers<void>();
        const held = yield* useHeadlessFixture(undefined, function* () {
          if (hold) {
            closing.resolve();
            yield* release.operation;
          }
        });
        const connection = yield* spawn(() =>
          scoped(function* () {
            const { wire, descriptor } = yield* (yield* SidekickTransport.expect()).connect(
              held.path,
            );
            yield* wire.send({ id: 0, request: { method: "hello", descriptor } });
            expect(Reply.parse(yield* wire.receive()).kind).toBe("value");
            hold = true;
            let joined = false;
            const joining = yield* spawn(function* () {
              if (ending === "shutdown") {
                const stop = yield* held.root.session.submit(
                  "<XMD.Session.Shutdown sessionId={child.sessionId} />",
                );
                if (!stop.ok) {
                  throw stop.error;
                }
                const result = yield* stop.value.join();
                if (!result.ok) {
                  throw result.error;
                }
              } else {
                yield* held.task.halt();
              }
              joined = true;
            });
            yield* closing.operation;
            expect(joined).toBe(false);
            release.resolve();
            yield* joining;
          }),
        );
        yield* connection;
        hold = false;
        yield* held.task.halt();
      });
    }
  });
  it("H1: reads the exact child before a Prompt without starting a turn", function* () {
    yield* usePosixSidekickTransport(process.platform);
    yield* API.Env.around({
      *command([args = []]) {
        const launch = cliCommand(args);
        return [launch.command, ...launch.arguments];
      },
    });
    const host = yield* useMountedHost();
    const view = yield* useReplLiveScreen();
    const ready = withResolvers<Parameters<HeadlessReplRoot["ready"]>[0]>();
    const root = yield* spawn(() =>
      runReplProgram({
        profile: host.profile,
        root: host.root,
        headless: {
          view,
          *ready(root) {
            ready.resolve(root);
          },
        },
      }),
    );
    const parent = yield* ready.operation;
    const submitted = yield* parent.session.submit(
      '<Agent name="xmd"><Session name="worker"><XMD.Session as="child" /><Json value={child} /></Session></Agent>',
    );
    if (!submitted.ok) {
      throw submitted.error;
    }
    const joined = yield* submitted.value.join();
    if (!joined.ok) {
      throw joined.error;
    }
    const output = yield* submitted.value.output();
    if (!output.ok) {
      throw output.error;
    }
    expect(host.fake.prompts).toHaveLength(0);
    const read = z
      .object({ sessionId: z.string().uuid() })
      .strict()
      .parse(JSON.parse(output.value.output));
    expect((yield* attachmentDescriptor(yield* childAddressPath(read.sessionId))).owner).toBe(
      read.sessionId,
    );
    yield* root.halt();
  });
});

function* useManagedRecoveryChild(publicationFailure: { armed: boolean }) {
  yield* usePosixSidekickTransport(process.platform);
  yield* API.Env.around({
    *command([args = []]) {
      const launch = cliCommand(args);
      return [launch.command, ...launch.arguments];
    },
  });
  const host = yield* useMountedHost({ hostFiles: true });
  const transport = yield* SidekickTransport.expect();
  yield* SidekickTransport.set({
    ...transport,
    *publish(path, descriptor) {
      if (publicationFailure.armed) {
        throw new Error("Fresh publication refused.");
      }
      return yield* transport.publish(path, descriptor);
    },
  });
  const ready = withResolvers<{
    root: Parameters<HeadlessReplRoot["ready"]>[0];
    headless: HeadlessReplRoot;
  }>();
  const children = yield* useHeadlessChildren(function* (headless) {
    const outcome = yield* runReplProgram({
      profile: host.profile,
      root: host.root,
      headless: {
        ...headless,
        *ready(root) {
          yield* headless.ready(root);
          ready.resolve({ root, headless });
        },
      },
    });
    if (!outcome.ok) {
      throw outcome.error;
    }
  });
  const factory = children.factory({
    createRuntime: host.fake.create,
    agentRegistry: makeRegistry({}),
    sessionStore: makeStore(),
  });
  const path = join(host.root, "managed-recovery.md");
  yield* ensureDir(host.root);
  yield* writeTextFile(
    path,
    '<Agent name="xmd"><Session><XMD.Session as="child" /><Json value={child} /></Session></Agent>',
  );
  const execution = yield* executeInstalled({ path, stream: new InMemoryStream() }, [
    children.installation,
    {
      components: agentIdentityComponents(),
      *install() {
        yield* installAgentComponents({
          rootProvider: { factory, options: { defaultAgent: "xmd", permissionMode: "deny-all" } },
        });
      },
    },
  ]);
  const output = yield* execution.output;
  let rendered = "";
  let next = yield* output.next();
  while (!next.done) {
    rendered += next.value;
    next = yield* output.next();
  }
  const ended = yield* execution;
  if (!ended.ok) {
    throw ended.error;
  }
  const reference = z.object({ sessionId: z.string().uuid() }).strict().parse(JSON.parse(rendered));
  return { host, children, reference, ...(yield* ready.operation) };
}

describe("987 — owned reference disposition", () => {
  for (const cut of ["publication", "active-unwind"]) {
    it(`keeps authoritative selection and reference lifetime at ${cut}`, function* () {
      const publication = { armed: false };
      const held = yield* useManagedRecoveryChild(publication);
      held.host.fake.script({ reply: "<REPL.Bindings />" });
      held.host.fake.script({ reply: "", failure: "Internal error" });
      yield* held.root.owner.message("Inspect established work.");
      const review = yield* held.root.owner.reviewRecovery();
      if (!review.ok) {
        throw review.error;
      }
      const preparedDirectory = yield* until(
        mkdtemp(join(yield* until(realpath(held.host.root)), "original-prepared-")),
      );
      const preparedPath = join(preparedDirectory, "attachment.json");
      yield* useSidekickAttachment(preparedPath, held.root);
      expect((yield* attachmentDescriptor(preparedPath)).conversation).toBe(
        review.value.conversation,
      );
      let fresh: string | undefined;
      publication.armed = cut === "publication";
      const result = yield* held.root.owner.recover(review.value, "A distinct instruction.", true, {
        current: () => true,
        *handoff(decision, activate) {
          const handoff = held.headless.handoffReference;
          if (handoff === undefined) {
            throw new Error("Expected actual manager handoff.");
          }
          const result = yield* handoff(
            { decision: decision.id, previous: decision.conversation, next: decision.target },
            function* (reference) {
              fresh = reference.sessionId;
              const selected = yield* activate();
              return selected.ok
                ? Err(new Error("Trusted continuation failed after activation."))
                : selected;
            },
          );
          return result.ok ? Err(new Error("Expected the controlled failure.")) : result;
        },
      });
      expect(result.ok).toBe(false);
      expect(held.host.fake.prompts).toHaveLength(2);
      const reading = held.root.owner.reading;
      if (!reading.ok) {
        throw reading.error;
      }
      if (cut === "publication") {
        expect(fresh).toBeUndefined();
        expect(reading.value.active).toBe(review.value.conversation);
        expect(
          (yield* attachmentDescriptor(yield* childAddressPath(held.reference.sessionId)))
            .conversation,
        ).toBe(review.value.conversation);
      } else {
        if (fresh === undefined) {
          throw new Error("Expected the actual published reference.");
        }
        const descriptor = yield* attachmentDescriptor(yield* childAddressPath(fresh));
        expect(descriptor.execution).toBe(held.root.execution);
        expect(descriptor.conversation).toBe(reading.value.active);
        expect(reading.value.active).not.toBe(review.value.conversation);
        let refused: Error | undefined;
        try {
          yield* requestAttachment(preparedPath, { method: "status" });
        } catch (error) {
          refused = error instanceof Error ? error : new Error(String(error));
        }
        expect(refused).toBeDefined();
      }
      expect(reading.value.recoveries[0]?.used).toBe(false);
      yield* held.children.close();
    });
  }
});

describe("987 — original child input ownership", () => {
  it("keeps an entry question through inspection, UI detach and same-original recovery", function* () {
    const held = yield* useManagedRecoveryChild({ armed: false });
    held.host.fake.script({ reply: "<REPL.Bindings />" });
    held.host.fake.script({ held: true, reply: "<Output>Interrupted feedback turn.</Output>" });
    const original = yield* spawn(() => held.root.owner.message("Inspect established work."));
    yield* held.host.fake.holdingTurns(1);
    const entry = yield* held.root.session.submit(
      '<Elicit as="answer" schema={{type:"object",properties:{answer:{type:"string"}},required:["answer"],additionalProperties:false}}>Original entry question.</Elicit>',
    );
    if (!entry.ok) {
      throw entry.error;
    }
    const changes = yield* held.root.session.elicitation.changes;
    while (held.root.session.elicitation.pending === undefined) {
      yield* changes.next();
    }
    const question = held.root.session.elicitation.pending;
    const path = yield* childAddressPath(held.reference.sessionId);
    const before = yield* attachmentDescriptor(path);
    for (let pass = 0; pass < 2; pass++) {
      const terminal = recordingTerminal();
      const ui = yield* spawn(function* () {
        yield* terminal.install();
        yield* attachChildUi(held.reference.sessionId);
      });
      yield* race([
        (function* () {
          while (!terminal.terminal.screen?.rows().some((one) => one.includes("[detach]"))) {
            yield* terminal.terminal.after(terminal.terminal.drawn);
          }
        })(),
        (function* () {
          yield* sleep(15000);
          throw new Error("The original child did not attach.");
        })(),
      ]);
      terminal.terminal.end();
      yield* ui;
      expect(held.root.session.elicitation.pending).toBe(question);
      const count = held.host.fake.prompts.length;
      yield* requestAttachment(path, { method: "status" });
      expect(held.host.fake.prompts).toHaveLength(count);
      if (pass === 0) {
        const review = yield* held.root.owner.reviewRecovery();
        if (!review.ok) {
          throw review.error;
        }
        held.host.fake.script({ reply: "<Output>Continue from the established result.</Output>" });
        const cleanup = held.host.fake.holdCancellation();
        yield* ensure(() => cleanup.release());
        const recovering = yield* spawn(() =>
          held.root.owner.recover(review.value, "Propose a distinct next step.", false, {
            current: () => true,
          }),
        );
        const stopping = yield* race([cleanup.reached, recovering]);
        if (stopping !== undefined) {
          throw new Error("The child recovery did not wait for its owned Stop.");
        }
        expect(held.host.fake.prompts).toHaveLength(2);
        expect(held.root.session.elicitation.pending).toBe(question);
        yield* requestAttachment(path, { method: "status" });
        cleanup.release();
        const result = yield* recovering;
        yield* original;
        if (!result.ok) {
          throw result.error;
        }
      }
    }
    expect(yield* attachmentDescriptor(path)).toEqual(before);
    expect(held.root.session.elicitation.pending).toBe(question);
    expect(held.root.session.model.entries).toHaveLength(1);
    expect(question?.submit({ answer: "Only the original owner answers." }).kind).toBe("answered");
    expect((yield* entry.value.join()).ok).toBe(true);
    expect(held.host.fake.prompts).toHaveLength(3);
    yield* held.children.close();
  });
});

describe("REPL Plugin session ownership", () => {
  it("R2: parent and child initialize once; UI and history reads initialize nothing", function* () {
    const workspaces: string[] = [];
    const stopped: string[] = [];
    let holdCleanup = false;
    const cleaning = withResolvers<void>();
    const release = withResolvers<void>();
    const plugin = Plugin({
      name: "session-counts",
      *install(): import("effection").Operation<ReplPluginInstallation> {
        yield* sleep(0);
        return {
          repl: {
            *initialize({ workspace }) {
              workspaces.push(workspace);
              yield* ensure(function* () {
                if (holdCleanup && workspace !== workspaces[0]) {
                  cleaning.resolve();
                  yield* release.operation;
                }
                stopped.push(workspace);
              });
            },
          },
        };
      },
    });
    const held = yield* useHeadlessFixture(undefined, undefined, undefined, undefined, {}, [
      plugin,
    ]);
    holdCleanup = true;
    expect(workspaces).toHaveLength(2);
    expect(new Set(workspaces).size).toBe(2);
    for (let pass = 0; pass < 2; pass++) {
      const terminal = recordingTerminal();
      const ui = yield* spawn(function* () {
        yield* terminal.install();
        yield* attachChildUi(held.reference.sessionId);
      });
      yield* race([
        (function* () {
          while (!terminal.terminal.screen?.rows().some((one) => one.includes("[detach]"))) {
            yield* terminal.terminal.after(terminal.terminal.drawn);
          }
        })(),
        (function* () {
          yield* sleep(15000);
          throw new Error("Child UI never attached");
        })(),
      ]);
      terminal.terminal.end();
      yield* ui;
      yield* requestAttachment(held.path, { method: "status" });
      expect(workspaces).toHaveLength(2);
    }
    const shutdown = yield* held.root.session.submit(
      "<XMD.Session.Shutdown sessionId={child.sessionId} />",
    );
    if (!shutdown.ok) {
      throw shutdown.error;
    }
    let joined = false;
    const joining = yield* spawn(function* () {
      const result = yield* shutdown.value.join();
      if (!result.ok) {
        throw result.error;
      }
      joined = true;
    });
    yield* cleaning.operation;
    expect(joined).toBe(false);
    release.resolve();
    yield* joining;
    expect(stopped).toEqual([workspaces[1]]);
    yield* held.task.halt();
    expect(stopped).toEqual([workspaces[1], workspaces[0]]);
  });
});
