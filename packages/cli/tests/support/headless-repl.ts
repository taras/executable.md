import {
  createSignal,
  ensure,
  race,
  scoped,
  sleep,
  spawn,
  until,
  useScope,
  withResolvers,
} from "effection";
import type { Operation } from "effection";
import { API } from "@executablemd/runtime";
import { cliCommand } from "@executablemd/test-support/launch";
import { createAcpRuntime } from "@executablemd/acp";
import type { AcpRuntimeTurnInput, ProbeCapableRuntime } from "@executablemd/acp";
import type { AcpPermissionRequest, AcpRuntimeEvent } from "../../../acp/src/acpx-runtime.ts";
import { z } from "zod";
import process from "node:process";
import { usePosixSidekickTransport } from "../../src/sidekick-acp/posix.ts";
import { useMountedHost, MOUNTED_AGENT } from "./mounted-repl.ts";
import { makeRegistry, makeStore } from "./fake-acp.ts";
import { resolveAgentStack } from "../../src/agent-stack.ts";
import { assembleReplProfile } from "../../src/repl-profile.ts";
import { NO_PLUGINS } from "../../src/plugin-host.ts";
import { runReplProgram } from "../../src/repl/program.ts";
import type { ReplInputPass, HeadlessReplRoot } from "../../src/repl/program.ts";
import { useReplLiveScreen } from "../../src/repl/live-screen.ts";
import { childAddressPath } from "../../src/headless/host.ts";
import { attachmentDescriptor } from "../../src/sidekick-acp/client.ts";
import { SidekickTransport } from "../../src/sidekick-acp/protocol.ts";
import { physical, applied, presentation } from "../../src/headless/ui-schema.ts";
import type { Terminal } from "./mounted-repl.ts";
import type { ReplScreenEvent } from "../../src/repl/screen.ts";

interface ObservedConnection {
  readonly execution: string;
  readonly inputs: { event: ReplScreenEvent; index: number; matched: boolean }[];
  readonly completed: Map<number, boolean>;
  frame?: z.infer<typeof presentation>;
  acknowledged?: number;
  ready?: ReplInputPass;
  ended: boolean;
}

/** Observe host input settlement; a client write alone establishes no ready frame. */
function* observeChildPasses() {
  const changed = createSignal<void, void>();
  const connections: ObservedConnection[] = [];
  let heldAck:
    | {
        reached: ReturnType<typeof withResolvers<void>>;
        release: ReturnType<typeof withResolvers<void>>;
      }
    | undefined;
  let heldRelease:
    | {
        reached: ReturnType<typeof withResolvers<void>>;
        release: ReturnType<typeof withResolvers<void>>;
      }
    | undefined;
  const transport = yield* SidekickTransport.expect();
  yield* SidekickTransport.set({
    ...transport,
    *publish(path, descriptor) {
      const listener = yield* transport.publish(path, descriptor);
      return {
        ...listener,
        *accept() {
          const incoming = yield* listener.accept();
          return (function* () {
            const wire = yield* incoming;
            let connection: ObservedConnection | undefined;
            yield* ensure(function* () {
              if (connection !== undefined) {
                connection.ended = true;
                connection.ready = undefined;
                changed.send();
                const gate = heldRelease;
                heldRelease = undefined;
                if (gate !== undefined) {
                  gate.reached.resolve();
                  yield* gate.release.operation;
                }
              }
            });
            return {
              *receive() {
                const packet = yield* wire.receive();
                const request = z
                  .object({ request: z.object({ method: z.literal("ui") }).passthrough() })
                  .passthrough()
                  .safeParse(packet);
                if (request.success) {
                  connection = {
                    execution: descriptor.execution,
                    inputs: [],
                    completed: new Map(),
                    ended: false,
                  };
                  connections.push(connection);
                }
                if (connection !== undefined) {
                  const event = physical.safeParse(packet);
                  if (event.success && event.data.kind !== "eof") {
                    connection.inputs.push({
                      event: event.data,
                      index: connection.inputs.length + 1,
                      matched: false,
                    });
                  }
                  const acknowledgement = applied.safeParse(packet);
                  if (acknowledgement.success) {
                    const gate = heldAck;
                    heldAck = undefined;
                    if (gate !== undefined) {
                      gate.reached.resolve();
                      yield* gate.release.operation;
                    }
                    if (acknowledgement.data.applied) {
                      connection.acknowledged = acknowledgement.data.sequence;
                    }
                  }
                }
                return packet;
              },
              *send(packet) {
                const frame = presentation.safeParse(packet);
                if (connection !== undefined && frame.success) {
                  connection.frame = { ...frame.data, bytes: [...frame.data.bytes] };
                }
                yield* wire.send(packet);
              },
              close() {
                wire.close();
                if (connection !== undefined) {
                  connection.ended = true;
                  connection.ready = undefined;
                  changed.send();
                }
              },
            };
          })();
        },
      };
    },
  });
  function matching(terminal: Terminal): ObservedConnection | undefined {
    return connections.findLast((one) => {
      const last = terminal.presented.at(-1);
      return (
        !one.ended &&
        one.ready?.view.connected &&
        one.ready.generation === one.ready.view.generation &&
        one.frame !== undefined &&
        one.acknowledged === one.frame.sequence &&
        last !== undefined &&
        last.length === one.frame.bytes.length &&
        one.frame.bytes.every((byte, index) => last[index] === byte)
      );
    });
  }
  function wait(
    terminal: Terminal,
    input?: { connection: ObservedConnection; index: number },
  ): Operation<ObservedConnection> {
    return race([
      (function* () {
        const changes = yield* changed;
        while (true) {
          const connection = matching(terminal);
          if (
            connection !== undefined &&
            (input === undefined ||
              (connection === input.connection && connection.completed.has(input.index)))
          ) {
            if (input !== undefined && !connection.completed.get(input.index)) {
              throw new Error("The host rejected the observed input.");
            }
            return connection;
          }
          yield* changes.next();
        }
      })(),
      (function* (): Operation<never> {
        yield* sleep(15000);
        throw new Error(`No completed child input/frame: ${terminal.screen?.rows().join("\n")}`);
      })(),
    ]);
  }
  return {
    observe(reading: ReplInputPass): void {
      const connection = connections.findLast(
        (one) => !one.ended && one.execution === reading.execution,
      );
      if (connection === undefined) {
        return;
      }
      connection.ready = undefined;
      if (reading.phase === "complete") {
        for (const handled of reading.events) {
          const input = connection.inputs.find(
            (one) => !one.matched && JSON.stringify(one.event) === JSON.stringify(handled.event),
          );
          if (input !== undefined) {
            input.matched = true;
            connection.completed.set(input.index, handled.accepted);
          }
        }
        connection.ready = reading;
      }
      changed.send();
    },
    ready: (terminal: Terminal) => wait(terminal),
    *input(terminal: Terminal, bytes: string) {
      const connection = yield* wait(terminal);
      const index = connection.inputs.length + 1;
      terminal.feed(bytes);
      yield* wait(terminal, { connection, index });
    },
    holdUiRelease() {
      const reached = withResolvers<void>();
      const release = withResolvers<void>();
      heldRelease = { reached, release };
      return { reached: reached.operation, release: release.resolve };
    },
    holdNextAcknowledgement() {
      const reached = withResolvers<void>();
      const release = withResolvers<void>();
      heldAck = { reached, release };
      return { reached: reached.operation, release: release.resolve };
    },
  };
}

export const REFERENCE_SCHEMA = {
  type: "object",
  properties: { sessionId: { type: "string" } },
  required: ["sessionId"],
  additionalProperties: false,
};
export const START_CHILD = `<Parse as="child" schema={${JSON.stringify(REFERENCE_SCHEMA)}}><Agent name="xmd"><Session name="worker"><XMD.Session as="started" /><Json value={started} /></Session></Agent></Parse>`;

export function* useHeadlessFixture(
  intercept?: (input: AcpRuntimeTurnInput) => AcpRuntimeTurnInput,
  beforeClose?: () => Operation<void>,
  dataRoot?: string,
  native?: {
    event?(event: AcpRuntimeEvent): void;
    /** Replace one raw ACP runtime event before `consumeTurn` reads it. */
    transform?(event: AcpRuntimeEvent): AcpRuntimeEvent;
    permission?(request: AcpPermissionRequest): void;
    beforeClose?(): Operation<void>;
  },
) {
  const scope = yield* useScope();
  yield* usePosixSidekickTransport(process.platform, undefined, beforeClose);
  yield* API.Env.around({
    *command([args = []]) {
      const launch = cliCommand(args);
      return [launch.command, ...launch.arguments];
    },
  });
  const input = yield* observeChildPasses();
  const host = yield* useMountedHost({
    hostFiles: true,
    ...(dataRoot === undefined ? {} : { dataRoot }),
  });
  const stack = yield* resolveAgentStack(
    {
      agentProvider: "acpx",
      defaultAgent: MOUNTED_AGENT,
      approveAll: false,
      approveReads: false,
      denyAll: false,
    },
    undefined,
  );
  if (!stack.ok) {
    throw stack.error;
  }
  const store = makeStore();
  const view = yield* useReplLiveScreen();
  const ready = withResolvers<Parameters<HeadlessReplRoot["ready"]>[0]>();
  const task = yield* spawn(function* () {
    const profile = yield* assembleReplProfile(stack.value, NO_PLUGINS, {
      sidekickAgent: MOUNTED_AGENT,
      observeChildInputPass: input.observe,
      acp: {
        sessionStore: store,
        agentRegistry: makeRegistry({ [MOUNTED_AGENT]: `${MOUNTED_AGENT}-cmd` }),
        createRuntime(options) {
          if (!options.elicitationModes?.includes("form")) {
            return host.fake.create(options);
          }
          const permission = options.onPermissionRequest;
          const runtime: ProbeCapableRuntime = createAcpRuntime(
            native?.permission === undefined
              ? options
              : {
                  ...options,
                  onPermissionRequest(request, context) {
                    native.permission?.(request);
                    if (permission === undefined) {
                      throw new Error("The actual parent permission callback is absent.");
                    }
                    return permission(request, context);
                  },
                },
          );
          const start = runtime.startTurn.bind(runtime);
          runtime.startTurn = (input) => {
            const turn = start(intercept?.(input) ?? input);
            const source = turn.events[Symbol.asyncIterator]();
            return {
              ...turn,
              events: {
                [Symbol.asyncIterator]() {
                  return {
                    next: () =>
                      source.next().then((next) => {
                        if (next.done) {
                          return next;
                        }
                        native?.event?.(next.value);
                        const transform = native?.transform;
                        return transform === undefined
                          ? next
                          : { ...next, value: transform(next.value) };
                      }),
                  };
                },
              },
            };
          };
          const beforeClose = native?.beforeClose;
          if (beforeClose !== undefined) {
            const close = runtime.close.bind(runtime);
            runtime.close = (input) =>
              scope.run(function* () {
                yield* beforeClose();
                yield* until(close(input));
              });
          }
          return runtime;
        },
      },
    });
    return yield* runReplProgram({
      profile,
      root: host.root,
      headless: {
        view,
        *ready(root) {
          ready.resolve(root);
        },
      },
    });
  });
  const root = yield* ready.operation;
  const started = yield* root.session.submit(START_CHILD);
  if (!started.ok) {
    throw started.error;
  }
  const joined = yield* started.value.join();
  if (!joined.ok) {
    throw joined.error;
  }
  const bindings = yield* root.session.bindings();
  if (!bindings.ok) {
    throw bindings.error;
  }
  const reference = z.object({ sessionId: z.string().uuid() }).strict().parse(bindings.value.child);
  const path = yield* childAddressPath(reference.sessionId);
  const descriptor = yield* attachmentDescriptor(path);
  return { host, root, task, view, reference, path, descriptor, store, input };
}

export function promptChild(text: string): string {
  return `<Agent name="xmd"><XMD.Session sessionId={child.sessionId}><Prompt text=${JSON.stringify(text)} throwOnError /></XMD.Session></Agent>`;
}
