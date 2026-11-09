import { main, scoped, type Operation } from "effection";
import { rm, writeTextFile, exists } from "@effectionx/fs";
import { join } from "node:path";
import process from "node:process";
import { readdir, readFile } from "node:fs/promises";
import { until } from "effection";
import { workflowProviderSessions } from "@executablemd/workflow/deno";
import { DatabaseSync } from "node:sqlite";
import { agentIdentityComponents, collect, retainedSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { API, useHostFiles } from "@executablemd/runtime";
import { createEmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import {
  withWorkflowWorkspace,
  workflowRunPath,
  transactAgentPromptCheckpoints,
} from "@executablemd/workflow/deno";
import { useWorkflowAgentProfile } from "../../src/workflow-agent.ts";
import { createRun, withStorage } from "../support/workflow-run.ts";

const root = process.argv[2];
if (!root) {
  throw new Error("missing private test root");
}
const agent = process.argv[3] === "codex" ? "codex" : "claude";
const sessionAttributes = process.argv[4] ?? "";
const source = `<Agent name="${agent}"><Session name="review"${sessionAttributes}><Prompt>HC exact user prompt</Prompt></Session></Agent>`;
const adapters = createEmbeddedAdapters(join(root, "adapters"));
const environment = { ...process.env };

main(function* () {
  yield* useHostFiles();
  yield* API.Env.around({
    // deno-lint-ignore require-yield
    *cwd() {
      return "/";
    },
  });
  yield* withStorage(root, function* () {
    const database = yield* createRun();
    const attach = (replay: boolean) =>
      withWorkflowWorkspace(
        database,
        scoped(function* () {
          return yield* collect(
            yield* executeInstalled(
              {
                ...retainedSource("hc.md", source),
                stream: database.journal,
              },
              [{ components: agentIdentityComponents() }],
            ),
          );
        }),
        {
          agent: (attachment) =>
            useWorkflowAgentProfile({
              root,
              attachment,
              adapters: replay
                ? {
                    ...adapters,
                    *materialize() {
                      throw new Error("completed replay materialized an adapter");
                    },
                  }
                : adapters,
              ...(replay
                ? {
                    agentProcessEnv: function* () {
                      throw new Error("completed replay selected a host executable");
                    },
                    createRuntime: () => {
                      throw new Error("completed replay created a runtime");
                    },
                  }
                : {}),
            }),
        },
      );
    let output;
    let failure;
    let failureMembers: string[] = [];
    try {
      output = yield* attach(false);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      if (error instanceof AggregateError) {
        failureMembers = error.errors.map((member) =>
          member instanceof Error ? member.message : String(member),
        );
      }
    }
    const connection = new DatabaseSync(workflowRunPath(root, database.record.runId), {
      readOnly: true,
    });
    let mappings;
    try {
      mappings = connection.prepare("SELECT * FROM agent_sessions").all();
    } finally {
      connection.close();
    }
    const records: string[] = [];
    const store = join(workflowProviderSessions(root, database.record.runId), "store");
    function* readRecords(directory: string): Operation<void> {
      if (!(yield* exists(directory))) {
        return;
      }
      for (const entry of yield* until(readdir(directory, { withFileTypes: true }))) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          yield* readRecords(path);
        } else {
          records.push(yield* until(readFile(path, "utf8")));
        }
      }
    }
    yield* readRecords(store);
    const journal = yield* database.journal.readAll();
    const checkpoints = yield* transactAgentPromptCheckpoints(database, function* (table) {
      return table.readAll();
    });
    let replayOutput;
    let replayFailure;
    if (failure === undefined) {
      yield* rm(join(root, "host bin", agent), { force: true });
      try {
        replayOutput = yield* attach(true);
      } catch (error) {
        replayFailure = error instanceof Error ? error.message : String(error);
      }
    }
    yield* writeTextFile(
      join(root, "report.json"),
      JSON.stringify({
        output,
        failure,
        failureMembers,
        mappings,
        journal,
        records,
        environmentPreserved: [
          ...new Set([...Object.keys(environment), ...Object.keys(process.env)]),
        ].every((key) => environment[key] === process.env[key]),
        checkpoints,
        replayOutput,
        replayFailure,
      }),
    );
  });
});
