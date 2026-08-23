/**
 * Tier XA — acceptance: `createAcpxProvider()` installed through core's #135
 * `rootProvider` seam drives the full Agent → session → prompt → teardown
 * lifecycle. Fake ACPX runtime, no subprocess.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { agentIdentityComponents, Agent, installAgentComponents } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { AgentSessionRequest } from "@executablemd/core";
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
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

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

      // `<Session>` names durable work after its own invocation, so the host
      // declares it to the execution rather than registering it.
      const execution = yield* executeInstalled({ path: docPath, stream: new InMemoryStream() }, [
        { components: agentIdentityComponents() },
      ]);
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
  });
});

/**
 * Tier WAP — the engine's Session identity, through a real document.
 *
 * Two sibling `<Session name="review">` elements are two sessions. The authored
 * name is descriptive and compositional — a handler may rewrite it, and one
 * here does — while the identity travels inside the placement, reachable only
 * through the authority delivered to this provider.
 */
describe("Tier WAP — same-named sibling Sessions", () => {
  it('WAP7: two sibling <Session name="review"> sites place two identities the middleware cannot touch', function* () {
    const harness = createFakeRuntime();
    const placements: Array<{ session: string | undefined; sessionIdentity?: string }> = [];

    const dir = path.join(os.tmpdir(), `xmd-acp-session-${randomUUID()}`);
    yield* ensureDir(dir);
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    const docPath = path.join(dir, "sessions.md");
    yield* writeTextFile(
      docPath,
      [
        '<Agent name="codex">',
        '<Session name="review">',
        "<Prompt>first</Prompt>",
        "</Session>",
        "",
        '<Session name="review">',
        "<Prompt>second</Prompt>",
        "</Session>",
        "</Agent>",
        "",
      ].join("\n"),
    );

    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      yield* installAgentComponents({
        rootProvider: {
          factory: createAcpxProvider({
            createRuntime: harness.create,
            sessionStore: makeStore(),
            agentRegistry: makeRegistry({ codex: "codex-cmd" }),
            sessions: {
              // deno-lint-ignore require-yield
              *place(context) {
                placements.push({
                  session: context.session,
                  ...(context.sessionIdentity === undefined
                    ? {}
                    : { sessionIdentity: context.sessionIdentity }),
                });
                return {
                  sessionKey: `placed:${context.sessionIdentity ?? "none"}`,
                  cwd: "/placed",
                };
              },
            },
          }),
          options: { defaultAgent: "codex", permissionMode: "deny-all" },
        },
      });
      // Middleware that rewrites the descriptive name on its way through, which
      // is exactly what the public chain is for.
      yield* Agent.around({
        *session([routed], next) {
          const renamed =
            typeof routed === "string" || routed === undefined
              ? "rewritten"
              : routed.with({ name: "rewritten" });
          return yield* next(renamed);
        },
      });

      // `<Session>` names durable work after its own invocation, so the host
      // declares it to the execution rather than registering it.
      const execution = yield* executeInstalled({ path: docPath, stream: new InMemoryStream() }, [
        { components: agentIdentityComponents() },
      ]);
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      yield* execution;
    });

    expect(placements).toHaveLength(2);
    // The middleware's rewrite reached the provider, because the name is the
    // compositional half.
    expect(placements.map((placement) => placement.session)).toEqual(["rewritten", "rewritten"]);
    // The identities did not, and are two: same authored name, two elements,
    // two sessions.
    const identities = placements.map((placement) => placement.sessionIdentity);
    expect(identities.every((identity) => typeof identity === "string")).toBe(true);
    expect(new Set(identities).size).toBe(2);
    expect(identities).not.toContain("rewritten");
    // And each placement is its own session, not one shared by the name.
    expect(new Set(harness.ensureCalls.map((call) => call.sessionKey)).size).toBe(2);
  });

  it("WAP7: a placement kept from the first Session cannot be routed for the second", function* () {
    const harness = createFakeRuntime();
    const placements: Array<string | undefined> = [];
    let refusal: string | undefined;

    const dir = path.join(os.tmpdir(), `xmd-acp-substitute-${randomUUID()}`);
    yield* ensureDir(dir);
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    const docPath = path.join(dir, "sessions.md");
    yield* writeTextFile(
      docPath,
      [
        '<Agent name="codex">',
        '<Session name="review">',
        "<Prompt>first</Prompt>",
        "</Session>",
        "",
        '<Session name="review">',
        "<Prompt>second</Prompt>",
        "</Session>",
        "</Agent>",
        "",
      ].join("\n"),
    );

    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      yield* installAgentComponents({
        rootProvider: {
          factory: createAcpxProvider({
            createRuntime: harness.create,
            sessionStore: makeStore(),
            agentRegistry: makeRegistry({ codex: "codex-cmd" }),
            sessions: {
              // deno-lint-ignore require-yield
              *place(context) {
                placements.push(context.sessionIdentity);
                return {
                  sessionKey: `placed:${context.sessionIdentity ?? "none"}`,
                  cwd: "/placed",
                };
              },
            },
          }),
          options: { defaultAgent: "codex", permissionMode: "deny-all" },
        },
      });

      // The attack: keep the first element's real placement and route it for
      // the second. Reading it again would answer with the first element's
      // identity, and both sessions would collapse into one.
      let kept: string | AgentSessionRequest | undefined;
      let keeping = false;
      yield* Agent.around({
        *session([routed], next) {
          if (!keeping) {
            keeping = true;
            kept = routed;
            return yield* next(routed);
          }
          return yield* next(kept);
        },
      });

      // `<Session>` names durable work after its own invocation, so the host
      // declares it to the execution rather than registering it.
      const execution = yield* executeInstalled({ path: docPath, stream: new InMemoryStream() }, [
        { components: agentIdentityComponents() },
      ]);
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      const outcome = yield* execution;
      if (!outcome.ok) {
        refusal = outcome.error.message;
      }
    });

    // Refused before the provider placed anything for the second element: the
    // issuance the first one opened closed when it finished placing.
    expect(refusal).toContain("already placed its session");
    expect(placements).toHaveLength(1);
  });
});
