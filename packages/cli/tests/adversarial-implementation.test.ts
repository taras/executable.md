import { describe, it } from "@executablemd/test-support/bdd";
import { runCli, shellQuote } from "@executablemd/test-support/launch";
import { fileURLToPath } from "node:url";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import { join } from "node:path";
import { z } from "zod";
import {
  Agent,
  agentIdentityComponents,
  configurationOf,
  installAgentComponents,
  registerComponents,
  useNormalizedOutput,
} from "@executablemd/core";
import type { AgentPromptEvent, Session } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { Permissions, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import { createAcpxProvider } from "../../acp/src/provider.ts";
import { AGENT_SOURCE, world } from "../../acp/tests/released-peer.ts";
import PhaseSession, {
  props as phaseSessionProps,
} from "../../../examples/adversarial-implementation/components/Phase/Session.ts";

describe("adversarial implementation example", () => {
  for (const suite of [
    "Workflow",
    "Friction",
    "Implementation",
    "LaunchPolicy",
    "Delivery",
    "ProductionRole",
  ]) {
    it(`runs the ${suite} Markdown journeys without native models`, function* () {
      const workflowCommand = [
        "deno",
        "run",
        "--quiet",
        "--allow-all",
        fileURLToPath(new URL("../src/deno.ts", import.meta.url)),
        "run",
        "--allow-absolute",
      ]
        .map(shellQuote)
        .join(" ");
      const source = yield* readTextFile(
        `examples/adversarial-implementation/tests/${suite}.test.md`,
      );
      yield* runCli(
        [
          ...(suite === "ProductionRole"
            ? [
                "test",
                `examples/adversarial-implementation/tests/${suite}.test.md`,
                "--plugin",
                "./packages/cli/tests/fixtures/workflow-test-permissions.mjs",
              ]
            : ["run", "--allow-absolute", "--eval", `<Testing>\n${source}\n</Testing>`]),
          "--include",
          suite === "ProductionRole"
            ? "examples/adversarial-implementation/components"
            : "examples/adversarial-implementation/tests/components",
          "--include",
          "examples/adversarial-implementation/components",
        ],
        {
          timeout: 120_000,
          env: { XMD_EXAMPLE_COMMAND: workflowCommand },
        },
      ).expect();
    });
  }
});

const standardPeer = AGENT_SOURCE.replace(', _meta: {agentSessionId: "native-" + sessionId}', "");
const pair = z.strictObject({ kind: z.string(), value: z.string() });
const receipt = z.strictObject({
  schema: z.literal("phase-session.v2"),
  agent: z.string(),
  name: z.string(),
  sessionKey: z.string(),
  cwd: z.string(),
  attempted: z.boolean(),
  identity: pair.nullable(),
  started: z
    .strictObject({ sessionKey: z.string(), cwd: z.string(), identity: pair.nullable() })
    .nullable(),
});
const method = z.object({
  method: z.string(),
  text: z.string().optional(),
  sessionId: z.string().optional(),
});

function* guardPeer(source = standardPeer, cwd?: string) {
  const current = yield* world(true);
  yield* writeTextFile(current.agent, source);
  const directory = cwd ?? current.dir;
  function run(options: {
    text: string;
    existing?: boolean;
    strong?: boolean;
    guard?: boolean;
    receiptDirectory?: string;
  }) {
    return scoped(function* () {
      yield* useHostFiles();
      yield* Permissions.around({ files: () => true });
      yield* useNormalizedOutput();
      yield* installAgentComponents({
        defaultAgent: "scribe",
        rootProvider: {
          options: { defaultAgent: "scribe", permissionMode: "deny-all" },
          factory: createAcpxProvider({
            sessionStore: current.store,
            agentRegistry: current.registry,
            advertiseNativeLaunch: [],
            advertiseClientNativeAttachment: [],
            ...(options.strong
              ? {
                  nativeAdapters: {
                    scribe: {
                      launcher: "scribe",
                      identity: "provider-returned",
                      acceptance: "first-turn-acceptance",
                      resume: () => [],
                    },
                  },
                }
              : {}),
            *agentCwd() {
              return directory;
            },
            sessions: {
              *requestSession() {
                return {
                  sessionKey: "workflow-review",
                  cwd: directory,
                  state: options.existing ? "existing" : "new",
                };
              },
              *recordSessionIdentity() {},
            },
          }),
        },
      });
      let resolved: Session | undefined;
      let content = 0;
      const started: AgentPromptEvent[] = [];
      yield* Agent.around({
        *session(args, next) {
          resolved = yield* next(...args);
          return resolved;
        },
        *prompt(args, next) {
          const source = yield* next(...args);
          return {
            *[Symbol.iterator]() {
              const subscription = yield* source;
              return {
                *next() {
                  const event = yield* subscription.next();
                  if (!event.done && event.value.type === "started") {
                    expect(event.value.session).toBe(resolved);
                    expect(configurationOf(event.value.session)).toEqual({
                      model: "selected",
                      effort: "xhigh",
                    });
                    started.push(event.value);
                  }
                  return event;
                },
              };
            },
          };
        },
      });
      const target = options.receiptDirectory ?? current.dir;
      const prompt = `<Witness /><Prompt throwOnError={true} text="${options.text}" />`;
      const body =
        options.guard === false
          ? prompt
          : `<Phase.Session directory="${target}" name="review" requireExisting={${Boolean(options.existing)}}>${prompt}</Phase.Session>`;
      const doc = join(current.dir, "guard.md");
      yield* writeTextFile(
        doc,
        `<Agent name="scribe"><Session name="review" model="selected" effort="xhigh">${body}</Session></Agent>`,
      );
      const journal = new InMemoryStream();
      const execution = yield* executeInstalled({ path: doc, stream: journal }, [
        {
          components: agentIdentityComponents(),
          *install() {
            yield* registerComponents([
              {
                name: "Phase.Session",
                origin: "test://workflow",
                props: phaseSessionProps,
                fn: PhaseSession,
              },
              {
                name: "Witness",
                origin: "test://workflow",
                props: { type: "object", properties: {}, additionalProperties: false },
                *fn() {
                  content++;
                  return "";
                },
              },
            ]);
          },
        },
      ]);
      const output = yield* execution.output;
      while (!(yield* output.next()).done) {}
      return { result: yield* execution, history: journal.snapshot(), started, resolved, content };
    });
  }
  function* methods() {
    return (yield* readTextFile(join(current.dir, "methods.jsonl")))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => method.parse(JSON.parse(line)));
  }
  return { ...current, run, methods };
}

describe("workflow Session continuity", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("retains the real ACP-only started pair through close/load and a failed continuation", function* () {
    const peer = yield* guardPeer();
    const first = yield* peer.run({ text: "marker" });
    expect(first.result.ok).toBe(true);
    expect(first.content).toBe(1);
    expect(first.started).toHaveLength(1);
    expect(first.resolved?.agentSessionId).toBe(undefined);
    expect(first.resolved?.identity).toEqual({ kind: "acpx.acpSessionId", value: "fixed-session" });
    const path = join(peer.dir, "review.json");
    const original = receipt.parse(JSON.parse(yield* readTextFile(path)));
    expect(original).toEqual({
      schema: "phase-session.v2",
      agent: "scribe",
      name: "review",
      sessionKey: "workflow-review",
      cwd: peer.dir,
      attempted: true,
      identity: { kind: "acpx.acpSessionId", value: "fixed-session" },
      started: {
        sessionKey: "workflow-review",
        cwd: peer.dir,
        identity: { kind: "acpx.acpSessionId", value: "fixed-session" },
      },
    });
    const continued = yield* peer.run({ existing: true, text: "recall-fail" });
    expect(continued.result.ok).toBe(false);
    expect(continued.started).toHaveLength(1);
    expect(JSON.stringify(continued.history)).toContain("answer:recall-fail:marker");
    expect(receipt.parse(JSON.parse(yield* readTextFile(path)))).toEqual(original);
    expect(first.resolved?.identity).toEqual(original.identity);
    expect(continued.resolved?.identity).toEqual(original.identity);
    const methods = yield* peer.methods();
    expect(methods.map((entry) => entry.method)).toEqual([
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
      "session/load",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(
      methods.filter((entry) => entry.method === "session/prompt").map((entry) => entry.text),
    ).toEqual(["marker", "recall-fail"]);
  });

  it("refuses changed kind at equal value and changed value in the guard before content", function* () {
    const original = yield* guardPeer();
    expect((yield* original.run({ text: "marker" })).result.ok).toBe(true);
    const path = join(original.dir, "review.json");
    const before = yield* readTextFile(path);
    let firstMismatch: string | undefined;
    for (const source of [
      AGENT_SOURCE.replace('"native-" + sessionId', "sessionId"),
      standardPeer.replace('"fixed-session"', '"different-session"'),
    ]) {
      const alternate = yield* guardPeer(source, original.dir);
      expect((yield* alternate.run({ guard: false, text: "warm" })).result.ok).toBe(true);
      const refused = yield* alternate.run({
        existing: true,
        receiptDirectory: original.dir,
        text: "must-not-send",
      });
      expect(refused.result.ok).toBe(false);
      if (!refused.result.ok) {
        expect(refused.result.error.message).toContain("Workflow session identity changed");
      }
      expect(refused.content).toBe(0);
      expect(refused.started).toEqual([]);
      expect(refused.resolved?.identity).toEqual(
        firstMismatch === undefined
          ? { kind: "acpx.agentSessionId", value: "fixed-session" }
          : { kind: "acpx.acpSessionId", value: "different-session" },
      );
      expect(yield* readTextFile(path)).toBe(before);
      const mismatch = yield* readTextFile(path + ".mismatch.json");
      if (firstMismatch === undefined) {
        firstMismatch = mismatch;
        expect(
          z.object({ observed: receipt }).parse(JSON.parse(mismatch)).observed.identity,
        ).toEqual(refused.resolved?.identity);
      } else {
        expect(mismatch).toBe(firstMismatch);
      }
      const methods = yield* alternate.methods();
      expect(methods.map((entry) => entry.method)).toEqual([
        "session/new",
        "session/set_config_option",
        "session/set_config_option",
        "session/prompt",
      ]);
      expect(
        methods.filter((entry) => entry.method === "session/prompt").map((entry) => entry.text),
      ).toEqual(["warm"]);
    }
  });

  it("holds an unconfirmed real first attempt and preserves its failure without another Prompt", function* () {
    const peer = yield* guardPeer(AGENT_SOURCE);
    const first = yield* peer.run({ strong: true, text: "no-accept" });
    expect(first.result.ok).toBe(false);
    expect(first.content).toBe(1);
    expect(first.started).toEqual([]);
    expect(first.resolved?.identity).toBe(undefined);
    const path = join(peer.dir, "review.json");
    const before = yield* readTextFile(path);
    expect(receipt.parse(JSON.parse(before))).toMatchObject({
      attempted: true,
      identity: null,
      started: null,
    });
    if (first.result.ok) {
      throw new Error("The unconfirmed attempt unexpectedly succeeded.");
    }
    const failure = JSON.stringify({
      name: first.result.error.name,
      message: first.result.error.message,
    });
    const failurePath = join(peer.dir, "first-failure.json");
    yield* writeTextFile(failurePath, failure);
    const held = yield* peer.run({ strong: true, existing: true, text: "must-not-send" });
    expect(held.result.ok).toBe(false);
    if (!held.result.ok) {
      expect(held.result.error.message).toContain("attempted without a confirmed identity");
    }
    expect(held.content).toBe(0);
    expect(held.started).toEqual([]);
    expect(yield* readTextFile(path)).toBe(before);
    expect(yield* readTextFile(failurePath)).toBe(failure);
    const methods = yield* peer.methods();
    expect(methods.map((entry) => entry.method)).toEqual([
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
    ]);
    expect(
      methods.filter((entry) => entry.method === "session/prompt").map((entry) => entry.text),
    ).toEqual(["no-accept"]);
  });
});
