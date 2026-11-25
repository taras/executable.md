import { readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { Agent } from "@executablemd/agent/api";
import { agentSessionKeyDigest } from "@executablemd/runtime";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, sleep, spawn } from "effection";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import { join, basename } from "node:path";
import process from "node:process";
import { createAcpRuntime, createAgentRegistry, resolveAgentCommand } from "../src/acpx-runtime.ts";
import {
  createEmbeddedAdapters,
  embeddedAdapterIdentities,
  overlaidAdapterRegistry,
} from "../src/adapter-snapshots.ts";
import { useAcpxProvider } from "../src/provider.ts";
import { deriveSessionKey } from "../src/session-key.ts";
import {
  createDenoSessionRouteStore,
  createMemorySessionRouteStore,
} from "../src/session-route.ts";
import { createAcpxSessionStore } from "../src/session-store.ts";
import { withCertificationFixture } from "./certification-fixture.ts";
import { makeCoordinator, useFlatWorld } from "./helpers.ts";
import * as attachment from "./fixtures/claude-native-to-acp-proof.ts";
import * as claude from "./fixtures/claude-native-launch-proof.ts";
import * as codex from "./fixtures/codex-native-launch-proof.ts";
import {
  claudeKeyPaths,
  claudeRouteKey,
  nativeUiInvocations,
  prepareAbsentRoute,
  submittedModelTurns,
} from "./fixtures/claude-proof-evidence.ts";
import { runChild } from "./fixtures/native-proof-child.ts";
import type { ChildOutcome } from "./fixtures/native-proof-child.ts";

describe("native proof evidence", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("P1: the carried key addresses the refused load and its persisted prompt-attempt evidence", function* () {
    yield* withCertificationFixture(function* (peer) {
      const root = join(peer.dir, "coordination");
      const adapters = createEmbeddedAdapters(join(peer.dir, "adapters"));
      const agent = resolveAgentCommand(overlaidAdapterRegistry(adapters), "claude");
      const sessionKey = deriveSessionKey(agent, peer.dir, "implementer");
      const key = { provider: "acpx", agent, sessionKey };
      expect(claudeRouteKey(adapters, peer.dir)).toEqual(key);
      expect(
        deriveSessionKey(
          resolveAgentCommand(createAgentRegistry(), "claude"),
          peer.dir,
          "implementer",
        ),
      ).not.toBe(sessionKey);
      const durable = createDenoSessionRouteStore(root);
      const routeStore = durable ?? createMemorySessionRouteStore();
      const route = yield* prepareAbsentRoute(routeStore, key, randomUUID());
      const registry = overlaidAdapterRegistry(adapters);
      expect(yield* routeStore.read(key)).toEqual(route);
      const paths = claudeKeyPaths(root, agent, sessionKey);
      expect(paths.map((path) => basename(path).split(".")[0])).toEqual(
        Array(3).fill(agentSessionKeyDigest(key)),
      );
      const store = createAcpxSessionStore(peer.home);
      const owner = makeCoordinator();
      yield* useFlatWorld(peer.dir);
      yield* Agent.around(
        {
          *agent([name]) {
            return name ?? "claude";
          },
        },
        { at: "min" },
      );
      const run = function* () {
        yield* scoped(function* () {
          const provider = yield* useAcpxProvider(
            { defaultAgent: "claude", permissionMode: "deny-all" },
            {
              sessionStore: store,
              agentRegistry: registry,
              coordinator: owner.coordinator,
              routeStore,
              advertiseNativeLaunch: ["claude"],
              advertiseClientNativeAttachment: ["claude"],
              createRuntime(options) {
                return createAcpRuntime({
                  ...options,
                  agentRegistry: { resolve: () => peer.command("normal"), list: () => ["claude"] },
                });
              },
            },
          );
          const session = yield* provider.session("implementer");
          const sub = yield* provider.promptStream("recall", { session });
          let next = yield* sub.next();
          while (!next.done) {
            next = yield* sub.next();
          }
        });
      };
      let caught: unknown;
      try {
        yield* run();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ failure: { class: "identity-unavailable" } });
      const methods = (yield* peer.calls()).filter((call) => call.method.startsWith("session/"));
      expect(methods.map((call) => [call.method, call.sessionId])).toEqual([
        ["session/load", route.nativeSessionId],
      ]);
      expect(owner.events.at(-1)).toBe("released-idle");
      expect(yield* submittedModelTurns(peer.home, sessionKey)).toBe(0);
      // Supply history to this synthetic peer only. The exact load now succeeds
      // and the same counter must observe the prompt the subprocess received.
      yield* writeTextFile(
        join(peer.dir, "fixture-" + route.nativeSessionId + ".json"),
        JSON.stringify({ marker: "synthetic" }),
      );
      yield* run();
      expect((yield* peer.methods()).filter((m) => m === "session/prompt")).toHaveLength(1);
      expect(yield* submittedModelTurns(peer.home, sessionKey)).toBe(1);
      for (const path of paths) {
        yield* rm(path, { force: true });
      }
      if (durable) {
        expect(yield* durable.read(key)).toBe(undefined);
      }
    });
  });

  it("P2: both Claude shims distinguish native UI argv from availability and ACP", function* () {
    const create = ["--session-id", "identity", "--system-prompt-file", "/private/file"];
    const resume = ["--resume", "identity"];
    const unexpected = ["--session-id", "different"];
    const nonUi = [
      ["--version"],
      ["--help"],
      ["auth", "status"],
      ["project", "purge", "--dry-run", "project"],
      ["--print", "--input-format", "stream-json", "--resume", "unrelated"],
      ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"],
      ["--resume", "absent", "--print"],
      ["--session-id", "absent", "--system-prompt-file", "/absent", "--print"],
    ];
    const commands = [create, ...nonUi, unexpected, [], ["--resume", "--print"], resume];
    const trace = commands
      .map((args) => ["invocation", ...args.map((arg) => "arg " + arg)].join("\n"))
      .join("\n");
    for (const fixture of [claude, attachment]) {
      const all = fixture.parseObservations(trace);
      expect(all).toHaveLength(commands.length);
      expect(nativeUiInvocations(all).map(fixture.filtered)).toEqual([
        ["claude", "--session-id", "identity", "--system-prompt-file", "<private-file>"],
        ["claude", "--session-id", "different"],
        ["claude"],
        ["claude", "--resume", "--print"],
        ["claude", "--resume", "identity"],
      ]);
    }
    const observed = attachment.parseObservations(trace);
    const extra = attachment.blankJourney("native-to-acp");
    attachment.recordNativeInvocations(observed.slice(0, 2 + nonUi.length), extra);
    expect(extra.identityAllocations).toBe(2);
    expect(extra.substitutedIdentity).toBe(true);
    expect(extra.freshFallback).toBe(true);
    const zero = claude.blankJourney("zero-turn");
    zero.nativeSessionId = "identity";
    zero.secondInvocationChildren = 1;
    zero.secondCommand = ["claude", "--resume", "identity"];
    zero.outcome = "same-identity";
    claude.decideZeroTurn(zero);
    expect(zero.verdict).toBe("PASS");
    zero.outcome = "unresolved";
    zero.secondInvocationChildren = 0;
    zero.secondCommand = [];
    zero.journal.failureClasses = ["identity-unavailable"];
    claude.decideZeroTurn(zero);
    expect([zero.outcome, zero.verdict]).toEqual(["no-session", "PASS"]);
    const established = claude.blankJourney("two-turn");
    established.openingSentenceExact = true;
    claude.decideTwoTurn(established);
    expect(established.verdict).toBe("PRODUCT_FAILED");
    const acp = attachment.blankJourney("native-to-acp");
    acp.markerStored = true;
    attachment.decideAttachment(acp);
    expect(acp.verdict).toBe("PRODUCT_FAILED");
    const snapshot = embeddedAdapterIdentities().find((item) => item.provider === "codex");
    expect(snapshot).toMatchObject({
      package: "@agentclientprotocol/codex-acp",
      version: "1.8.0",
      sha256: "64f0b7be79e0d9d5c74c933967e9ef4e96b50e5a2857767e19bf2267cb5384f1",
    });
    for (const doc of ["CodexNativeLaunch", "CodexZeroNativeTurnExit"]) {
      const content = yield* readTextFile(new URL("../src/" + doc + ".test.md", import.meta.url));
      expect(content).toContain('expected={"' + snapshot?.sha256 + '"}');
    }
    const carried = createEmbeddedAdapters("/test/adapter-root").identity("claude");
    expect(
      yield* readTextFile(new URL("../src/ClaudeNativeToAcp.test.md", import.meta.url)),
    ).toContain('expected={"' + carried + '"}');
  });

  it("P3: ready and preflight continue after optional version and digest failures", function* () {
    const binary = process.execPath;
    const live = new Set<number>();
    let missing = false;
    let unfamiliar = false;
    const child: typeof runChild = function* (command, args): Operation<ChildOutcome> {
      const outcome = { code: 0, signal: null, stdout: "", stderr: "" };
      if (args[0] === "--version") {
        if (!unfamiliar) {
          throw new Error("controlled version timeout");
        }
        return { ...outcome, stdout: "unfamiliar release banner" };
      }
      if (command === "/usr/bin/which") {
        return { ...outcome, code: missing ? 1 : 0, stdout: missing ? "" : binary };
      }
      if (args.includes("--system-prompt-file")) {
        return { ...outcome, stderr: "System prompt file not found" };
      }
      if (args[0] === "auth") {
        return { ...outcome, stdout: '{"loggedIn":true}' };
      }
      if (command === "/usr/bin/script") {
        return { ...outcome, stdout: "PTY" };
      }
      if (args.includes("--help")) {
        return { ...outcome, stdout: "--dry-run --force SESSION_ID" };
      }
      if (args[0] === "delete") {
        return { ...outcome, code: 1, stderr: "failed to delete session" };
      }
      return outcome;
    };
    const digest = function* (): Operation<string> {
      throw new Error("controlled unreadable bytes");
    };
    const a = claude.blankJourney("two-turn"),
      b = codex.blankJourney("native-launch");
    a.projectCopyVerified = b.projectCopyVerified = true;
    const claudeJourney = { root: ".", live, realClaude: binary },
      codexJourney = { root: ".", live, codex: "" };
    expect(yield* claude.ready(claudeJourney, a, child)).toBe(true);
    expect(yield* codex.ready(codexJourney, b, child, digest)).toBe(true);
    expect([a.claudeVersion, b.codexVersion, b.codexDigest, b.compatibilityTupleFrozen]).toEqual([
      "",
      "",
      "",
      true,
    ]);
    unfamiliar = true;
    expect(yield* claude.ready(claudeJourney, a, child)).toBe(true);
    expect(yield* codex.ready(codexJourney, b, child, digest)).toBe(true);
    expect([a.claudeVersion, b.codexVersion]).toEqual(["", ""]);
    unfamiliar = false;
    const claudeFlight = yield* claude.runPreflight(child, true, binary);
    const codexFlight = yield* codex.runPreflight(
      child,
      digest,
      function* (_path, _live, verdict) {
        verdict.adapterNamesNativeIdentity = verdict.unmaterializedIdentityRefused = true;
      },
      true,
      binary,
    );
    expect([
      claudeFlight.sessionIdFlag,
      claudeFlight.ptyUsable,
      codexFlight.resumeSurface,
      codexFlight.deleteSurface,
    ]).toEqual([true, true, true, true]);
    expect([claudeFlight.claudeVersion, codexFlight.codexVersion, codexFlight.codexDigest]).toEqual(
      ["", "", ""],
    );
    expect(claudeFlight.verdict).toBe(
      claudeFlight.claudeConfigDirSet ? "ENVIRONMENT_BLOCKED" : "PASS",
    );
    expect(codexFlight.verdict).toBe(codexFlight.codexHomeSet ? "ENVIRONMENT_BLOCKED" : "PASS");
    expect(yield* claude.ready({ ...claudeJourney, realClaude: "" }, a, child)).toBe(false);
    missing = true;
    expect(yield* codex.ready(codexJourney, b, child, digest)).toBe(false);
    expect([a.verdict, b.verdict]).toEqual(["ENVIRONMENT_BLOCKED", "ENVIRONMENT_BLOCKED"]);
  });

  it("P3: halting optional observation joins its child before releasing the caller", function* () {
    const live = new Set<number>();
    const verdict = claude.blankJourney("zero-turn");
    verdict.projectCopyVerified = true;
    let advanced = false;
    const work = yield* spawn(function* () {
      yield* claude.ready(
        { root: ".", realClaude: "controlled", live },
        verdict,
        (_cmd, _args, options) => runChild("/bin/sleep", ["30"], options),
      );
      advanced = true;
    });
    while (!live.size) {
      yield* sleep(1);
    }
    const [pid] = live;
    yield* work.halt();
    expect(advanced).toBe(false);
    expect(live.size).toBe(0);
    expect(() => process.kill(pid!, 0)).toThrow();
  });
});
