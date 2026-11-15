import type { AcpSessionRecord, AcpxSessionStore } from "@executablemd/acp";
import { createHash } from "node:crypto";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { env, readTextFile } from "@executablemd/runtime";
import { useTestAgentController } from "@executablemd/test-agent";
import type { ScenarioHandle } from "@executablemd/test-agent";
import { suspend, useScope, withResolvers } from "effection";
import type { Operation } from "effection";

export const SCRIPTED_AGENT_PREFIX = "xmd-test-";

export interface ScriptedSidekick {
  readonly agent: string;
  readonly denoDir: string | undefined;
  readonly store: AcpxSessionStore;
  hasScenario(conversation: string): boolean;
  worker(conversation: string): Operation<string[]>;
}

export function sidekickFixturePath(selection: string, directory: string): string | undefined {
  if (extname(selection) === ".md" && (selection.includes("/") || selection.includes(sep))) {
    return resolve(directory, selection);
  }
  return undefined;
}

export function* prepareScriptedSidekick(
  path: string,
  workerCommand: readonly string[],
): Operation<ScriptedSidekick> {
  let source: string;
  try {
    source = yield* readTextFile(path);
  } catch (cause) {
    throw new Error(`Cannot read Sidekick behavior file "${path}": ${cause}`, {
      cause,
    });
  }

  const controller = yield* useTestAgentController();
  const scope = yield* useScope();
  const denoDir = yield* env("DENO_DIR");
  const sessions = new Map<string, AcpSessionRecord>();
  const scenarios = new Map<string, Operation<ScenarioHandle>>();
  const identity = createHash("sha256")
    .update(path)
    .update("\0")
    .update(source)
    .digest("base64url")
    .slice(0, 12);
  return {
    agent: SCRIPTED_AGENT_PREFIX + identity,
    denoDir,
    store: {
      load: (id) => Promise.resolve(sessions.get(id)),
      save(record) {
        sessions.set(record.acpxRecordId, record);
        return Promise.resolve();
      },
    },
    hasScenario: (conversation) => scenarios.has(conversation),
    *worker(conversation) {
      let scenario = scenarios.get(conversation);
      if (scenario === undefined) {
        const ready = withResolvers<ScenarioHandle>();
        scenario = ready.operation;
        scenarios.set(conversation, scenario);
        // The scenario's journal survives releasing this conversation's ACP connection.
        scope.run(function* () {
          ready.resolve(
            yield* controller.useScenario({
              document: { path: basename(path), source },
              rootDir: dirname(path),
            }),
          );
          yield* suspend();
        });
      }
      return [...workerCommand, "--connect", (yield* scenario).route];
    },
  };
}
