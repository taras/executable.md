/**
 * Tier XA — acceptance: `createAcpxProvider()` installed through core's #135
 * `rootProvider` seam drives the full Agent → session → prompt → teardown
 * lifecycle. Fake ACPX runtime, no subprocess.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { execute, installAgentComponents } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { createAcpxProvider } from "../mod.ts";
import { createFakeRuntime, makeRegistry, makeStore, useFlatWorld } from "./helpers.ts";

const CWD = "/work";
const DOC = [
  '<Agent name="codex">',
  '<Session name="review">',
  '<Prompt text="hi" />',
  "</Session>",
  "</Agent>",
  "",
].join("\n");

describe("Tier XA — ACPX provider through the rootProvider seam", () => {
  it("XA1: agent availability → session → normalized prompt → structured teardown", function* () {
    const harness = createFakeRuntime();
    const dir = path.join(os.tmpdir(), `xmd-acp-accept-${randomUUID()}`);
    yield* ensureDir(dir);
    try {
      const docPath = path.join(dir, "doc.md");
      yield* writeTextFile(docPath, DOC);

      const result = yield* scoped(function* () {
        yield* useFlatWorld(CWD);
        yield* installAgentComponents({
          rootProvider: {
            factory: createAcpxProvider({
              createRuntime: harness.create,
              sessionStore: makeStore(),
              agentRegistry: makeRegistry({ codex: "codex-cmd" }),
            }),
            options: { defaultAgent: "codex", permissionMode: "deny-all" },
          },
        });

        const execution = yield* execute({ docPath, stream: new InMemoryStream() });
        const subscription = yield* execution.output;
        let next = yield* subscription.next();
        while (!next.done) {
          next = yield* subscription.next();
        }
        const output = next.value;
        const outcome = yield* execution;
        // Structured teardown: the handle is closed by the time the
        // DocumentExecution completion settles (bridgeRootProvider resolves
        // completion only after provider finalizers run).
        const closedByCompletion = harness.closeCalls.length;
        return { output, outcome, closedByCompletion };
      });

      // Agent availability probed through acpx doctor().
      expect(harness.doctorCalls).toBeGreaterThan(0);
      // A session was created.
      expect(harness.ensureCalls.length).toBeGreaterThan(0);
      // Normalized prompt output — output-stream deltas only (thought hidden).
      expect(result.output).toContain("hello world");
      // Clean completion.
      expect(result.outcome.ok).toBe(true);
      // Handle closed before completion settled.
      expect(result.closedByCompletion).toBeGreaterThan(0);
    } finally {
      yield* rm(dir, { recursive: true, force: true });
    }
  });
});
