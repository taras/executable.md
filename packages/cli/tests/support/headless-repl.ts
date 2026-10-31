import { spawn, until, useScope, withResolvers } from "effection";
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
import type { HeadlessReplRoot } from "../../src/repl/program.ts";
import { useReplLiveScreen } from "../../src/repl/live-screen.ts";
import { childAddressPath } from "../../src/headless/host.ts";
import { attachmentDescriptor } from "../../src/sidekick-acp/client.ts";

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
                        if (!next.done) {
                          native?.event?.(next.value);
                        }
                        return next;
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
  return { host, root, task, view, reference, path, descriptor, store };
}

export function promptChild(text: string): string {
  return `<Agent name="xmd"><XMD.Session sessionId={child.sessionId}><Prompt text=${JSON.stringify(text)} throwOnError /></XMD.Session></Agent>`;
}
