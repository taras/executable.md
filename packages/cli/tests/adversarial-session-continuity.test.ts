import { describe, it } from "@executablemd/test-support/bdd";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { expect } from "@executablemd/test-support/expect";
import { useComponentModuleLoader } from "@executablemd/test-support/host";
import { scoped, spawn, withResolvers } from "effection";
import type { Stream } from "effection";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  Agent,
  agentIdentityComponents,
  collect,
  configurationOf,
  Elicitation,
  installAgentComponents,
  registerComponents,
  useNormalizedOutput,
} from "@executablemd/core";
import type { AgentPromptEvent, Json, Session } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { Permissions, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { AcpRuntimeOptions, ProbeCapableRuntime } from "@executablemd/acp";
import { createEmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import { createAcpxProvider } from "../../acp/src/provider.ts";
import { installAgentProviderStack } from "../src/agent-stack.ts";
import { gitPlugin } from "@executablemd/git";
import { installPlugins } from "../src/plugin-host.ts";
import { replRepositoryPlugin } from "../src/repl/repositories/plugin.ts";
import { openReplSession, submitReplEntry } from "../src/repl/session.ts";
import type { ReplSession, ReplSessionOptions } from "../src/repl/session.ts";
import type { ReplQuestion } from "../src/repl/elicitation.ts";
import { createFakeAcp, makeStore } from "./support/fake-acp.ts";
import type { FakeAcp } from "./support/fake-acp.ts";
import { AGENT_SOURCE, world } from "../../acp/tests/released-peer.ts";
import PhaseSession, {
  props as phaseSessionProps,
} from "../../../examples/adversarial-implementation/components/Phase/Session.ts";

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

const components = resolve("examples/adversarial-implementation/components");
const revision = "a".repeat(40);
const acceptance = [
  { id: "behavior", source: "accepted.md", requirement: "Keep the accepted behavior." },
];
const review = JSON.stringify({
  revision,
  verdict: "pass",
  summary: "Reviewed the assigned behavior.",
  acceptance: ["behavior"],
  findings: [],
});
const outcome = z.object({
  catalog: z.object({
    state: z.string(),
    model: z.string().nullable(),
    advertised: z.array(z.string()).nullable(),
  }),
  turn: z
    .object({
      state: z.string(),
      stage: z.string().optional(),
      reply: z.string().optional(),
      partial: z.string().optional(),
      configuration: z.object({ reason: z.string(), setting: z.string() }).nullable().optional(),
    })
    .nullable(),
});
const execution = z.strictObject({
  status: z.enum(["completed", "failed"]),
  failure: z.string().nullable(),
});
const captured = z.strictObject({
  status: z.enum(["completed", "failed"]),
  output: z.string(),
  failure: z.string().nullable(),
});

interface ReviewWorld {
  root: string;
  delivery: Record<string, Json>;
  asked: unknown[];
  run(source: string, props: Record<string, Json>): Operation<{ ok: boolean; text: string }>;
}

function* reviewWorld(fake: FakeAcp, create = fake.create): Operation<ReviewWorld> {
  const root = join(tmpdir(), `xmd-delivery-review-${randomUUID()}`);
  yield* ensureDir(join(root, "repository"));
  yield* ensureDir(join(root, "delivery"));
  const asked: unknown[] = [];
  const delivery = {
    work: "production-review",
    repository: join(root, "repository"),
    directory: join(root, "delivery"),
    policy: {
      repository: "taras/executable.md",
      reviewer: { provider: "claude", model: "fable", effort: null, session: "independent" },
      acceptance,
    },
    inputs: [{ path: "accepted.md", content: "The original accepted behavior." }],
    required: ["independent-review", "required-ci", "main-health"],
  };
  function run(source: string, props: Record<string, Json>) {
    return scoped(function* () {
      yield* useHostFiles();
      yield* useComponentModuleLoader();
      yield* Permissions.around({ files: () => true });
      yield* useNormalizedOutput();
      yield* installAgentProviderStack(
        {
          provider: "acpx",
          defaultAgent: "claude",
          permissionMode: "deny-all",
          adapters: createEmbeddedAdapters(join(root, "adapters")),
        },
        {
          createRuntime: create,
          sessionStore: makeStore(),
          advertiseNativeLaunch: [],
          advertiseClientNativeAttachment: [],
        },
      );
      yield* Elicitation.around(
        {
          *elicit([request]) {
            asked.push(request);
            return { disposition: "hold" };
          },
        },
        { at: "min" },
      );
      const doc = join(root, `document-${randomUUID()}.md`);
      yield* writeTextFile(doc, `---\nprops: {type: object}\n---\n${source}`);
      const executed = yield* executeInstalled(
        { path: doc, stream: new InMemoryStream(), includes: [components], props },
        [{ components: agentIdentityComponents(), *install() {} }],
      );
      try {
        return {
          ok: true,
          text: z
            .string()
            .parse(yield* collect(executed))
            .trim(),
        };
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) };
      }
    });
  }
  return { root, delivery, asked, run };
}

const roleSource =
  "<Delivery.Role delivery={props.delivery} revision={props.revision} reviewer={props.reviewer} choices={props.choices} position={0} attempt={props.attempt} />";
const reviewSource =
  '<Delivery.Review delivery={props.delivery} revision={props.revision} as="result" /><Json value={result} />';

function catalog(models: string[], efforts: string[] = ["low", "high"]) {
  return {
    model: { selected: models[0]!, choices: models.map((id) => ({ id })) },
    effort: Object.fromEntries(
      models.map((model) => [
        model,
        { selected: efforts[0]!, choices: efforts.map((id) => ({ id })) },
      ]),
    ),
  };
}

function agentOf(fake: FakeAcp, index: number): string | undefined {
  const key = fake.turns[index]?.handle.sessionKey;
  return fake.ensured.find((input) => input.sessionKey === key)?.agent;
}

function closeGate(fake: FakeAcp) {
  const events: string[] = [];
  const reached = withResolvers<void>();
  let resume: (() => void) | undefined;
  let gated = false;
  function create(options: AcpRuntimeOptions): ProbeCapableRuntime {
    const runtime = fake.create(options);
    return {
      ...runtime,
      close(input: Parameters<ProbeCapableRuntime["close"]>[0]) {
        if (gated || fake.turns.length === 0) {
          return runtime.close(input);
        }
        gated = true;
        events.push("close-held");
        reached.resolve();
        return new Promise<void>((resolved) => {
          resume = resolved;
        }).then(() => {
          events.push("close-released");
          return runtime.close(input);
        });
      },
    };
  }
  return {
    events,
    reached,
    create,
    release() {
      resume?.();
    },
  };
}

const notice =
  "You've reached your Fable limit. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
const runtimeRefusal = {
  code: "RUNTIME",
  origin: "runtime" as const,
  acp: { code: -32603, message: `Internal error: ${notice}` },
};

describe(
  "production independent review over the registered acpx factory",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("configures the advertised exact Fable model and effort, and omits a null effort", function* () {
      for (const effort of ["high", null]) {
        const fake = createFakeAcp();
        fake.configuration(catalog(["claude-opus", "fable"]));
        fake.script({ reply: review });
        const harness = yield* reviewWorld(fake);
        const attempt = join(harness.root, "delivery", "attempt");
        const reviewer = {
          provider: "claude",
          model: "claude-fable-5-1[1m]",
          effort,
          session: "independent",
        };
        const ran = yield* harness.run(roleSource, {
          delivery: harness.delivery,
          revision,
          reviewer,
          choices: ["fable", "claude-fable-5-1[1m]"],
          attempt,
        });
        expect(ran.ok).toBe(true);
        const settled = outcome.parse(
          JSON.parse(yield* readTextFile(join(attempt, "outcome.json"))),
        );
        expect(settled.catalog).toEqual({
          state: "selected",
          model: "fable",
          advertised: ["claude-opus", "fable"],
        });
        expect(settled.turn).toEqual({ state: "reply", reply: review });
        expect(fake.prompts).toHaveLength(1);
        expect(fake.prompts[0]).toContain(`independent correctness review of ${revision}`);
        expect(fake.prompts[0]).toContain(
          JSON.stringify(acceptance, null, 2).split("\n")[2]!.trim(),
        );
        expect(fake.prompts[0]).toContain("The original accepted behavior.");
        const writes = fake.configCalls.filter((call) => call.startsWith("set "));
        expect(writes).toEqual(
          effort === null ? ["set model=fable"] : ["set model=fable", "set effort=high"],
        );
        expect(fake.running(fake.turns[0]!.handle.sessionKey)).toEqual({
          model: "fable",
          effort: effort ?? undefined,
        });
        expect(fake.closes.length).toBeGreaterThan(0);
      }
    });

    it("sends no review prompt when the catalog lacks Fable or configuration is refused", function* () {
      for (const variant of ["missing", "refused"]) {
        const fake = createFakeAcp();
        fake.configuration(
          variant === "missing"
            ? catalog(["claude-opus"])
            : { model: { selected: "fable", choices: [{ id: "fable" }] } },
        );
        const harness = yield* reviewWorld(fake);
        const attempt = join(harness.root, "delivery", "attempt");
        const ran = yield* harness.run(roleSource, {
          delivery: harness.delivery,
          revision,
          reviewer: {
            provider: "claude",
            model: "fable",
            effort: variant === "refused" ? "high" : null,
            session: "independent",
          },
          choices: ["fable"],
          attempt,
        });
        expect(ran.ok).toBe(true);
        const settled = outcome.parse(
          JSON.parse(yield* readTextFile(join(attempt, "outcome.json"))),
        );
        expect(fake.prompts).toEqual([]);
        if (variant === "missing") {
          expect(settled.catalog).toEqual({
            state: "unavailable",
            model: null,
            advertised: ["claude-opus"],
          });
          expect(settled.turn).toBe(null);
        } else {
          expect(settled.turn).toMatchObject({
            state: "failed",
            partial: "",
            configuration: { reason: "selector-unavailable", setting: "effort" },
          });
        }
        expect(settled.catalog.model).toBe(variant === "missing" ? null : "fable");
      }
    });

    it("starts the Astra replacement only after the failed Fable owner has released its provider", function* () {
      const fake = createFakeAcp();
      fake.configuration(catalog(["fable", "gpt-6-astra"]));
      fake.script({ failure: "The Fable provider turn failed." });
      fake.script({ failure: "The Astra provider turn failed." });
      const gate = closeGate(fake);
      const harness = yield* reviewWorld(fake, gate.create);
      const task = yield* spawn(() =>
        harness.run(reviewSource, { delivery: harness.delivery, revision }),
      );
      yield* gate.reached.operation;
      expect(fake.turns).toHaveLength(1);
      expect(agentOf(fake, 0)).toBe("claude");
      gate.release();
      const ran = yield* task;
      expect(ran.ok).toBe(true);
      expect(gate.events).toEqual(["close-held", "close-released"]);
      expect(fake.turns.map((_, index) => agentOf(fake, index))).toEqual(["claude", "codex"]);
      const attempt = join(harness.delivery.directory as string, `review-${revision}`);
      const primary = execution.parse(
        JSON.parse(yield* readTextFile(join(attempt, "execution.json"))),
      );
      expect(primary.status).toBe("completed");
      expect(
        outcome.parse(JSON.parse(yield* readTextFile(join(attempt, "outcome.json")))).turn,
      ).toMatchObject({ state: "failed", stage: "turn", partial: "" });
      const sessions = z.object({ name: z.string(), attempted: z.boolean() });
      for (const name of ["independent", "independent-astra"]) {
        expect(
          sessions.parse(
            JSON.parse(
              yield* readTextFile(
                join(harness.delivery.directory as string, "sessions", `${name}.json`),
              ),
            ),
          ),
        ).toMatchObject({ name, attempted: true });
      }
      expect(harness.asked).toHaveLength(1);
    });

    it("replaces Fable after its exact usage-limit refusal only, and holds substantive output or a lookalike message", function* () {
      for (const variant of ["refusal", "substantive", "lookalike"]) {
        const fake = createFakeAcp();
        fake.configuration(catalog(["fable", "gpt-6-astra"]));
        fake.script({
          deltas:
            variant === "substantive"
              ? [notice, `\n\n${review}`]
              : [notice.slice(0, 40), notice.slice(40)],
          failure: `Internal error: ${notice}`,
          ...(variant === "lookalike" ? {} : { failureFacts: runtimeRefusal }),
        });
        fake.script({ failure: "The Astra provider turn failed." });
        const gate = closeGate(fake);
        const harness = yield* reviewWorld(fake, gate.create);
        const task = yield* spawn(() =>
          harness.run(reviewSource, { delivery: harness.delivery, revision }),
        );
        yield* gate.reached.operation;
        expect(fake.turns.map((_, index) => agentOf(fake, index))).toEqual(["claude"]);
        gate.release();
        const ran = yield* task;
        expect(ran.ok).toBe(true);
        expect(gate.events).toEqual(["close-held", "close-released"]);
        const attempt = join(harness.delivery.directory as string, `review-${revision}`);
        const primary = outcome.parse(
          JSON.parse(yield* readTextFile(join(attempt, "outcome.json"))),
        );
        expect(primary.turn).toMatchObject({
          state: "failed",
          stage: "turn",
          partial: variant === "substantive" ? `${notice}\n\n${review}` : notice,
        });
        const hold = z
          .object({ attempts: z.array(z.object({ state: z.string(), reason: z.string() })) })
          .parse(JSON.parse(yield* readTextFile(join(attempt, "hold.json"))));
        if (variant === "refusal") {
          expect(fake.turns.map((_, index) => agentOf(fake, index))).toEqual(["claude", "codex"]);
          expect(fake.prompts[1]).toBe(fake.prompts[0]);
          expect(hold.attempts.map((item) => item.state)).toEqual(["eligible", "eligible"]);
          expect(hold.attempts[0]?.reason).toContain("usage limit");
          const assignments: Record<string, unknown>[] = [];
          for (const file of ["assignment.json", "replacement/assignment.json"]) {
            assignments.push(
              z
                .record(z.string(), z.unknown())
                .parse(JSON.parse(yield* readTextFile(join(attempt, file)))),
            );
          }
          expect(assignments[1]).toEqual({
            ...assignments[0],
            reviewer: {
              provider: "codex",
              model: "gpt-6-astra",
              effort: null,
              session: "independent-astra",
            },
          });
          expect(assignments[0]?.revision).toBe(revision);
          expect(assignments[0]?.acceptance).toEqual(acceptance);
        } else {
          expect(fake.turns.map((_, index) => agentOf(fake, index))).toEqual(["claude"]);
          expect(hold.attempts.map((item) => item.state)).toEqual(["held"]);
          expect(hold.attempts[0]?.reason).toContain("partial review output");
        }
        expect(harness.asked).toHaveLength(1);
      }
    });

    it("holds a provider-cancelled Fable turn without output and starts no Astra", function* () {
      const fake = createFakeAcp();
      fake.configuration(catalog(["fable", "gpt-6-astra"]));
      fake.script({ reply: "", cancelled: true });
      const harness = yield* reviewWorld(fake);
      const ran = yield* harness.run(reviewSource, { delivery: harness.delivery, revision });
      expect(ran.ok).toBe(true);
      expect(fake.turns.map((_, index) => agentOf(fake, index))).toEqual(["claude"]);
      const attempt = join(harness.delivery.directory as string, `review-${revision}`);
      expect(JSON.parse(yield* readTextFile(join(attempt, "outcome.json"))).turn).toMatchObject({
        state: "failed",
        stage: "turn",
        partial: "",
        terminal: "cancelled",
      });
      expect(
        execution.parse(JSON.parse(yield* readTextFile(join(attempt, "execution.json")))).status,
      ).toBe("completed");
      const hold = z
        .object({ attempts: z.array(z.object({ state: z.string(), reason: z.string() })) })
        .parse(JSON.parse(yield* readTextFile(join(attempt, "hold.json"))));
      expect(hold.attempts.map((item) => item.state)).toEqual(["held"]);
      expect(hold.attempts[0]?.reason).toContain("cancelled");
      expect(harness.asked).toHaveLength(1);
    });

    it("lets a reviewer first prompt after a catalog-only revision, and refuses when its established receipt is gone", function* () {
      const fake = createFakeAcp();
      const harness = yield* reviewWorld(fake);
      const reviewer = { provider: "claude", model: "fable", effort: null, session: "independent" };
      const sessionReceipt = join(
        harness.delivery.directory as string,
        "sessions",
        "independent.json",
      );
      function* reviewAt(sha: string) {
        const attempt = join(harness.delivery.directory as string, `review-${sha}`);
        yield* ensureDir(attempt);
        yield* writeTextFile(
          join(attempt, "assignment.json"),
          JSON.stringify({ work: "production-review", revision: sha, reviewer }),
        );
        const ran = yield* harness.run(roleSource, {
          delivery: harness.delivery,
          revision: sha,
          reviewer,
          choices: ["fable"],
          attempt,
        });
        return { ran, attempt };
      }
      fake.configuration(catalog(["claude-opus"]));
      const skipped = yield* reviewAt("b".repeat(40));
      expect(skipped.ran.ok).toBe(true);
      expect(
        outcome.parse(JSON.parse(yield* readTextFile(join(skipped.attempt, "outcome.json"))))
          .catalog.state,
      ).toBe("unavailable");
      expect(fake.prompts).toEqual([]);
      fake.configuration(catalog(["fable"]));
      fake.script({ reply: review });
      const first = yield* reviewAt("c".repeat(40));
      expect(first.ran.ok).toBe(true);
      expect(fake.prompts).toHaveLength(1);
      expect(
        outcome.parse(JSON.parse(yield* readTextFile(join(first.attempt, "outcome.json")))).turn,
      ).toEqual({ state: "reply", reply: review });
      const established = z
        .object({
          name: z.string(),
          attempted: z.boolean(),
          identity: z.object({ value: z.string() }),
        })
        .parse(JSON.parse(yield* readTextFile(sessionReceipt)));
      expect(established).toMatchObject({ name: "independent", attempted: true });
      yield* rm(sessionReceipt);
      const refused = yield* reviewAt("d".repeat(40));
      expect(refused.ran.ok).toBe(false);
      expect(refused.ran.text).toContain("identity receipt is unavailable");
      expect(fake.prompts).toHaveLength(1);
    });

    it("ends the run without Astra or a hold when the failed Fable owner's real ACP close rejects", function* () {
      const fake = createFakeAcp();
      fake.configuration(catalog(["fable", "gpt-6-astra"]));
      fake.script({
        reply: notice,
        failure: `Internal error: ${notice}`,
        failureFacts: runtimeRefusal,
      });
      fake.closeFailure = new Error("the review provider would not close");
      const harness = yield* reviewWorld(fake);
      const ran = yield* harness.run(reviewSource, { delivery: harness.delivery, revision });
      expect(ran.ok).toBe(false);
      expect(ran.text).toContain("agent provider teardown failed");
      expect(fake.closes).toContain("scope teardown");
      expect(fake.turns.map((_, index) => agentOf(fake, index))).toEqual(["claude"]);
      const attempt = join(harness.delivery.directory as string, `review-${revision}`);
      expect(JSON.parse(yield* readTextFile(join(attempt, "outcome.json"))).turn).toMatchObject({
        state: "failed",
        stage: "turn",
        partial: notice,
        refusal: { output: notice, closeValue: notice },
      });
      const retained: string[] = [];
      for (const file of ["execution.json", "hold.json", "replacement/assignment.json"]) {
        try {
          yield* readTextFile(join(attempt, file));
          retained.push(file);
        } catch {
          continue;
        }
      }
      expect(retained).toEqual([]);
      expect(harness.asked).toHaveLength(0);
    });
  },
);

function* question(session: ReplSession): Operation<ReplQuestion> {
  const changes = yield* session.elicitation.changes;
  while (session.elicitation.pending === undefined) {
    yield* changes.next();
  }
  return session.elicitation.pending;
}

describe(
  "delivery review partial continuation",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("restores a retained failed turn, including its refusal facts, as the same outcome without another provider call", function* () {
      for (const variant of ["no-output", "cancelled", "refusal"]) {
        const root = join(tmpdir(), `xmd-delivery-turn-${randomUUID()}`);
        yield* ensureDir(root);
        const path = join(root, "turn.md");
        yield* writeTextFile(
          path,
          '<Ticket.Capture as="captured"><Delivery.Turn as="turn"><Prompt session="review" throwOnError={true}>review</Prompt></Delivery.Turn><Json value={turn} /></Ticket.Capture><Json value={captured} />',
        );
        let calls = 0;
        function perform(stream: InMemoryStream) {
          return scoped(function* () {
            yield* useHostFiles();
            yield* useComponentModuleLoader();
            yield* Permissions.around({ files: () => true });
            yield* useNormalizedOutput();
            yield* installAgentComponents({ defaultAgent: "fixture" });
            yield* Agent.around(
              {
                *agent([name]) {
                  return name ?? "fixture";
                },
                *session() {
                  return { sessionKey: "review", cwd: root };
                },
                *prompt() {
                  calls++;
                  const refused = new Error(`Internal error: ${notice}`);
                  Object.defineProperty(refused, "executablemd.agent.prompt-diagnostic", {
                    value: {
                      provider: "acp",
                      operation: "session/prompt",
                      stage: "runtime-turn",
                      requestId: "request-1",
                      ...runtimeRefusal,
                    },
                  });
                  const events: AgentPromptEvent[] =
                    variant === "refusal"
                      ? [
                          {
                            type: "started",
                            agent: "fixture",
                            session: { sessionKey: "review", cwd: root },
                          },
                          { type: "text_delta", text: notice },
                          { type: "terminal", status: "failed", error: refused },
                        ]
                      : [
                          {
                            type: "started",
                            agent: "fixture",
                            session: { sessionKey: "review", cwd: root },
                          },
                          variant === "cancelled"
                            ? { type: "terminal", status: "cancelled" }
                            : {
                                type: "terminal",
                                status: "failed",
                                error: new Error("recorded provider refusal"),
                              },
                        ];
                  const turn: Stream<AgentPromptEvent, string> = {
                    *[Symbol.iterator]() {
                      let count = 0;
                      return {
                        *next() {
                          const event = events[count++];
                          return event === undefined
                            ? { done: true as const, value: variant === "refusal" ? notice : "" }
                            : { done: false as const, value: event };
                        },
                      };
                    },
                  };
                  return turn;
                },
              },
              { at: "min" },
            );
            const executed = yield* executeInstalled({ path, includes: [components], stream }, []);
            return z.string().parse(yield* collect(executed));
          });
        }
        calls = 0;
        const live = new InMemoryStream();
        const first = captured.parse(JSON.parse(yield* perform(live)));
        const prefix = live
          .snapshot()
          .filter((event) => !(event.type === "close" && event.coroutineId === "root"));
        const continued = captured.parse(JSON.parse(yield* perform(new InMemoryStream(prefix))));
        expect(calls).toBe(1);
        expect(first.status).toBe("completed");
        expect(JSON.parse(first.output)).toMatchObject(
          variant === "refusal"
            ? {
                state: "failed",
                stage: "turn",
                partial: notice,
                configuration: null,
                refusal: {
                  agent: "fixture",
                  sessionKey: "review",
                  message: `Internal error: ${notice}`,
                  diagnostic: {
                    provider: "acp",
                    operation: "session/prompt",
                    stage: "runtime-turn",
                    requestId: "request-1",
                    ...runtimeRefusal,
                  },
                  output: notice,
                  closeValue: notice,
                },
                terminal: "failed",
              }
            : {
                state: "failed",
                partial: "",
                configuration: null,
                refusal: null,
                terminal: variant === "cancelled" ? "cancelled" : "failed",
              },
        );
        expect(continued).toEqual(first);
      }
    });

    it("continues an unfinished REPL review to its held question, and a new action after Entry Stop reads the same hold", function* () {
      const fake = createFakeAcp();
      fake.configuration(catalog(["fable", "gpt-6-astra"]));
      fake.script({ failure: "The Fable provider turn failed." });
      fake.script({ failure: "The Astra provider turn failed." });
      const harness = yield* reviewWorld(fake);
      const attempt = join(harness.delivery.directory as string, `review-${revision}`);
      const source = `<Let as="delivery" value={${JSON.stringify(harness.delivery)}} /><Delivery.Review delivery={delivery} revision="${revision}" as="result" /><Json value={result} />`;
      const stream = new InMemoryStream();
      const store = makeStore();
      function* sessionOptions(): Operation<ReplSessionOptions> {
        const plugins = yield* installPlugins([replRepositoryPlugin(gitPlugin)], {
          command: "repl",
          args: [],
        });
        return {
          execution: { id: "delivery-review-held", stream },
          includes: [components],
          installations: [
            ...plugins.installations,
            { components: agentIdentityComponents(), *install() {} },
          ],
        };
      }
      function* evidence() {
        const files: Record<string, string> = {};
        for (const file of [
          "selection.json",
          "assignment.json",
          "outcome.json",
          "execution.json",
          "hold.json",
          "replacement/transition.json",
          "replacement/assignment.json",
          "replacement/outcome.json",
          "replacement/execution.json",
        ]) {
          files[file] = yield* readTextFile(join(attempt, file));
        }
        return files;
      }
      function* hosted<T>(body: () => Operation<T>): Operation<T> {
        return yield* scoped(function* () {
          yield* useHostFiles();
          yield* useComponentModuleLoader();
          yield* Permissions.around({ files: () => true });
          yield* installAgentProviderStack(
            {
              provider: "acpx",
              defaultAgent: "claude",
              permissionMode: "deny-all",
              adapters: createEmbeddedAdapters(join(harness.root, "adapters")),
            },
            {
              createRuntime: fake.create,
              sessionStore: store,
              advertiseNativeLaunch: [],
              advertiseClientNativeAttachment: [],
            },
          );
          return yield* body();
        });
      }

      const asked = yield* hosted(function* () {
        const opened = yield* submitReplEntry({ ...(yield* sessionOptions()), source });
        if (!opened.ok) {
          throw opened.error;
        }
        return (yield* question(opened.value)).message;
      });
      expect(fake.turns.map((_, index) => agentOf(fake, index))).toEqual(["claude", "codex"]);
      const held = yield* evidence();
      expect(JSON.parse(held["outcome.json"]!)).toMatchObject({
        turn: { state: "failed", stage: "turn", partial: "" },
      });
      expect(asked).toContain("Every eligible independent reviewer failed without a valid review.");

      yield* hosted(function* () {
        const reopened = yield* openReplSession(yield* sessionOptions());
        if (!reopened.ok) {
          throw reopened.error;
        }
        const continued = yield* question(reopened.value);
        expect(continued.message).toBe(asked);
        expect(fake.turns).toHaveLength(2);
        expect((yield* reopened.value.stopEntry("entry-1")).ok).toBe(true);
        expect(reopened.value.model.entries[0]?.terminal?.status).toBe("cancelled");
        const submitted = yield* reopened.value.submit(source);
        if (!submitted.ok) {
          throw submitted.error;
        }
        const again = yield* question(reopened.value);
        expect(again.message).toBe(asked);
        expect(again.submit({ disposition: "hold" }).kind).toBe("answered");
        expect((yield* submitted.value.join()).ok).toBe(true);
      });
      expect(fake.turns).toHaveLength(2);
      expect(yield* evidence()).toEqual(held);
      const disposition = z
        .object({ answer: z.object({ disposition: z.string() }) })
        .parse(JSON.parse(yield* readTextFile(join(attempt, "disposition.json"))));
      expect(disposition.answer).toEqual({ disposition: "hold" });
    });
  },
);
