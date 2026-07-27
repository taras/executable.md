/**
 * The resource boundary the agent smoke needs and Markdown cannot express:
 * a controller, a registered scenario, and an isolated home that all stay
 * alive while the body runs and are released once it finishes.
 *
 * The body reads what it needs through `{harness.*}`; sequencing and
 * assertions stay in the document.
 */

import { Component, env, useContent } from "@executablemd/core";
import type { EvalEnv, Json } from "@executablemd/core";
import { readTextFile } from "@executablemd/runtime";
import { useTestAgentController } from "@executablemd/test-agent";
import { ensure } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import * as os from "node:os";

export const inputs = {
  type: "object",
  properties: { scenario: { type: "string" } },
  required: ["scenario"],
  additionalProperties: false,
};

/**
 * ACPX splits an agent command on whitespace with quote support, so a
 * binary path containing spaces has to arrive quoted.
 */
function quote(segment: string): string {
  return `'${segment.replaceAll("'", `'\\''`)}'`;
}

function* useTemporaryDirectory(prefix: string): Operation<string> {
  const dir = resolve(os.tmpdir(), `${prefix}-${randomUUID()}`);
  yield* ensureDir(dir);
  yield* ensure(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export default function* (props: Record<string, Json>): Operation<string> {
  const binary = Deno.execPath();
  if (basename(binary).startsWith("deno")) {
    throw new Error(
      "AgentHarness runs the compiled binary as both harness and worker — " +
        "build it with `deno task build` and run this document with ./dist/xmd",
    );
  }

  const scenarioPath = resolve(String(props.scenario));
  const source = yield* readTextFile(scenarioPath);
  const home = yield* useTemporaryDirectory("xmd-smoke-home");
  const controller = yield* useTestAgentController();
  const scenario = yield* controller.useScenario({
    document: { path: basename(scenarioPath), source },
    rootDir: dirname(scenarioPath),
  });

  const parent = yield* env;
  const harness = {
    binary,
    home,
    agent: `${quote(binary)} test-agent --connect ${scenario.route}`,
  };
  const bodyEnv: EvalEnv = { values: { ...(parent?.values ?? {}), harness } };
  yield* Component.around({ env: () => bodyEnv }, { at: "min" });

  return yield* useContent();
}
