import { childRuntime } from "./runtime.ts";
import { ensure, Err, Ok, scoped, useScope, withResolvers } from "effection";
import type { Operation, Result, Task } from "effection";
import { ensureDir } from "@effectionx/fs";
import { Agent, content, hasContent } from "@executablemd/core";
import type { AgentProviderFactory, Json } from "@executablemd/core";
import { createDurableOperation } from "@executablemd/durable-streams";
import {
  createAcpRuntime,
  createAcpxProvider,
  createAgentRegistry,
  resolveSessionDetails,
} from "@executablemd/acp";
import type { Descriptor } from "../sidekick-acp/protocol.ts";
import type { AcpxProviderDependencies } from "@executablemd/acp";
import { command, cwd } from "@executablemd/runtime";
import { join } from "node:path";
import { z } from "zod";
import type { HeadlessReplRoot } from "../repl/program.ts";
import { useReplLiveScreen } from "../repl/live-screen.ts";
import type { ReplLiveScreen } from "../repl/live-screen.ts";
import { ReplStorage } from "../repl/storage.ts";
import { SidekickTransport } from "../sidekick-acp/protocol.ts";
import { useSidekickAttachment } from "../sidekick-acp/server.ts";

type Root = Parameters<HeadlessReplRoot["ready"]>[0];
const reference = z.object({ sessionId: z.string().uuid() }).strict();
export function* childAddressPath(sessionId: string): Operation<string> {
  const id = reference.parse({ sessionId }).sessionId;
  const transport = yield* SidekickTransport.expect();
  const base = yield* ReplStorage.operations.dataRoot();
  yield* ensureDir(base);
  const canonical =
    transport.canonicalDirectory === undefined ? base : yield* transport.canonicalDirectory(base);
  const directory = join(canonical, "xmd", "live");
  yield* ensureDir(directory);
  const resolved =
    transport.canonicalDirectory === undefined
      ? directory
      : yield* transport.canonicalDirectory(directory);
  return join(resolved, `${id}.json`);
}

interface Child {
  readonly sessionId: string;
  readonly root: Root;
  readonly view: ReplLiveScreen;
  readonly task: Task<Result<void>>;
  close(): Operation<void>;
  readonly path: string;
  readonly descriptor: Descriptor;
}
interface Allocation {
  readonly sessionId: string;
  readonly fresh: boolean;
  attempted: boolean;
}
export interface HeadlessChildren {
  factory(dependencies: AcpxProviderDependencies): AgentProviderFactory;
  installation: import("@executablemd/core/host").ExecutionInstallation;
  close(): Operation<void>;
}

export function* useHeadlessChildren(
  start: (host: HeadlessReplRoot) => Operation<void>,
): Operation<HeadlessChildren> {
  const parent = yield* useScope();
  const live = new Map<string, Child>();
  const issued = new WeakMap<object, string>();
  let ended = false;

  function owned(sessionId: string): Child {
    const child = live.get(sessionId);
    if (ended || child === undefined) {
      throw new Error(
        `XMD child ${sessionId} is unavailable or ended; no replacement was started.`,
      );
    }
    return child;
  }

  function lookup(sessionId: string): Child {
    const child = owned(sessionId);
    const reading = child.root.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    if (reading.value.active !== child.descriptor.conversation) {
      throw new Error(
        `XMD child ${sessionId} no longer selects its original Sidekick conversation.`,
      );
    }
    return child;
  }

  function* acquire(allocation: Allocation): Operation<Child> {
    const known = live.get(allocation.sessionId);
    if (known !== undefined) {
      return lookup(allocation.sessionId);
    }
    if (!allocation.fresh || allocation.attempted || ended) {
      return lookup(allocation.sessionId);
    }
    allocation.attempted = true;
    const ready = withResolvers<Result<Child>>();
    const closed = withResolvers<Result<void>>();
    let failure: Error | undefined;
    let established = false;
    let reported: Error | undefined;
    let task: Task<Result<void>> | undefined;
    yield* ensure(function* () {
      if (!established && task !== undefined) {
        yield* task.halt();
        const joined = yield* closed.operation;
        if (!joined.ok && joined.error !== reported) {
          throw joined.error;
        }
      }
    });
    const childTask = parent.run(function* (): Operation<Result<void>> {
      try {
        yield* scoped(function* () {
          const view = yield* useReplLiveScreen();
          yield* start({
            view,
            *ready(root) {
              const selected = yield* root.owner.configure({});
              if (!selected.ok) {
                throw selected.error;
              }
              const path = yield* childAddressPath(allocation.sessionId);
              const descriptor = yield* useSidekickAttachment(path, {
                owner: root.owner,
                dispatch: root.dispatch,
                reads: root.reads,
                execution: root.execution,
                cwd: root.cwd,
                child: { sessionId: allocation.sessionId, session: root.session, view },
              });
              const child: Child = {
                sessionId: allocation.sessionId,
                root,
                view,
                path,
                descriptor,
                task: childTask,
                *close() {
                  yield* childTask.halt();
                  const joined = yield* closed.operation;
                  if (!joined.ok) {
                    throw joined.error;
                  }
                },
              };
              live.set(child.sessionId, child);
              established = true;
              ready.resolve(Ok(child));
            },
          });
        });
        return Ok(undefined);
      } catch (cause) {
        const original = cause instanceof Error ? cause : new Error(String(cause));
        const error = established
          ? original
          : new Error(`XMD child ${allocation.sessionId} could not start: ${original.message}`, {
              cause: original,
            });
        failure = error;
        Object.defineProperty(error, "sessionId", { value: allocation.sessionId });
        ready.resolve(Err(error));
        return Err(error);
      } finally {
        live.delete(allocation.sessionId);
        closed.resolve(failure === undefined ? Ok(undefined) : Err(failure));
      }
    });
    task = childTask;
    const result = yield* ready.operation;
    if (!result.ok) {
      reported = result.error;
      yield* childTask;
      throw result.error;
    }
    return result.value;
  }

  const host: HeadlessChildren = {
    factory(dependencies) {
      return function* (options, coordinator) {
        const providerScope = yield* useScope();
        const setups = new Map<string, { allocation?: Allocation }>();
        const baseRegistry = dependencies.agentRegistry ?? createAgentRegistry();
        let launch: string[] | undefined;
        const createRuntime = dependencies.createRuntime ?? createAcpRuntime;
        function workingCwd(): Operation<string> {
          return dependencies.agentCwd === undefined ? cwd() : dependencies.agentCwd();
        }
        const base = createAcpxProvider({
          ...dependencies,
          agentRegistry: {
            resolve(name) {
              if (name !== "xmd") {
                return baseRegistry.resolve(name);
              }
              if (launch === undefined) {
                throw new Error("The XMD backend command has not been prepared.");
              }
              return [...launch];
            },
            list: () => [...new Set([...baseRegistry.list(), "xmd"])],
          },
          *prepareAgent(name) {
            if (name === "xmd") {
              launch ??= yield* command(["sidekick", "child-acp"]);
            } else if (dependencies.prepareAgent !== undefined) {
              yield* dependencies.prepareAgent(name);
            }
          },
          createRuntime(runtimeOptions) {
            return childRuntime(
              runtimeOptions,
              createRuntime,
              providerScope,
              (id) => lookup(id).path,
            );
          },
          sessions: {
            *requestSession(request) {
              if (request.agentName !== "xmd") {
                if (dependencies.sessions === undefined) {
                  if (dependencies.sessionStore === undefined) {
                    throw new Error(
                      "The trusted XMD assembly requires the existing ACP session store.",
                    );
                  }
                  return yield* resolveSessionDetails(
                    dependencies.sessionStore,
                    request.agentCommand,
                    yield* workingCwd(),
                    request.session,
                  );
                }
                return yield* dependencies.sessions.requestSession(request);
              }
              const identity = request.sessionIdentity;
              if (identity === undefined) {
                const selected = lookup(reference.parse({ sessionId: request.session }).sessionId);
                return {
                  sessionKey: selected.sessionId,
                  cwd: selected.root.cwd,
                  state: "existing",
                };
              }
              const setup = setups.get(identity);
              if (setup === undefined) {
                throw new Error("XMD placement has no genuine delivered Session setup.");
              }
              let fresh = false;
              const address: unknown = yield createDurableOperation(
                { type: "xmd_session", name: `${identity}/xmd-child` },
                function* () {
                  fresh = true;
                  return { sessionId: (yield* SidekickTransport.expect()).identify() };
                },
              );
              setup.allocation = { ...reference.parse(address), fresh, attempted: false };
              return {
                sessionKey: setup.allocation.sessionId,
                cwd: yield* workingCwd(),
                state: "new",
              };
            },
            *recordSessionIdentity(details, identity) {
              if (live.has(details.sessionKey)) {
                lookup(details.sessionKey);
              } else if (dependencies.sessions !== undefined) {
                yield* dependencies.sessions.recordSessionIdentity(details, identity);
              }
            },
          },
        });
        yield* base(options, {
          ...coordinator,
          sessionSetup(request) {
            const genuine = coordinator.sessionSetup(request);
            const identity = genuine.sessionIdentity;
            if (identity === undefined) {
              return genuine;
            }
            const slot: { allocation?: Allocation } = {};
            setups.set(identity, slot);
            return {
              sessionIdentity: identity,
              *activate(provider, agent, configuration) {
                setups.delete(identity);
                const accepted = yield* genuine.activate(provider, agent, configuration);
                if (!accepted.ok) {
                  return accepted;
                }
                if (slot.allocation !== undefined) {
                  yield* acquire(slot.allocation);
                }
                return accepted;
              },
              *finish(session, state) {
                const settled = yield* genuine.finish(session, state);
                if (slot.allocation !== undefined) {
                  issued.set(settled, slot.allocation.sessionId);
                }
                return settled;
              },
            };
          },
        });
      };
    },
    installation: {
      components: [
        {
          name: "XMD.Session",
          description:
            'Read or select a parent-owned XMD child. `<XMD.Session as="child" />` reads exactly `{sessionId}` in an XMD Session; `<XMD.Session sessionId={child.sessionId}><Prompt>Continue.</Prompt></XMD.Session>` selects the same live child in a later entry. Attach with `xmd repl --attach <sessionId>`. An ended reference refuses.',
          as: "The read form captures the exact {sessionId} object. The paired selection captures its rendered content.",
          origin: "@executablemd/cli",
          props: {
            type: "object",
            properties: { sessionId: { type: "string" } },
            additionalProperties: false,
          },
          factory: () =>
            function* (props): Operation<Json> {
              const selected =
                typeof props.sessionId === "string"
                  ? reference.parse({ sessionId: props.sessionId }).sessionId
                  : undefined;
              const session = yield* Agent.operations.session(selected);
              const id = selected ?? issued.get(session);
              if (id === undefined) {
                throw new Error(
                  "XMD.Session requires the exact Session issued by this parent's trusted XMD placement.",
                );
              }
              const child = lookup(id);
              if (selected !== undefined) {
                if (session.sessionKey !== selected) {
                  throw new Error("The selected Session belongs to another child.");
                }
                issued.set(session, selected);
              }
              if (!(yield* hasContent())) {
                return { sessionId: child.sessionId };
              }
              yield* Agent.around(
                {
                  *session([name], next) {
                    return name === undefined ? session : yield* next(name);
                  },
                  *prompt([text, options], next) {
                    return yield* next(text, { session, ...options });
                  },
                },
                { at: "min" },
              );
              return yield* content();
            },
        },
        {
          name: "XMD.Session.Shutdown",
          description:
            "Stop a child owned by this parent REPL. `<XMD.Session.Shutdown sessionId={child.sessionId} />` returns after its cleanup joins. Detaching its UI leaves it alive.",
          as: "Optional. null after the child's cleanup joins.",
          forms: ["self-closing"],
          origin: "@executablemd/cli",
          props: {
            type: "object",
            required: ["sessionId"],
            properties: { sessionId: { type: "string" } },
            additionalProperties: false,
          },
          factory: () =>
            function* (props): Operation<Json> {
              const child = owned(reference.parse(props).sessionId);
              yield* child.close();
              return null;
            },
        },
      ],
    },
    *close() {
      ended = true;
      const failures: Error[] = [];
      for (const child of [...live.values()]) {
        try {
          yield* child.close();
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "XMD child cleanup failed.");
      }
    },
  };
  yield* ensure(host.close);
  return host;
}
