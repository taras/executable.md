/**
 * Tier PB — the boundary between Core and the Agent package.
 *
 * Core is the engine and the Agent package is one vocabulary over it, so the
 * dependency runs one way. These rows hold that from what actually resolves
 * rather than from what the source says: the names Core's namespaces export,
 * its manifests, and what a Core-only execution can reach. The positive half is
 * the same document run with the Agent package installed through its public
 * entries, answered by an ordinary provider. The module-graph row, PB1, is in
 * package-graph.test.ts, because it asks Deno's own resolver.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, until } from "effection";
import type { Operation, Result, Stream } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryStream } from "@executablemd/durable-streams";
import { execute } from "@executablemd/core";
import type { DocumentExecution, Json } from "@executablemd/core";
import { Agent } from "@executablemd/agent/api";
import type { AgentPromptEvent, AgentProviderFactory } from "@executablemd/agent/api";
import { agentIdentityComponents, installAgentComponents } from "@executablemd/agent/host";
import { executeInstalled } from "@executablemd/core/host";

const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));

function* manifest(relative: string): Operation<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(yield* readTextFile(path.join(REPOSITORY, relative)));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${relative} is not a JSON object`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

function namesIn(section: unknown): string[] {
  return typeof section === "object" && section !== null ? Object.keys(section) : [];
}

/** A provider answering each prompt with its own text, bracketed. */
const echo: AgentProviderFactory = function* (options) {
  yield* Agent.around(
    {
      // deno-lint-ignore require-yield
      *agent([name]) {
        return name ?? options.defaultAgent;
      },
      // deno-lint-ignore require-yield
      *session([name]) {
        return { sessionKey: `pb:${name ?? "default"}`, cwd: "/" };
      },
      // deno-lint-ignore require-yield
      *prompt([content, promptOptions]): Operation<Stream<AgentPromptEvent, string>> {
        const text = `[${content}]`;
        const events: AgentPromptEvent[] = [
          {
            type: "started",
            agent: promptOptions?.agent ?? options.defaultAgent,
            session: { sessionKey: "pb:default", cwd: "/" },
          },
          { type: "text_delta", text },
          { type: "terminal", status: "completed" },
        ];
        return {
          *[Symbol.iterator]() {
            let index = 0;
            return {
              // deno-lint-ignore require-yield
              *next() {
                return index < events.length
                  ? { done: false as const, value: events[index++]! }
                  : { done: true as const, value: text };
              },
            };
          },
        };
      },
    },
    { at: "min" },
  );
};

function* run(
  doc: string,
  start: (docPath: string) => Operation<DocumentExecution>,
): Operation<{ output: string; result: Result<Json> }> {
  const dir = path.join(os.tmpdir(), `xmd-pb-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    const docPath = path.join(dir, "doc.md");
    yield* writeTextFile(docPath, doc);
    const execution = yield* start(docPath);
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    return { output: next.value, result: yield* execution };
  });
}

const DOCUMENT = '<Session name="review">\n<Prompt text="hello" />\n</Session>\n';

describe("Tier PB — Core resolves no Agent package", () => {
  it("PB2: Core's manifests declare no Agent dependency", function* () {
    const deno = yield* manifest("packages/core/deno.json");
    const npm = yield* manifest("packages/core/package.json");
    for (const name of [
      ...namesIn(deno.imports),
      ...namesIn(npm.dependencies),
      ...namesIn(npm.peerDependencies),
    ]) {
      expect(name.startsWith("@executablemd/agent")).toBe(false);
    }
    const agent = yield* manifest("packages/agent/package.json");
    expect(namesIn(agent.dependencies)).toContain("@executablemd/core");
  });

  it("PB3: Core's public namespaces export none of the Agent package's names", function* () {
    const agentNames = new Set([
      ...Object.keys(yield* until(import("../api.ts"))),
      ...Object.keys(yield* until(import("../host.ts"))),
    ]);
    expect(agentNames.size).toBeGreaterThan(0);
    for (const entry of ["mod.ts", "api.ts", "host.ts"]) {
      const core: object = yield* until(import(`../../core/${entry}`));
      expect([entry, Object.keys(core).filter((name) => agentNames.has(name))]).toEqual([
        entry,
        [],
      ]);
    }
  });

  it("PB4: a Core-only execution cannot resolve the Agent vocabulary", function* () {
    for (const [doc, name] of [
      [DOCUMENT, "Session"],
      ['<Prompt text="hello" />\n', "Prompt"],
    ] as const) {
      const { output, result } = yield* run(doc, (docPath) =>
        execute({ path: docPath, stream: new InMemoryStream() }),
      );
      expect(output).not.toContain("[hello]");
      expect(!result.ok && result.error.message).toContain(`Cannot resolve component: ${name}`);
    }
  });

  it("PB5: the Agent package installed over Core answers the same document", function* () {
    const { output, result } = yield* run(DOCUMENT, function* (docPath) {
      yield* installAgentComponents({
        rootProvider: {
          factory: echo,
          options: { defaultAgent: "pb", permissionMode: "deny-all" },
        },
      });
      return yield* executeInstalled({ path: docPath, stream: new InMemoryStream() }, [
        { components: agentIdentityComponents() },
      ]);
    });
    if (!result.ok) {
      throw result.error;
    }
    expect(output).toContain("[hello]");
  });
});
